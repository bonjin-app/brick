import { sql } from "drizzle-orm";
import { onOrderTransition } from "./orders.js";
import { markRequestPaid } from "./direct-payment.js";
import { cancelReceiptsForOrder } from "./tax.js";
import { STOCK_RESTORING, type Db, type OrderStatus } from "./types.js";

/**
 * 주문 상태가 바뀔 때 따라 나가야 하는 일들 — 한 자리에 모았다.
 *
 * `changeOrderStatus` 는 여러 곳에서 불린다(PG 확정 · 관리 화면 · 일괄 처리 · 반품 · 정기결제 · 미결제 자동 취소).
 * 호출부마다 붙이면 언젠가 한 곳이 빠지고 그 경로만 조용해진다 — 그래서 전이가 커밋된 뒤 **한 번** 불리는 리스너
 * 하나에서 처리한다. 전에는 이 일들이 3,400줄 플러그인 본체 안의 클로저라 본체 없이는 시험할 수 없었고,
 * 리스너 자리(orders.ts 의 단일 슬롯)를 다른 등록자가 덮어써도 알 길이 없었다.
 *
 *   모든 전이       → 주문 안내(메일·알림함·문자)
 *   결제완료(paid)  → 결제 완료 알림: 개인결제 청구서 표시 · `shop.order.paid` (구매 적립이 구독한다)
 *   취소·환불       → 발급된 현금영수증 취소
 */
export interface OrderLifecycleDeps {
  db: Db;
  /** 구독자가 하나라도 실패하면 던진다 — 알림이 끝난 것으로 기록되지 않아야 재처리된다 */
  hooks: { doActionOrThrow<T>(hook: string, payload: T): Promise<void> };
  logger: { warn(message: string): void };
  /** 주문 안내 — 스스로 실패를 삼키고 기록한다 */
  notifyOrder(orderId: string, status: OrderStatus): Promise<void>;
}

/**
 * 결제 완료 — **어느 길로 결제됐든** 여기서 한 번 알린다.
 *
 * 전에는 PG 결제 확정만 알려, 운영자가 주문 화면에서 상태를 "결제완료" 로 바꾸는 흔한 무통장 입금 확인에는
 * 구매 적립이 붙지 않았다(정기결제의 회차 결제도). 적립은 주문번호로 한 번만 쌓인다.
 *
 * **주문 행을 잠근 채** 알린다. 잠그지 않으면 결제완료 직후 곧바로 취소·환불이 들어왔을 때, 취소의 적립 회수가
 * 적립보다 먼저 돌아 아무것도 못 거두고, 뒤늦게 적립이 붙어 취소된 주문이 적립을 가져갔다. 잠그면 둘이 줄을 선다:
 * 취소가 먼저면 여기서 상태를 보고 멈추고, 이쪽이 먼저면 취소의 회수가 이 적립을 본다. 잠금 동안 구독자
 * (포인트 적립)는 다른 연결로 원장에만 쓰므로 서로 기다리지 않는다 — 구독자가 이 주문을 고치면 안 된다.
 */
export async function announcePaid(deps: OrderLifecycleDeps, orderId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      SELECT order_no, user_id, total, status FROM shop_orders WHERE id = ${orderId}::uuid FOR UPDATE
    `);
    const o = rows[0];
    if (!o) return;
    if (STOCK_RESTORING.includes(String(o.status) as OrderStatus)) {
      // 그 사이 취소·환불됐다 — 알릴 것이 없으니 끝난 것으로 적어 재처리 대상에서 뺀다
      await tx.execute(sql`UPDATE shop_orders SET paid_announced_at = now() WHERE id = ${orderId}::uuid`);
      return;
    }
    // 개인결제 청구서였으면 결제완료로 표시한다
    await markRequestPaid(tx, String(o.order_no));
    await deps.hooks.doActionOrThrow("shop.order.paid", {
      orderNo: String(o.order_no),
      userId: o.user_id ? String(o.user_id) : null,
      amount: Number(o.total),
    });
    // 구독자가 모두 끝낸 뒤에만 적는다 — 여기 오기 전에 죽거나 던지면 비어 있어 sweep 이 다시 알린다
    await tx.execute(sql`UPDATE shop_orders SET paid_announced_at = now() WHERE id = ${orderId}::uuid`);
  });
}

export const PAID_SWEEP_QUEUE_JOB = "shop.order.paid-sweep";

/** 결제완료 알림을 재처리하는 대상 — 이 안에 결제된 주문만(영구히 실패하는 구독자가 있어도 끝없이 돌지 않는다) */
export const PAID_SWEEP_WINDOW_DAYS = 3;
/** 방금 결제된 주문은 원래 경로가 아직 돌고 있을 수 있다 — 그만큼 기다린 뒤에 본다 */
export const PAID_SWEEP_GRACE_MINUTES = 5;

/**
 * 결제완료인데 알림이 끝나지 않은 주문을 다시 알린다. 서버가 멈췄거나 구독자가 실패해 빠진 적립을 메운다.
 * 주문마다 `announcePaid` 가 행을 잠그고 상태를 다시 보므로, 원래 경로와 겹쳐도 한쪽이 기다렸다 이어받는다.
 */
export async function sweepUnannouncedPaid(deps: OrderLifecycleDeps): Promise<{ found: number; done: number; failed: number }> {
  const { rows } = await deps.db.execute(sql`
    SELECT id FROM shop_orders
     WHERE paid_at IS NOT NULL AND paid_announced_at IS NULL
       AND paid_at < now() - (${PAID_SWEEP_GRACE_MINUTES} || ' minutes')::interval
       AND paid_at > now() - (${PAID_SWEEP_WINDOW_DAYS} || ' days')::interval
     ORDER BY paid_at LIMIT 100
  `);
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await announcePaid(deps, String(r.id));
      done++;
    } catch (err) {
      failed++;
      deps.logger.warn(`결제 완료 알림 재처리 실패 (${String(r.id)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { found: rows.length, done, failed };
}

/**
 * 주문이 통째로 취소·환불되면 발급된 현금영수증을 취소한다 — 돌려준 돈의 증빙이 살아 있으면 세금을 더 낸다.
 * 반품으로 전량이 돌아와 여기로 오는 경우는 반품이 먼저 취소했으므로 할 일이 없다(대기·발급 상태만 고른다).
 * 취소 실패는 영수증 행에 남는다(운영자가 홈택스에서 직접 취소한다) — 상태 전이를 되돌리지 않는다.
 */
export async function cancelReceiptsOnReversal(deps: OrderLifecycleDeps, orderId: string, to: OrderStatus): Promise<void> {
  await cancelReceiptsForOrder(deps.db, { orderId, reason: to === "cancelled" ? "주문 취소" : "주문 환불" });
}

/** 플러그인 초기화에서 한 번 등록한다 */
export function registerOrderLifecycle(deps: OrderLifecycleDeps): void {
  const failed = (what: string, orderId: string) => (err: unknown) =>
    deps.logger.warn(`${what} 실패 (${orderId}): ${err instanceof Error ? err.message : String(err)}`);

  onOrderTransition(({ orderId, to }) => {
    void deps.notifyOrder(orderId, to);
    if (to === "paid") void announcePaid(deps, orderId).catch(failed("결제 완료 알림", orderId));
    if (STOCK_RESTORING.includes(to)) void cancelReceiptsOnReversal(deps, orderId, to).catch(failed("현금영수증 취소", orderId));
  });
}
