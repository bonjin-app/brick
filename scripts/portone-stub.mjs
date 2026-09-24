#!/usr/bin/env node
/**
 * 포트원(PortOne) V2 API 스텁 — 결제 확인·취소·본인인증 조회를 실제 HTTP 로 검증하기 위한 것.
 *
 * 포트원은 결제가 브라우저(결제창)에서 끝나므로, 테스트는 "손님이 결제창에서 결제를 마쳤다" 를
 * 제어 경로로 흉내 낸다(POST /__control/payments). 그 뒤 서버가 GET /payments/{id} 로
 * 조회하는 것은 실제와 같다.
 *
 * 실제와 같게 하는 것:
 *   - 인증 헤더 `Authorization: PortOne <시크릿>` 이 없거나 다르면 401
 *   - 취소에 currentCancellableAmount 가 오면 **실제 잔액과 대조**하고 다르면 409
 *     (포트원이 이중 부분환불을 막는 장치 — 이것을 흉내 내지 않으면 그 보호를 검증할 수 없다)
 *   - 남은 금액보다 큰 취소는 거절
 *
 * 사용법: node scripts/portone-stub.mjs --port 42640 --out log.jsonl --secret <시크릿>
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg("port", "42640"));
const OUT = arg("out", "/dev/null");
const SECRET = arg("secret", "");
writeFileSync(OUT, "");

/** paymentId → 결제 */
const payments = new Map();
/** identityVerificationId → 본인인증 */
const identities = new Map();
let cancelSeq = 0;

const record = (entry) => appendFileSync(OUT, `${JSON.stringify(entry)}\n`);
const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* 본문 없음 */ }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    const auth = String(req.headers.authorization ?? "");
    // 시크릿 값 자체는 기록하지 않는다 — 맞았는지만
    const authOk = SECRET ? auth === `PortOne ${SECRET}` : auth.startsWith("PortOne ");

    // ── 테스트 제어: 손님이 결제창에서 결제를 마쳤다 ──
    if (req.method === "POST" && path === "/__control/payments") {
      const p = {
        id: String(body.paymentId),
        transactionId: `tx-${payments.size + 1}`,
        storeId: String(body.storeId ?? "store-test"),
        status: String(body.status ?? "PAID"),
        orderName: String(body.orderName ?? "시험 주문"),
        currency: "KRW",
        method: { type: "PaymentMethodCard" },
        amount: { total: Number(body.total), paid: Number(body.total), cancelled: 0 },
        paidAt: "2026-09-24T00:00:00Z",
      };
      payments.set(p.id, p);
      return send(res, 200, { ok: true });
    }
    // ── 테스트 제어: PG 쪽에서만 일어난 취소(우리가 모르는 잔액 변화) ──
    if (req.method === "POST" && path === "/__control/phantom-cancel") {
      const p = payments.get(String(body.paymentId));
      if (!p) return send(res, 404, {});
      p.amount.cancelled += Number(body.amount);
      return send(res, 200, { ok: true });
    }

    // ── 테스트 제어: 손님이 인증창에서 본인인증을 마쳤다(또는 실패했다) ──
    if (req.method === "POST" && path === "/__control/identity") {
      identities.set(String(body.id), {
        id: String(body.id),
        storeId: String(body.storeId ?? "store-test"),
        status: String(body.status ?? "VERIFIED"),
        verifiedCustomer: body.customer ?? undefined,
        requestedAt: "2026-09-24T00:00:00Z",
      });
      return send(res, 200, { ok: true });
    }
    const idMatch = /^\/identity-verifications\/([^/]+)$/.exec(path);
    if (req.method === "GET" && idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      record({ kind: "identity-get", id, authOk });
      if (!authOk) return send(res, 401, { type: "UNAUTHORIZED", message: "인증 정보가 올바르지 않습니다." });
      const v = identities.get(id);
      if (!v) return send(res, 404, { type: "IDENTITY_VERIFICATION_NOT_FOUND", message: "요청한 본인인증 정보를 찾을 수 없습니다." });
      return send(res, 200, v);
    }

    const getMatch = /^\/payments\/([^/]+)$/.exec(path);
    if (req.method === "GET" && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      record({ kind: "get", paymentId: id, authOk });
      if (!authOk) return send(res, 401, { type: "UNAUTHORIZED", message: "인증 정보가 올바르지 않습니다." });
      const p = payments.get(id);
      if (!p) return send(res, 404, { type: "PAYMENT_NOT_FOUND", message: "결제 건이 존재하지 않습니다." });
      return send(res, 200, p);
    }

    const cancelMatch = /^\/payments\/([^/]+)\/cancel$/.exec(path);
    if (req.method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      record({ kind: "cancel", paymentId: id, authOk, amount: body.amount ?? null,
               currentCancellableAmount: body.currentCancellableAmount ?? null, reason: body.reason ?? "" });
      if (!authOk) return send(res, 401, { type: "UNAUTHORIZED", message: "인증 정보가 올바르지 않습니다." });
      const p = payments.get(id);
      if (!p) return send(res, 404, { type: "PAYMENT_NOT_FOUND", message: "결제 건이 존재하지 않습니다." });
      const remaining = p.amount.total - p.amount.cancelled;
      if (body.currentCancellableAmount !== undefined && Number(body.currentCancellableAmount) !== remaining) {
        return send(res, 409, { type: "CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN",
          message: `취소 가능 잔액 검증에 실패했습니다. (요청 ${body.currentCancellableAmount} / 실제 ${remaining})` });
      }
      const amount = body.amount === undefined ? remaining : Number(body.amount);
      if (amount <= 0 || amount > remaining) {
        return send(res, 400, { type: "CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT", message: "취소 금액이 취소 가능 금액을 초과합니다." });
      }
      p.amount.cancelled += amount;
      p.status = p.amount.cancelled >= p.amount.total ? "CANCELLED" : "PARTIAL_CANCELLED";
      cancelSeq += 1;
      return send(res, 200, { cancellation: { id: `cancel-${cancelSeq}`, status: "SUCCEEDED", totalAmount: amount, cancelledAt: "2026-09-24T00:00:00Z" } });
    }

    record({ kind: "unknown", method: req.method, path });
    send(res, 404, { type: "NOT_FOUND", message: `모르는 경로: ${path}` });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[portone-stub] listening on 127.0.0.1:${PORT} → ${OUT}`);
});
