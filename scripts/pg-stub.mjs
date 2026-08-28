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

    record({ kind: "unknown", method: req.method, path });
    send(res, 404, { code: "NOT_FOUND", message: `모르는 경로: ${path}` });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[pg-stub] listening on 127.0.0.1:${PORT} → ${OUT}`);
});
