import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db, OrderStatus, ShopSettings } from "./types.js";
import { ShopError, STATUS_TRANSITIONS, STOCK_RESTORING } from "./types.js";
import { quote, type Quote } from "./pricing.js";

/**
 * 포인트 서비스의 최소 계약 — brick-point가 공개하는 것 중 쇼핑몰이 쓰는 부분만.
 * 인터페이스를 여기서 좁게 선언하면 brick-point에 대한 컴파일 의존이 생기지 않는다.
 */
export interface PointsPort {
  balance(userId: string, tx?: Db): Promise<number>;
  spend(
    params: { userId: string; amount: number; reason: string; refType?: string; refId?: string },
    tx?: Db,
  ): Promise<boolean>;
  refund(
    params: { userId: string; refType: string; refId: string; reason: string },
    tx?: Db,
  ): Promise<number>;
}

export interface OrdererInput {
  ordererName: string;
  ordererPhone: string;
  ordererEmail?: string;
  receiverName?: string;
  receiverPhone?: string;
  postcode: string;
  address1: string;
  address2?: string;
  deliveryMemo?: string;
  paymentMethod?: string;
}

const PAYMENT_METHODS = ["bank_transfer"]; // PG 연동은 별도 플러그인이 추가한다

/**
 * 주문 생성.
 *
 * 재고 동시성이 이 함수의 핵심이다.
 * 조회 후 차감(check-then-act)은 동시 주문에서 초과판매를 일으킨다.
 * 그래서 **조건부 원자적 UPDATE**로 차감하고, 영향받은 행이 0이면 실패시킨다:
 *
 *   UPDATE ... SET stock = stock - qty WHERE id = ? AND stock >= qty
 *
 * 전체를 하나의 트랜잭션으로 감싸 실패 시 부분 차감이 남지 않게 한다.
 */
export async function createOrder(
  db: Db,
  params: {
    items: Array<{ productId: string; optionId?: string | null; quantity: number }>;
    orderer: OrdererInput;
    couponCode?: string | null;
    userId?: string | null;
    guestToken?: string | null;
    settings: ShopSettings;
    /** 클라이언트 재시도로 중복 주문이 생기는 것을 막는 키 (선택) */
    idempotencyKey?: string | null;
    /** 사용 요청 포인트. 회원만 가능 */
    pointUsed?: number;
    /** 포인트 서비스 (brick-point 미설치 시 null) */
    pointsPort?: PointsPort | null;
  },
): Promise<{ id: string; orderNo: string; total: number; guestToken: string | null }> {
  const { orderer } = params;
  validateOrderer(orderer);

  // 멱등성: 같은 키로 이미 주문이 만들어졌다면 새로 만들지 않고 기존 주문을 돌려준다.
  // (결제 직전 네트워크 재시도로 주문이 두 번 생기면 재고가 이중 차감된다)
  const idemKey = params.idempotencyKey?.trim() || null;
  if (idemKey) {
    if (idemKey.length > 100) throw new ShopError(400, "idempotencyKey가 너무 깁니다.");
    const { rows } = await db.execute(sql`
      SELECT id, order_no, total, guest_token FROM shop_orders WHERE idempotency_key = ${idemKey} LIMIT 1
    `);
    if (rows[0]) {
      return {
        id: String(rows[0].id),
        orderNo: String(rows[0].order_no),
        total: Number(rows[0].total),
        guestToken: rows[0].guest_token ? String(rows[0].guest_token) : null,
      };
    }
  }

  const method = orderer.paymentMethod ?? "bank_transfer";
  if (!PAYMENT_METHODS.includes(method)) {
    throw new ShopError(400, `지원하지 않는 결제수단입니다: ${method}`);
  }

  // 포인트는 회원만 쓸 수 있고, 실제 잔액을 넘을 수 없다.
  // 잔액 검증은 여기서 한 번, 차감 시점(트랜잭션 안)에서 다시 한다 —
  // 그 사이에 잔액이 줄었을 수 있으므로 최종 판정은 차감이 한다.
  let requestedPoint = Math.max(0, Math.floor(Number(params.pointUsed ?? 0)));
  if (requestedPoint > 0) {
    if (!params.userId) throw new ShopError(400, "포인트는 로그인 후 사용할 수 있습니다.");
    if (!params.pointsPort) throw new ShopError(400, "포인트 기능이 활성화되지 않았습니다.");
    const balance = await params.pointsPort.balance(params.userId);
    if (balance < requestedPoint) {
      throw new ShopError(400, `보유 포인트가 부족합니다. (보유: ${balance.toLocaleString("ko-KR")})`);
    }
  }

  // 서버 가격으로 재계산 (클라이언트 금액을 신뢰하지 않는다)
  const q: Quote = await quote(db, params.items, params.settings, params.couponCode, {
    pointUsed: requestedPoint,
  });
  // pricing이 상한을 적용했을 수 있다 (상품금액 초과분은 쓰지 않는다)
  requestedPoint = q.pointUsed;

  const orderId = uuidv7();
  const guestToken = params.userId ? null : (params.guestToken ?? uuidv7().replace(/-/g, ""));

  // 트랜잭션: 재고 차감 → 쿠폰 사용 → 주문 생성이 전부 성공하거나 전부 취소된다.
  // (execute("BEGIN")은 풀에서 커넥션이 바뀔 수 있어 트랜잭션이 성립하지 않는다)
  const orderNo = await db.transaction(async (tx) => {
    const orderNo = await nextOrderNo(tx);

    // ── 1. 재고 차감 (원자적) ──────────────────────────
    for (const line of q.lines) {
      if (line.stock === null) continue; // 무한 재고

      const target = line.optionId
        ? sql`UPDATE shop_product_options SET stock = stock - ${line.quantity}
              WHERE id = ${line.optionId}::uuid AND stock IS NOT NULL AND stock >= ${line.quantity}
              RETURNING id`
        : sql`UPDATE shop_products SET stock = stock - ${line.quantity}
              WHERE id = ${line.productId}::uuid AND stock IS NOT NULL AND stock >= ${line.quantity}
              RETURNING id`;

      const { rows } = await tx.execute(target);
      if (!rows.length) {
        // 다른 주문이 먼저 재고를 가져갔다
        throw new ShopError(409, `"${line.productName}" 재고가 부족합니다. 장바구니를 다시 확인해주세요.`);
      }
    }

    // ── 2. 쿠폰 사용 횟수 (한도가 있으면 원자적으로) ──
    if (q.couponCode) {
      const { rows } = await tx.execute(sql`
        UPDATE shop_coupons SET used_count = used_count + 1
        WHERE upper(code) = ${q.couponCode.toUpperCase()}
          AND is_active = true
          AND (usage_limit IS NULL OR used_count < usage_limit)
        RETURNING id
      `);
      if (!rows.length) throw new ShopError(400, "쿠폰을 사용할 수 없습니다. 한도가 소진되었을 수 있습니다.");
    }

    // ── 3. 포인트 차감 ─────────────────────────────────
    // 주문 생성과 같은 트랜잭션이어야 한다. 하나만 성공하면 잔액이 어긋난다.
    if (requestedPoint > 0 && params.pointsPort && params.userId) {
      const ok = await params.pointsPort.spend(
        {
          userId: params.userId,
          amount: requestedPoint,
          reason: `주문 결제 (${orderNo})`,
          refType: "shop.order",
          refId: orderNo,
        },
        tx,
      );
      if (!ok) {
        // 검증 후 차감 사이에 잔액이 줄었다 — 주문 전체를 되돌린다
        throw new ShopError(409, "포인트 잔액이 부족합니다. 다시 시도해주세요.");
      }
    }

    // ── 4. 주문 ────────────────────────────────────────
    await tx.execute(sql`
      INSERT INTO shop_orders (
        id, order_no, user_id, status,
        subtotal, discount, shipping_fee, total, coupon_code, point_used,
        payment_method, payment_status,
        orderer_name, orderer_phone, orderer_email,
        receiver_name, receiver_phone, postcode, address1, address2, delivery_memo,
        guest_token, idempotency_key
      ) VALUES (
        ${orderId}, ${orderNo}, ${params.userId ?? null}::uuid, 'pending',
        ${q.subtotal}, ${q.discount}, ${q.shippingFee}, ${q.total}, ${q.couponCode}, ${requestedPoint},
        ${method}, 'unpaid',
        ${orderer.ordererName}, ${orderer.ordererPhone}, ${orderer.ordererEmail ?? null},
        ${orderer.receiverName || orderer.ordererName}, ${orderer.receiverPhone || orderer.ordererPhone},
        ${orderer.postcode}, ${orderer.address1}, ${orderer.address2 ?? null}, ${orderer.deliveryMemo ?? null},
        ${guestToken}, ${idemKey}
      )
    `);

    // ── 5. 주문 항목 (가격 스냅샷) ─────────────────────
    for (const line of q.lines) {
      await tx.execute(sql`
        INSERT INTO shop_order_items
          (id, order_id, product_id, option_id, product_name, option_name, unit_price, quantity, line_total)
        VALUES
          (${uuidv7()}, ${orderId}, ${line.productId}::uuid, ${line.optionId}::uuid,
           ${line.productName}, ${line.optionName}, ${line.unitPrice}, ${line.quantity}, ${line.lineTotal})
      `);
      await tx.execute(sql`
        UPDATE shop_products SET sold_count = sold_count + ${line.quantity} WHERE id = ${line.productId}::uuid
      `);
    }

    await tx.execute(sql`
      INSERT INTO shop_order_events (id, order_id, from_status, to_status, note)
      VALUES (${uuidv7()}, ${orderId}, NULL, 'pending', '주문 접수')
    `);

    return orderNo;
  });

  return { id: orderId, orderNo, total: q.total, guestToken };
}

/**
 * 주문 상태 변경.
 * 전이 규칙을 강제하고, 취소/환불이면 재고를 되돌린다.
 */
export async function changeOrderStatus(
  db: Db,
  orderId: string,
  to: OrderStatus,
  opts: {
    note?: string;
    actorId?: string | null;
    trackingNo?: string | null;
    /** 취소·환불 시 사용 포인트를 되돌리기 위해 필요 */
    pointsPort?: PointsPort | null;
  } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    // 동시 상태 변경 방지 — 주문 행을 잠근다 (FOR UPDATE는 트랜잭션 안에서만 유효)
    const { rows } = await tx.execute(sql`
      SELECT status FROM shop_orders WHERE id = ${orderId}::uuid FOR UPDATE
    `);
    const current = rows[0]?.status as OrderStatus | undefined;
    if (!current) throw new ShopError(404, "주문을 찾을 수 없습니다.");

    if (current === to) return; // 멱등
    if (!STATUS_TRANSITIONS[current].includes(to)) {
      throw new ShopError(400, `"${current}" 상태에서 "${to}" 로 변경할 수 없습니다.`);
    }

    // 취소/환불이면 사용 포인트를 되돌린다.
    // 재고 복원과 같은 트랜잭션에서 처리해야 부분 실패가 남지 않는다.
    if (STOCK_RESTORING.includes(to) && opts.pointsPort) {
      const { rows: order } = await tx.execute(sql`
        SELECT user_id, order_no, point_used FROM shop_orders WHERE id = ${orderId}::uuid
      `);
      const used = Number(order[0]?.point_used ?? 0);
      if (used > 0 && order[0]?.user_id) {
        await opts.pointsPort.refund(
          {
            userId: String(order[0].user_id),
            refType: "shop.order",
            refId: String(order[0].order_no),
            reason: `주문 ${to === "cancelled" ? "취소" : "환불"} 포인트 반환 (${order[0].order_no})`,
          },
          tx,
        );
      }
    }

    // 취소/환불이면 재고 복원 (이미 복원된 상태에서 또 하지 않도록 전이 규칙이 보장)
    if (STOCK_RESTORING.includes(to)) {
      const { rows: items } = await tx.execute(sql`
        SELECT product_id, option_id, quantity FROM shop_order_items WHERE order_id = ${orderId}::uuid
      `);
      for (const it of items) {
        if (it.option_id) {
          await tx.execute(sql`
            UPDATE shop_product_options SET stock = stock + ${Number(it.quantity)}
            WHERE id = ${String(it.option_id)}::uuid AND stock IS NOT NULL
          `);
        }
        if (it.product_id) {
          await tx.execute(sql`
            UPDATE shop_products
            SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock + ${Number(it.quantity)} END,
                sold_count = greatest(0, sold_count - ${Number(it.quantity)})
            WHERE id = ${String(it.product_id)}::uuid
          `);
        }
      }
    }

    const paidAt = to === "paid" ? sql`now()` : sql`paid_at`;
    const paymentStatus = to === "paid" ? "paid" : to === "refunded" ? "refunded" : null;

    await tx.execute(sql`
      UPDATE shop_orders SET
        status = ${to},
        paid_at = ${paidAt},
        payment_status = coalesce(${paymentStatus}, payment_status),
        tracking_no = coalesce(${opts.trackingNo ?? null}, tracking_no),
        cancelled_reason = coalesce(${to === "cancelled" ? (opts.note ?? null) : null}, cancelled_reason),
        updated_at = now()
      WHERE id = ${orderId}::uuid
    `);

    await tx.execute(sql`
      INSERT INTO shop_order_events (id, order_id, from_status, to_status, note, actor_id)
      VALUES (${uuidv7()}, ${orderId}, ${current}, ${to}, ${opts.note ?? null}, ${opts.actorId ?? null}::uuid)
    `);
  });
}

/**
 * 주문번호: YYYYMMDD-NNNNNN
 *
 * 순번은 시퀀스에서 받는다. count(*)+1 로 만들면 동시 주문이 같은 번호를 만들어
 * unique 제약에 걸린다(실제로 발생했던 버그). 시퀀스는 트랜잭션 롤백과 무관하게
 * 원자적으로 증가하므로 경합이 없다 — 번호가 건너뛸 수 있지만 중복은 없다.
 */
async function nextOrderNo(db: Db): Promise<string> {
  const { rows } = await db.execute(sql`
    SELECT to_char(now(), 'YYYYMMDD') AS day, nextval('shop_order_no_seq') AS seq
  `);
  const day = String(rows[0]?.day ?? "00000000");
  const seq = String(rows[0]?.seq ?? 1).padStart(6, "0");
  return `${day}-${seq}`;
}

function validateOrderer(o: OrdererInput): void {
  const required: Array<[keyof OrdererInput, string]> = [
    ["ordererName", "주문자 이름"],
    ["ordererPhone", "주문자 연락처"],
    ["postcode", "우편번호"],
    ["address1", "주소"],
  ];
  for (const [key, label] of required) {
    if (!String(o?.[key] ?? "").trim()) throw new ShopError(400, `${label}을(를) 입력해주세요.`);
  }
  if (!/^[0-9\-+() ]{7,30}$/.test(o.ordererPhone.trim())) {
    throw new ShopError(400, "연락처 형식이 올바르지 않습니다.");
  }
  if (o.ordererEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.ordererEmail)) {
    throw new ShopError(400, "이메일 형식이 올바르지 않습니다.");
  }
}
