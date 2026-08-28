#!/usr/bin/env node
/**
 * 테스트용 PG 스텁 (토스페이먼츠 API 모양).
 *
 * 왜 필요한가: **부분 환불 금액이 PG 에 정확히 전달되는지 검증할 방법이 없었다.**
 * 무통장 게이트웨이의 `cancel()` 은 인자를 무시하고 성공을 반환하므로, 스모크가
 * 전부 통과해도 "10,000원 반품에 22,000원을 환불 요청" 같은 버그를 잡지 못한다.
 * 돈이 걸린 경로는 실제로 무엇이 나가는지 봐야 한다.
 *
 * 받은 요청을 JSON Lines 로 적어 테스트가 읽는다.
 *
 * 구현하는 것:
 *   POST /v1/payments/confirm                  — 승인
 *   POST /v1/payments/:paymentKey/cancel       — 취소 (부분/전액)
 *   POST /v1/billing/authorizations/issue      — 빌링키 발급 (authKey 가 auth-ok* 일 때만)
 *   POST /v1/billing/:billingKey               — 빌링키 청구 (?fail=1 로 실패 유도)
 *
 * 일부러 넣은 동작:
 *   - **승인 금액을 그대로 믿지 않는다.** 요청의 amount 를 승인 금액으로
 *     돌려주되, `?approve=<금액>` 으로 다른 금액을 승인하게 만들 수 있다 —
 *     brick-shop 이 PG 응답 금액을 주문 금액과 대조하는지 검증하는 데 쓴다.
 *   - **누적 취소 금액이 승인 금액을 넘으면 거절한다** (실제 PG 와 같다).
 *   - 멱등키가 같은 요청은 **저장된 응답을 그대로 돌려준다.**
 *
 * 사용법:
 *   node scripts/pg-stub.mjs --port 42625 --out /tmp/pg.jsonl
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", 42625));
const OUT = arg("out", "/tmp/brick-pg.jsonl");

// 매 실행마다 비운다 — 이전 실행의 기록이 섞이면 검증이 거짓으로 통과한다
writeFileSync(OUT, "");

/** paymentKey → { approved, cancelled } */
const payments = new Map();
/** billingKey → customerKey (청구 때 짝이 맞는지 검사한다) */
const billingKeys = new Map();
/** 테스트 제어: 다음 n 건의 빌링 청구를 실패시킨다 (카드 한도 초과 흉내) */
let failNextCharges = 0;
/** 멱등키 → 응답 (같은 키로 다시 오면 그대로 돌려준다) */
const idempotent = new Map();

function record(entry) {
  appendFileSync(OUT, `${JSON.stringify(entry)}\n`);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    // 무한히 받지 않는다
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { __parseError: true, raw };
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    const idemKey = req.headers["idempotency-key"] ?? null;
    // 인증 헤더가 왔는지만 본다 (키 값은 기록하지 않는다 — 비밀이다)
    const hasAuth = typeof req.headers.authorization === "string"
      && req.headers.authorization.startsWith("Basic ");

    // ── 승인 ──
    if (req.method === "POST" && path === "/v1/payments/confirm") {
      const paymentKey = String(body.paymentKey ?? "");
      const requested = Number(body.amount ?? 0);
      // 테스트가 "PG 가 다른 금액을 승인한 상황"을 만들 수 있게 한다
      const override = url.searchParams.get("approve");
      const approved = override === null ? requested : Number(override);

      record({
        kind: "confirm",
        path,
        hasAuth,
        idemKey,
        orderId: String(body.orderId ?? ""),
        paymentKey,
        requestedAmount: requested,
        approvedAmount: approved,
      });

      if (idemKey && idempotent.has(idemKey)) {
        return send(res, 200, idempotent.get(idemKey));
      }

      payments.set(paymentKey, { approved, cancelled: 0 });
      const response = {
        paymentKey,
        orderId: body.orderId,
        status: "DONE",
        totalAmount: approved,
        balanceAmount: approved,
        method: "카드",
        approvedAt: "2026-01-01T00:00:00+09:00",
      };
      if (idemKey) idempotent.set(idemKey, response);
      return send(res, 200, response);
    }

    // ── 취소 ──
    const cancelMatch = /^\/v1\/payments\/([^/]+)\/cancel$/.exec(path);
    if (req.method === "POST" && cancelMatch) {
      const paymentKey = decodeURIComponent(cancelMatch[1]);
      // cancelAmount 가 없으면 전액 취소다 (토스 규약)
      const cancelAmount =
        body.cancelAmount === undefined || body.cancelAmount === null
          ? null
          : Number(body.cancelAmount);

      record({
        kind: "cancel",
        path,
        hasAuth,
        idemKey,
        paymentKey,
        // null 이면 전액 취소 요청이라는 뜻이다 — 이 구분이 검증의 핵심이다
        cancelAmount,
        cancelReason: String(body.cancelReason ?? ""),
      });

      if (idemKey && idempotent.has(idemKey)) {
        return send(res, 200, idempotent.get(idemKey));
      }

      const state = payments.get(paymentKey);
      if (!state) {
        return send(res, 404, { code: "NOT_FOUND_PAYMENT", message: "존재하지 않는 결제입니다." });
      }

      const remaining = state.approved - state.cancelled;
      const amount = cancelAmount === null ? remaining : cancelAmount;

      if (amount <= 0) {
        return send(res, 400, { code: "INVALID_REQUEST", message: "취소 금액이 올바르지 않습니다." });
      }
      // 실제 PG 와 같이 초과 취소를 거절한다 — 우리 쪽 계산이 틀리면 여기서 드러난다
      if (amount > remaining) {
        return send(res, 400, {
          code: "EXCEED_CANCEL_AMOUNT",
          message: `취소 가능 금액을 초과했습니다. (가능: ${remaining})`,
        });
      }

      state.cancelled += amount;
      const response = {
        paymentKey,
        status: state.cancelled >= state.approved ? "CANCELED" : "PARTIAL_CANCELED",
        totalAmount: state.approved,
        balanceAmount: state.approved - state.cancelled,
        cancels: [{ cancelAmount: amount, cancelReason: body.cancelReason ?? "" }],
      };
      if (idemKey) idempotent.set(idemKey, response);
      return send(res, 200, response);
    }

    // ── 테스트 제어 (실제 PG 에는 없다 — 스텁 전용) ──
    if (req.method === "POST" && path === "/__control") {
      failNextCharges = Math.max(0, Number(body.failNextCharges ?? 0));
      return send(res, 200, { ok: true, failNextCharges });
    }

    // ── 빌링키 발급 (정기결제) ──
    if (req.method === "POST" && path === "/v1/billing/authorizations/issue") {
      const authKey = String(body.authKey ?? "");
      const customerKey = String(body.customerKey ?? "");
      record({ kind: "billing-issue", path, hasAuth, idemKey, authKey, customerKey });

      if (idemKey && idempotent.has(idemKey)) {
        return send(res, 200, idempotent.get(idemKey));
      }
      // 실제 토스처럼 잘못된 authKey 는 거절한다 — 부정 케이스 검증용
      if (!authKey.startsWith("auth-ok")) {
        return send(res, 400, { code: "INVALID_AUTH_KEY", message: "유효하지 않은 인증입니다." });
      }
      const billingKey = `bk-${authKey}`;
      // 빌링키 → 고객키를 기억한다. 청구 때 짝이 맞는지 검사한다 (실제 PG 와 같다)
      billingKeys.set(billingKey, customerKey);
      const response = {
        billingKey,
        customerKey,
        card: { company: "테스트카드", number: "****1234" },
      };
      if (idemKey) idempotent.set(idemKey, response);
      return send(res, 200, response);
    }

    // ── 빌링키 청구 (정기결제) ──
    const billingMatch = /^\/v1\/billing\/([^/]+)$/.exec(path);
    if (req.method === "POST" && billingMatch && billingMatch[1] !== "authorizations") {
      const billingKey = decodeURIComponent(billingMatch[1]);
      const customerKey = String(body.customerKey ?? "");
      const amount = Number(body.amount ?? 0);
      // 테스트가 "카드 한도 초과" 같은 실패를 만들 수 있게 한다
      const failNext = url.searchParams.get("fail");

      record({
        kind: "billing-charge", path, hasAuth, idemKey,
        billingKey, customerKey, orderId: String(body.orderId ?? ""),
        orderName: String(body.orderName ?? ""), amount,
      });

      if (idemKey && idempotent.has(idemKey)) {
        return send(res, 200, idempotent.get(idemKey));
      }
      const knownCustomer = billingKeys.get(billingKey);
      if (!knownCustomer) {
        return send(res, 404, { code: "NOT_FOUND_BILLING_KEY", message: "등록되지 않은 빌링키입니다." });
      }
      if (knownCustomer !== customerKey) {
        return send(res, 400, { code: "INVALID_CUSTOMER_KEY", message: "고객 정보가 일치하지 않습니다." });
      }
      if (failNext || failNextCharges > 0) {
        if (failNextCharges > 0) failNextCharges -= 1;
        return send(res, 400, { code: "REJECT_CARD_PAYMENT", message: "한도 초과입니다." });
      }
      const paymentKey = `bp-${String(body.orderId ?? "")}`;
      payments.set(paymentKey, { approved: amount, cancelled: 0 });
      const response = {
        paymentKey,
        orderId: body.orderId,
        status: "DONE",
        totalAmount: amount,
        balanceAmount: amount,
        method: "카드",
        approvedAt: "2026-01-01T00:00:00+09:00",
      };
      if (idemKey) idempotent.set(idemKey, response);
      return send(res, 200, response);
    }

    record({ kind: "unknown", method: req.method, path });
    send(res, 404, { code: "NOT_FOUND", message: `모르는 경로: ${path}` });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[pg-stub] listening on 127.0.0.1:${PORT} → ${OUT}`);
});
