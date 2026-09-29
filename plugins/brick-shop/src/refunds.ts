import { sql } from "drizzle-orm";
import { STOCK_RESTORING } from "./types.js";

/**
 * "이 주문에서 돌려준 돈" — 매출 리포트 · 대시보드 · 부가세 신고 · 회원 등급 실적이 **이 정의 하나**를 쓴다.
 *
 * 따로 적었더니 넷이 같은 구멍을 가졌다: 각자 "결제 총액 − 반품 환불액" 이라 적어서, 운영자가 주문을 "환불"·"취소"
 * 로 바꾸거나 결제 화면에서 부분 환불한 돈(반품 기록이 없다)이 매출로 남았다. 100만 원을 돌려줘도 매출은 100만 원이었고
 * 부가세 자료에도 남아 세금을 더 냈다. 정의는 주문마다:
 *
 *   - 반품 환불액과 결제 기록의 환불 누적액 중 **큰 쪽** — 카드 반품은 두 곳에 같은 돈이 적혀 더하면 두 번 빠지고,
 *     무통장 반품은 결제 기록이 없어 반품 쪽에만 있다.
 *   - 통째로 취소·환불된 상태인데 어느 기록에도 환불이 없으면(상태만 바꾼 주문 — 옮겨 온 주문 등) **전액**을 돌려준 것으로 본다.
 *   - 주문 총액을 넘지 않는다.
 *   - 신청만 한 반품은 세지 않는다 — 물건을 받기 전에는 환불되지 않는다. `completed` 만.
 *
 * 붙이는 방식: `LEFT JOIN LATERAL` 이라 **바깥 쿼리가 고른 주문에 대해서만** 계산한다(반품·결제 기록은 주문 인덱스로
 * 찾는다). 전에는 전체 주문·전체 결제를 훑고 집계한 뒤 붙여서 비용이 기간이 아니라 전체 이력에 비례했다 —
 * 등급 재계산(전 회원)과 대시보드(기간 없음)가 특히 그랬다.
 *
 * 쓰는 법: 바깥 쿼리의 주문 별칭이 `o` 여야 하고, 붙은 뒤 `r.refunded` · `r.return_shipping` 을 읽는다.
 */

/** 주문이 통째로 돌아간 상태 — 재고 복원과 같은 목록이다 (types.ts STOCK_RESTORING). 주문 별칭은 `o` */
export const fullyReversedSql = sql`o.status IN (${sql.join(STOCK_RESTORING.map((s) => sql`${s}`), sql`, `)})`;

export const orderRefundsJoin = sql`
  LEFT JOIN LATERAL (
    SELECT least(o.total, CASE
             WHEN ${fullyReversedSql} AND x.by_return = 0 AND x.by_payment = 0 THEN o.total
             ELSE greatest(x.by_return, x.by_payment)
           END) AS refunded,
           x.return_shipping AS return_shipping
    FROM (SELECT
      coalesce((SELECT sum(refund_amount) FROM shop_returns
                WHERE order_id = o.id AND status = 'completed'), 0) AS by_return,
      coalesce((SELECT sum(return_shipping_fee) FROM shop_returns
                WHERE order_id = o.id AND status = 'completed'), 0) AS return_shipping,
      coalesce((SELECT sum(refunded_amount) FROM shop_payments
                WHERE order_id = o.id), 0) AS by_payment
    ) x
  ) r ON true
`;
