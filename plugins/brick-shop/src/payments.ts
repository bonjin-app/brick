import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";
import { changeOrderStatus, type PointsPort } from "./orders.js";
import { isUniqueViolation } from "@brick/plugin-sdk";

/**
 * 결제 게이트웨이 추상화.
 *
 * Brick은 특정 PG에 묶이지 않는다. PG별 구현은 별도 플러그인이 등록하고,
 * brick-shop은 이 인터페이스만 안다.
 */
export interface PaymentGateway {
  /** "toss", "inicis", "kcp" 등 */
  readonly provider: string;
  readonly displayName: string;
  /**
   * PG에 승인을 요청한다.
   * 반드시 PG가 실제로 받은 금액을 반환해야 한다 — brick-shop이 주문 금액과 대조한다.
   */
  confirm(params: {
    orderNo: string;
    /** PG가 발급한 거래 키 */
    providerTid: string;
    /** 클라이언트가 주장하는 금액 (검증용으로만 쓰고 신뢰하지 않는다) */
    claimedAmount: number;
  }): Promise<{
    ok: boolean;
    /** PG가 확인한 실제 승인 금액 */
    approvedAmount?: number;
    method?: string;
    raw?: unknown;
    failureReason?: string;
  }>;
  /** 취소/환불. amount를 주면 부분 환불 */
  cancel(params: { providerTid: string; amount?: number; reason: string }): Promise<{
    ok: boolean;
    raw?: unknown;
    failureReason?: string;
  }>;
}

/** 등록된 게이트웨이 (PG 플러그인이 registerGateway로 채운다) */
export const gateways = new Map<string, PaymentGateway>();

export function registerGateway(gateway: PaymentGateway): void {
  gateways.set(gateway.provider, gateway);
}

/**
 * 결제 승인 처리 — 커머스에서 가장 위험한 코드 경로.
 *
 * 방어하는 것:
 *  1. **금액 위조** — PG가 확인한 금액과 주문 총액이 정확히 일치해야 승인한다.
 *     일치하지 않으면 즉시 취소를 시도하고 실패로 기록한다.
 *     (클라이언트가 보낸 금액은 절대 신뢰하지 않는다)
 *  2. **중복 승인** — (provider, provider_tid) unique 로 DB가 막는다.
 *     같은 웹훅이 두 번 와도 재고·매출이 이중 계상되지 않는다.
 *  3. **경합** — 주문 행을 FOR UPDATE로 잠근 뒤 상태를 바꾼다.
 *  4. **이미 결제된 주문** — pending이 아니면 거부한다.
 */
export async function confirmPayment(
  db: Db,
  params: {
    orderNo: string;
    provider: string;
    providerTid: string;
    claimedAmount?: number;
    actorId?: string | null;
    pointsPort?: PointsPort | null;
    /** 결제 완료를 알린다 (포인트 적립 등이 구독한다) */
    onPaid?: (info: { orderNo: string; userId: string | null; amount: number }) => Promise<void>;
  },
): Promise<{ ok: boolean; orderNo: string; amount: number }> {
  const gateway = gateways.get(params.provider);
  if (!gateway) throw new ShopError(400, `등록되지 않은 결제수단입니다: ${params.provider}`);

  // ── 1. 주문 확인 (금액의 기준은 언제나 DB) ──────────
  const { rows: orderRows } = await db.execute(sql`
    SELECT id, order_no, status, total, payment_status, user_id
    FROM shop_orders WHERE order_no = ${params.orderNo} LIMIT 1
  `);
  const order = orderRows[0];
  if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");

  const orderTotal = Number(order.total);

  // 이미 결제된 주문에 다시 승인이 들어오면 멱등하게 성공 반환 (웹훅 재전송 대응)
  if (order.payment_status === "paid") {
    const { rows: existing } = await db.execute(sql`
      SELECT provider_tid FROM shop_payments
      WHERE order_id = ${String(order.id)}::uuid AND status = 'paid' LIMIT 1
    `);
    if (existing[0]?.provider_tid === params.providerTid) {
      return { ok: true, orderNo: params.orderNo, amount: orderTotal };
    }
    // 다른 거래로 같은 주문을 또 결제하려는 시도 — 즉시 취소해야 한다
    await gateway
      .cancel({ providerTid: params.providerTid, reason: "이미 결제 완료된 주문" })
      .catch(() => undefined);
    throw new ShopError(409, "이미 결제가 완료된 주문입니다.");
  }
  if (order.status !== "pending") {
    throw new ShopError(400, `결제할 수 없는 주문 상태입니다: ${order.status}`);
  }

  // ── 2. 결제 시도 기록 (중복은 unique 인덱스가 막는다) ──
  const paymentId = uuidv7();
  try {
    await db.execute(sql`
      INSERT INTO shop_payments (id, order_id, provider, provider_tid, status, amount)
      VALUES (${paymentId}, ${String(order.id)}::uuid, ${params.provider}, ${params.providerTid},
              'requested', ${orderTotal})
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_payments_tid_uniq")) {
      // 같은 PG 거래가 이미 처리 중이거나 처리되었다 — 재고 이중 차감을 막는다
      throw new ShopError(409, "이미 처리된 결제입니다.");
    }
    throw err;
  }

  // ── 3. PG 승인 ─────────────────────────────────────
  const result = await gateway.confirm({
    orderNo: params.orderNo,
    providerTid: params.providerTid,
    claimedAmount: params.claimedAmount ?? orderTotal,
  });

  if (!result.ok) {
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed', failure_reason = ${(result.failureReason ?? "승인 실패").slice(0, 500)},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    throw new ShopError(402, result.failureReason ?? "결제 승인에 실패했습니다.");
  }

  // ── 4. 금액 검증 — 위조 방어의 핵심 ─────────────────
  const approved = Number(result.approvedAmount);
  if (!Number.isFinite(approved) || approved !== orderTotal) {
    // 금액이 다르면 결제를 되돌린다. 이 상황은 공격이거나 심각한 버그다.
    await gateway
      .cancel({ providerTid: params.providerTid, reason: "주문 금액 불일치" })
      .catch(() => undefined);
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed',
        failure_reason = ${`금액 불일치: 주문 ${orderTotal}원 / 승인 ${approved}원`},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    throw new ShopError(400, "결제 금액이 주문 금액과 일치하지 않습니다. 결제를 취소했습니다.");
  }

  // ── 5. 승인 확정 ───────────────────────────────────
  await db.execute(sql`
    UPDATE shop_payments SET status = 'paid', method = ${result.method ?? null},
      raw = ${JSON.stringify(result.raw ?? null)}::jsonb, approved_at = now(), updated_at = now()
    WHERE id = ${paymentId}
  `);
  await db.execute(sql`
    UPDATE shop_orders SET payment_method = ${params.provider}, updated_at = now()
    WHERE id = ${String(order.id)}::uuid
  `);
  // 상태 머신을 통해 전이한다 (이력이 남고 규칙이 검증된다)
  await changeOrderStatus(db, String(order.id), "paid", {
    note: `${gateway.displayName} 결제 승인 (${approved.toLocaleString("ko-KR")}원)`,
    actorId: params.actorId ?? null,
    pointsPort: params.pointsPort ?? null,
  });

  // 결제 완료 통지 — 포인트 적립 등이 구독한다.
  // 실패해도 결제는 유효하므로 예외를 삼킨다 (적립은 나중에 보정할 수 있다).
  if (params.onPaid) {
    await params
      .onPaid({
        orderNo: params.orderNo,
        userId: order.user_id ? String(order.user_id) : null,
        amount: approved,
      })
      .catch(() => undefined);
  }

  return { ok: true, orderNo: params.orderNo, amount: approved };
}

/**
 * 환불.
 * 부분 환불을 지원하되 누적 환불액이 결제액을 넘지 못하게 한다 (DB CHECK + 코드 이중 방어).
 */
export async function refundPayment(
  db: Db,
  params: {
    orderNo: string;
    amount?: number;
    reason: string;
    actorId?: string | null;
    pointsPort?: PointsPort | null;
  },
): Promise<{ ok: boolean; refunded: number; remaining: number }> {
  const { rows } = await db.execute(sql`
    SELECT p.id, p.provider, p.provider_tid, p.amount, p.refunded_amount, o.id AS order_id, o.status
    FROM shop_payments p JOIN shop_orders o ON o.id = p.order_id
    WHERE o.order_no = ${params.orderNo} AND p.status IN ('paid', 'partial_refunded')
    ORDER BY p.created_at DESC LIMIT 1
  `);
  const payment = rows[0];
  if (!payment) throw new ShopError(404, "환불할 결제 내역이 없습니다.");

  const gateway = gateways.get(String(payment.provider));
  if (!gateway) throw new ShopError(400, `${payment.provider} 게이트웨이가 활성화되지 않았습니다.`);

  const paid = Number(payment.amount);
  const already = Number(payment.refunded_amount);
  const remaining = paid - already;
  const amount = params.amount === undefined ? remaining : Math.floor(Number(params.amount));

  if (!Number.isFinite(amount) || amount <= 0) throw new ShopError(400, "환불 금액이 올바르지 않습니다.");
  if (amount > remaining) {
    throw new ShopError(400, `환불 가능 금액을 초과했습니다. (가능: ${remaining.toLocaleString("ko-KR")}원)`);
  }

  const result = await gateway.cancel({
    providerTid: String(payment.provider_tid),
    ...(amount < remaining ? { amount } : {}),
    reason: params.reason,
  });
  if (!result.ok) throw new ShopError(402, result.failureReason ?? "환불 처리에 실패했습니다.");

  const totalRefunded = already + amount;
  const fullyRefunded = totalRefunded >= paid;
  await db.execute(sql`
    UPDATE shop_payments SET refunded_amount = ${totalRefunded},
      status = ${fullyRefunded ? "refunded" : "partial_refunded"}, updated_at = now()
    WHERE id = ${String(payment.id)}
  `);

  // 전액 환불이면 주문도 환불 상태로 전이 → 재고가 복원된다
  if (fullyRefunded) {
    await changeOrderStatus(db, String(payment.order_id), "refunded", {
      note: `전액 환불: ${params.reason}`,
      actorId: params.actorId ?? null,
      pointsPort: params.pointsPort ?? null,
    });
  } else {
    await db.execute(sql`
      INSERT INTO shop_order_events (id, order_id, from_status, to_status, note, actor_id)
      VALUES (${uuidv7()}, ${String(payment.order_id)}::uuid, ${String(payment.status)}, ${String(payment.status)},
              ${`부분 환불 ${amount.toLocaleString("ko-KR")}원: ${params.reason}`}, ${params.actorId ?? null}::uuid)
    `);
  }

  return { ok: true, refunded: totalRefunded, remaining: paid - totalRefunded };
}

/**
 * 무통장입금 게이트웨이 — 기본 내장.
 * 실제 입금 확인은 관리자가 수동으로 하므로 confirm은 관리자 승인 시점에 호출된다.
 */
export const bankTransferGateway: PaymentGateway = {
  provider: "bank_transfer",
  displayName: "무통장입금",
  async confirm({ claimedAmount }) {
    // 관리자가 입금을 확인하고 승인하는 흐름이므로 요청 금액을 그대로 승인한다.
    // (주문 금액과의 대조는 confirmPayment가 수행한다)
    return { ok: true, approvedAmount: claimedAmount, method: "무통장입금" };
  },
  async cancel() {
    // 계좌 환불은 사람이 처리한다. 기록만 남기고 성공으로 본다.
    return { ok: true };
  },
};
