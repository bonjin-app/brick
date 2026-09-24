import { sql } from "drizzle-orm";
import { changeOrderStatus, type PointsPort } from "./orders.js";
import type { Db, ShopSettings } from "./types.js";

/**
 * 결제하지 않은 주문을 취소해 재고를 돌려놓는다.
 *
 * 주문은 만들 때 재고를 잡는다(초과판매를 막는 원자적 차감 — orders.ts). 그런데 결제창을
 * 그냥 닫거나, 결제창에서 "취소" 를 눌러 돌아오거나, 무통장입금을 끝내 하지 않은 주문은
 * 결제대기로 남아 **그 재고를 영원히 붙잡았다.** 되돌리는 길은 운영자가 하나씩 취소하는
 * 것뿐이었다. 한정 수량 상품이면 사지 않은 한 사람 때문에 다른 손님에게 품절로 보인다.
 *
 * 무엇을 건드리지 않는가:
 *  - **결제가 진행 중인 주문** — 결제 시도 기록이 방금 생겼다(PG 승인을 기다리는 중).
 *    여기서 취소하면 그 뒤 승인된 돈이 갈 곳이 없다(정기결제에서 실제로 났던 사고).
 *  - **개인결제 주문** — 재고가 없고, 청구서가 자기 유효 기간을 갖는다. 게다가 청구서는
 *    만들어 둔 주문을 재사용하므로, 취소하면 그 청구서로는 **영원히 결제할 수 없다.**
 *  - **옮겨 온 주문** — 영카트의 몇 년 전 미입금 주문이 결제대기로 들어와 있다. 취소하면
 *    차감한 적 없는 재고를 되돌리고(재고가 부푼다) 옛 손님에게 취소 메일이 한꺼번에 간다.
 *  - **그 사이 결제된 주문** — 고른 뒤 취소하기까지의 틈에 결제가 끝날 수 있다.
 *    `onlyFrom: ["pending"]` 이 잠근 뒤 다시 본다(결제완료→취소는 허용된 전이라서
 *    조건 없이 부르면 결제된 주문을 환불 없이 취소한다).
 */
export async function cancelUnpaidOrders(
  db: Db,
  settings: Pick<ShopSettings, "unpaidCancelMinutes" | "depositDays">,
  pointsPort: PointsPort | null,
): Promise<{ cancelled: number; orderNos: string[] }> {
  const minutes = Math.max(0, Math.floor(Number(settings.unpaidCancelMinutes ?? 0)));
  const days = Math.max(0, Math.floor(Number(settings.depositDays ?? 0)));
  // 두 규칙이 모두 꺼져 있어도 가상계좌 기한 경과는 본다 — 그 기한은 운영자가 아니라 PG 가 정했다

  /*
   * 가상계좌로 입금을 기다리는 주문 — 결제 미완료 시간(분) 규칙을 쓰지 않는다. 계좌에는 PG 가 정한
   * 입금 기한이 있고, 그 전에 취소하면 손님이 입금한 돈이 갈 곳이 없다. 기한이 지나면 취소한다.
   */
  const { rows } = await db.execute(sql`
    SELECT o.id, o.order_no, o.payment_method,
           EXISTS (SELECT 1 FROM shop_payments w WHERE w.order_id = o.id AND w.status = 'waiting') AS va
    FROM shop_orders o
    WHERE o.status = 'pending'
      AND o.payment_status <> 'paid'
      AND o.is_direct_payment IS NOT TRUE
      AND o.imported_from IS NULL
      AND (
        (o.payment_method = 'bank_transfer' AND ${days} > 0
          AND o.created_at < now() - make_interval(days => ${days}))
        OR (o.payment_method <> 'bank_transfer' AND ${minutes} > 0
          AND o.created_at < now() - make_interval(mins => ${minutes})
          AND NOT EXISTS (SELECT 1 FROM shop_payments w WHERE w.order_id = o.id AND w.status = 'waiting'))
        -- 입금 기한이 지난 가상계좌 (기한을 모르면 발급 후 7일)
        OR EXISTS (
          SELECT 1 FROM shop_payments w WHERE w.order_id = o.id AND w.status = 'waiting'
            AND coalesce(w.va_expires_at, w.created_at + interval '7 days') < now()
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM shop_payments p
        WHERE p.order_id = o.id AND p.status = 'requested'
          AND p.created_at > now() - interval '15 minutes'
      )
    ORDER BY o.created_at
    LIMIT 100
  `);

  const orderNos: string[] = [];
  for (const r of rows) {
    const bank = r.payment_method === "bank_transfer";
    // 이력 note 는 저장되는 데이터다 — 번역하지 않는다 (payments.ts 의 같은 주석 참고)
    const changed = await changeOrderStatus(db, String(r.id), "cancelled", {
      note: r.va ? "가상계좌 입금 기한 경과 — 자동 취소"
        : bank ? `입금 기한(${days}일) 경과 — 자동 취소` : `결제 미완료(${minutes}분) — 자동 취소`,
      pointsPort,
      onlyFrom: ["pending"],
    });
    if (changed) {
      orderNos.push(String(r.order_no));
      // 기다리던 계좌는 끝났다 — 입금 대기로 남겨 두면 주문 조회가 닫힌 계좌를 계속 보여 준다
      if (r.va) await db.execute(sql`UPDATE shop_payments SET status = 'cancelled', updated_at = now() WHERE order_id = ${String(r.id)}::uuid AND status = 'waiting'`);
    }
  }
  return { cancelled: orderNos.length, orderNos };
}

/** 무통장입금 입금 기한 — 주문 접수 메일과 주문 조회가 같은 계산을 쓴다 */
export function depositDeadline(createdAt: Date | string, depositDays: number): Date | null {
  const days = Math.max(0, Math.floor(Number(depositDays ?? 0)));
  if (!days) return null;
  return new Date(new Date(createdAt).getTime() + days * 86400_000);
}
