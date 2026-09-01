import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { cancelReceiptsForOrder } from "./tax.js";
import { ShopError } from "./types.js";
import type { PointsPort } from "./orders.js";

/**
 * 주문 취소 · 반품 · 교환.
 *
 * 편의 기능이 아니라 **법적 요건**이다. 전자상거래법 제17조는 소비자가 상품을
 * 받은 날부터 7일 안에 청약철회를 할 수 있다고 정하고, 사업자는 이를 거부할 수
 * 없다. 반품이 안 되는 쇼핑몰은 실제로 운영할 수 없다.
 *
 * 설계에서 어려운 것은 **부분**이다. 세 개 중 하나만 반품하면
 *  - 그 항목의 금액만 환불해야 하고
 *  - 쿠폰 할인은 안분해서 되돌려야 하고
 *  - 배송비는 상황에 따라 돌려주기도 하고 아니기도 하고
 *  - 나머지 두 개의 배송 정보는 그대로 살아 있어야 한다.
 */

/** 취소·반품·교환 */
export const RETURN_KINDS = ["cancel", "return", "exchange"] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

export const KIND_LABEL: Record<ReturnKind, string> = {
  cancel: "취소",
  return: "반품",
  exchange: "교환",
};

export const RETURN_STATUS = [
  "requested",  // 접수
  "approved",   // 승인
  "rejected",   // 거부
  "collecting", // 수거중
  "received",   // 입고
  "completed",  // 완료 (환불/재발송 끝)
  "cancelled",  // 고객이 요청을 철회
] as const;
export type ReturnStatus = (typeof RETURN_STATUS)[number];

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  requested: "접수",
  approved: "승인",
  rejected: "거부",
  collecting: "수거중",
  received: "입고완료",
  completed: "처리완료",
  cancelled: "요청취소",
};

/**
 * 상태 전이 규칙.
 *
 * 취소(cancel)는 수거가 없으므로 승인 → 완료로 바로 간다.
 * 반품·교환은 수거와 입고를 거친다 — 물건을 받기 전에 환불하면 돈만 나간다.
 */
export const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["collecting", "received", "completed", "rejected"],
  collecting: ["received", "rejected"],
  received: ["completed", "rejected"],
  rejected: [],
  completed: [],
  cancelled: [],
};

/**
 * 사유 구분 — **누가 배송비를 내는지**를 결정한다.
 *
 * 자유 입력이 아닌 이유: 배송비 부담이 여기 걸려 있어 문자열을 자유롭게 받으면
 * 정산이 불가능해진다. 그리고 사업자가 임의로 "고객 부담"이라고 적는 것을
 * 막아야 한다 — 불량·오배송의 반송비를 고객에게 청구하는 것은 위법이다
 * (전자상거래법 제18조 제10항).
 */
export const REASON_CODES = {
  change_of_mind: { label: "단순 변심", payer: "customer" as const },
  size_or_color: { label: "사이즈·색상 변경", payer: "customer" as const },
  defect: { label: "상품 불량", payer: "seller" as const },
  wrong_item: { label: "오배송", payer: "seller" as const },
  damaged: { label: "배송 중 파손", payer: "seller" as const },
  late_delivery: { label: "배송 지연", payer: "seller" as const },
  other: { label: "기타", payer: "customer" as const },
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

/** 청약철회 기간 (일). 전자상거래법 제17조 */
export const WITHDRAWAL_DAYS = 7;

export interface ReturnableItem {
  orderItemId: string;
  productName: string;
  optionName: string | null;
  unitPrice: number;
  quantity: number;
  cancelledQty: number;
  /** 아직 취소·반품할 수 있는 수량 */
  availableQty: number;
}

/**
 * 이 주문에서 무엇을 얼마나 취소·반품할 수 있는가.
 *
 * 화면이 "몇 개까지 선택 가능한가"를 알아야 하고, 서버도 같은 계산으로
 * 검증해야 한다 — 두 곳에 나누어 구현하면 반드시 어긋난다.
 */
export async function getReturnable(
  db: Db,
  params: {
    orderNo: string;
    viewer: { id: string; role: string } | null;
    /**
     * 비회원 주문의 소유 증명 (주문 시 발급된 토큰).
     *
     * 청약철회권(전자상거래법 제17조)은 **회원 여부와 무관한 법적 권리**다 —
     * 비회원 구매자도 신청할 수 있어야 한다. 주문 조회와 같은 규칙을 쓴다:
     * 주문번호는 순차적이라 번호만으로는 열리지 않고, 주문했던 기기의
     * 토큰이 있어야 한다.
     */
    guestToken?: string | null;
  },
): Promise<{
  order: Record<string, unknown>;
  items: ReturnableItem[];
  /** 지금 신청할 수 있는 종류 */
  allowedKinds: ReturnKind[];
  /** 청약철회 기한 (배송완료 + 7일). 아직 배송 전이면 null */
  withdrawalDeadline: string | null;
  withdrawalExpired: boolean;
}> {
  const { rows } = await db.execute(sql`
    SELECT id, order_no, user_id, guest_token, status, subtotal, discount, shipping_fee,
           point_used, total, delivered_at, coupon_code, payment_status
    FROM shop_orders WHERE order_no = ${params.orderNo} LIMIT 1
  `);
  const order = rows[0];
  if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");

  const isManager = params.viewer?.role === "admin" || params.viewer?.role === "manager";
  const isOwner = Boolean(params.viewer && String(order.user_id) === params.viewer.id);
  // 비회원 주문 — 토큰이 일치하고 그 주문에 회원이 없을 때만
  const token = String(params.guestToken ?? "");
  const isGuestOwner = Boolean(
    token && !order.user_id && String(order.guest_token ?? "") === token,
  );
  if (!isManager && !isOwner && !isGuestOwner) {
    // 주문번호는 순차적이므로 존재를 알려주지 않는다
    throw new ShopError(404, "주문을 찾을 수 없습니다.");
  }

  const { rows: items } = await db.execute(sql`
    SELECT id, product_name, option_name, unit_price, quantity, cancelled_qty
    FROM shop_order_items WHERE order_id = ${String(order.id)}::uuid
    ORDER BY product_name
  `);

  const status = String(order.status);
  const deliveredAt = order.delivered_at ? new Date(String(order.delivered_at)) : null;
  const deadline = deliveredAt
    ? new Date(deliveredAt.getTime() + WITHDRAWAL_DAYS * 86400_000)
    : null;
  const expired = Boolean(deadline && Date.now() > deadline.getTime());

  return {
    order,
    items: items.map((i) => {
      const quantity = Number(i.quantity);
      const cancelledQty = Number(i.cancelled_qty);
      return {
        orderItemId: String(i.id),
        productName: String(i.product_name),
        optionName: i.option_name ? String(i.option_name) : null,
        unitPrice: Number(i.unit_price),
        quantity,
        cancelledQty,
        availableQty: Math.max(0, quantity - cancelledQty),
      };
    }),
    allowedKinds: allowedKinds(status, expired),
    withdrawalDeadline: deadline ? deadline.toISOString() : null,
    withdrawalExpired: expired,
  };
}

/**
 * 주문 상태별로 신청할 수 있는 종류.
 *
 * 배송 전에는 **취소**만 가능하다 — 아직 물건이 안 갔으므로 수거할 것이 없다.
 * 배송 후에는 반품·교환이다.
 */
function allowedKinds(status: string, withdrawalExpired: boolean): ReturnKind[] {
  switch (status) {
    case "pending":
    case "paid":
    case "preparing":
      return ["cancel"];
    case "shipped":
      // 배송 중에는 취소를 받지 않는다. 이미 물건이 나갔으므로 반품 절차를 타야 한다.
      return ["return", "exchange"];
    case "delivered":
      // 청약철회 기간이 지나면 단순 변심 반품은 못 하지만, 불량은 언제든 받아야 한다.
      // 종류는 열어두고 사유 검증에서 구분한다(아래 assertReasonAllowed).
      return withdrawalExpired ? ["return", "exchange"] : ["return", "exchange"];
    default:
      return [];
  }
}

/**
 * 청약철회 기간이 지난 뒤의 사유 제한.
 *
 * 단순 변심은 7일 안에만 가능하다. 불량·오배송은 기간과 무관하게 받아야 한다
 * (하자에 대한 책임은 청약철회와 별개다).
 */
function assertReasonAllowed(reasonCode: ReasonCode, withdrawalExpired: boolean): void {
  if (!withdrawalExpired) return;
  const payer = REASON_CODES[reasonCode].payer;
  if (payer === "customer") {
    throw new ShopError(
      400,
      `단순 변심으로 인한 반품은 배송 완료 후 ${WITHDRAWAL_DAYS}일 안에만 신청할 수 있습니다. ` +
        `상품에 문제가 있다면 사유를 다시 선택해주세요.`,
    );
  }
}

async function nextReturnNo(db: Db): Promise<string> {
  const { rows } = await db.execute(sql`SELECT nextval('shop_return_no_seq') AS n`);
  const n = Number(rows[0]?.n ?? 0);
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `R${ymd}-${String(n).padStart(5, "0")}`;
}

export interface RequestInput {
  kind: string;
  reasonCode: string;
  reason?: string;
  images?: string[];
  items: Array<{ orderItemId: string; quantity: number; exchangeOptionId?: string | null }>;
}

/**
 * 취소·반품·교환 신청.
 *
 * 금액 계산이 이 함수의 본체다. **할인을 안분한다** —
 * 10,000원짜리 두 개에 2,000원 쿠폰을 쓴 주문에서 하나를 반품하면
 * 10,000원을 돌려주면 안 된다. 실제로 받은 돈은 18,000원이고 하나에 9,000원이다.
 */
export async function requestReturn(
  db: Db,
  params: {
    orderNo: string;
    input: RequestInput;
    viewer: { id: string; role: string } | null;
    /** 비회원 주문의 소유 증명 — getReturnable 과 같은 규칙 */
    guestToken?: string | null;
    settings: { returnShippingFee: number };
  },
): Promise<{ id: string; returnNo: string; refundAmount: number; shippingPayer: string }> {
  const kind = String(params.input?.kind ?? "") as ReturnKind;
  if (!RETURN_KINDS.includes(kind)) throw new ShopError(400, "요청 종류가 올바르지 않습니다.");

  const reasonCode = String(params.input?.reasonCode ?? "") as ReasonCode;
  if (!(reasonCode in REASON_CODES)) throw new ShopError(400, "사유를 선택해주세요.");

  const view = await getReturnable(db, {
    orderNo: params.orderNo,
    viewer: params.viewer,
    guestToken: params.guestToken,
  });
  if (!view.allowedKinds.includes(kind)) {
    throw new ShopError(
      400,
      `현재 주문 상태에서는 ${KIND_LABEL[kind]}을 신청할 수 없습니다.`,
    );
  }
  assertReasonAllowed(reasonCode, view.withdrawalExpired);

  const requested = Array.isArray(params.input?.items) ? params.input.items : [];
  if (!requested.length) throw new ShopError(400, "대상 상품을 선택해주세요.");

  // 항목별 수량 검증
  const byId = new Map(view.items.map((i) => [i.orderItemId, i]));
  const lines: Array<{
    orderItemId: string;
    quantity: number;
    exchangeOptionId: string | null;
    exchangeOptionName: string | null;
  }> = [];

  for (const line of requested) {
    const item = byId.get(String(line.orderItemId));
    if (!item) throw new ShopError(400, "주문에 없는 상품이 포함되었습니다.");
    const qty = Math.floor(Number(line.quantity));
    if (!Number.isInteger(qty) || qty < 1) throw new ShopError(400, "수량이 올바르지 않습니다.");
    if (qty > item.availableQty) {
      throw new ShopError(
        400,
        `${item.productName}은(는) ${item.availableQty}개까지만 신청할 수 있습니다.`,
      );
    }
    if (lines.some((l) => l.orderItemId === item.orderItemId)) {
      throw new ShopError(400, "같은 상품이 두 번 포함되었습니다.");
    }

    // 교환은 같은 상품의 다른 옵션으로만 — 다른 상품으로 바꾸는 것은
    // 취소 + 재주문이고, 금액이 달라져 결제를 다시 해야 한다
    let exchangeOptionId: string | null = null;
    let exchangeOptionName: string | null = null;
    if (kind === "exchange" && line.exchangeOptionId) {
      const { rows } = await db.execute(sql`
        SELECT o.id, o.name FROM shop_product_options o
        JOIN shop_order_items i ON i.product_id = o.product_id
        WHERE o.id = ${String(line.exchangeOptionId)}::uuid
          AND i.id = ${item.orderItemId}::uuid
          AND o.is_active = true
        LIMIT 1
      `);
      if (!rows[0]) {
        throw new ShopError(400, "교환할 옵션이 올바르지 않습니다. 같은 상품의 옵션만 선택할 수 있습니다.");
      }
      exchangeOptionId = String(rows[0].id);
      exchangeOptionName = String(rows[0].name);
    }

    lines.push({ orderItemId: item.orderItemId, quantity: qty, exchangeOptionId, exchangeOptionName });
  }

  // ── 금액 계산 ──
  const order = view.order;
  const subtotal = Number(order.subtotal);
  const discount = Number(order.discount) + Number(order.point_used ?? 0);
  const totalQtyValue = view.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

  const refundPerLine = lines.map((l) => {
    const item = byId.get(l.orderItemId)!;
    const gross = item.unitPrice * l.quantity;
    // 할인 안분 — 실제로 받은 돈을 기준으로 돌려준다.
    // 마지막 항목에서 반올림 오차를 흡수하지 않는다(부분 반품은 여러 번 나뉘므로
    // 매번 내림으로 계산해 사업자가 손해 보지 않게 한다 — 오차는 최대 1원이다).
    const share = totalQtyValue > 0 ? Math.floor((discount * gross) / totalQtyValue) : 0;
    return { ...l, refundAmount: Math.max(0, gross - share) };
  });

  let refundAmount = refundPerLine.reduce((sum, l) => sum + l.refundAmount, 0);

  // ── 배송비 ──
  const payer = REASON_CODES[reasonCode].payer;
  let returnShippingFee = 0;

  if (kind === "cancel") {
    // 전체 취소면 배송비도 돌려준다. 부분 취소면 배송비는 그대로 —
    // 남은 상품이 배송되므로 배송비가 발생한다.
    const allCancelled = view.items.every((i) => {
      const line = refundPerLine.find((l) => l.orderItemId === i.orderItemId);
      return i.availableQty === 0 || (line && line.quantity === i.availableQty);
    });
    if (allCancelled) refundAmount += Number(order.shipping_fee);
  } else if (payer === "customer") {
    // 단순 변심 반품은 반송비를 고객이 낸다 (전자상거래법 제18조 제9항).
    // 환불액에서 차감한다 — 별도로 청구하는 것보다 분쟁이 적다.
    returnShippingFee = Math.max(0, Math.floor(params.settings.returnShippingFee));
    refundAmount = Math.max(0, refundAmount - returnShippingFee);
  }
  // 교환은 금액 변동이 없다 (같은 상품의 다른 옵션)
  if (kind === "exchange") {
    refundAmount = 0;
    if (payer === "customer") {
      returnShippingFee = Math.max(0, Math.floor(params.settings.returnShippingFee));
    }
  }

  const id = uuidv7();
  const returnNo = await nextReturnNo(db);

  await db.transaction(async (tx) => {
    // 동시 신청 방어: 주문을 잠그고 수량을 다시 확인한다.
    // 두 창에서 같은 상품을 각각 전량 반품 신청하면 합계가 주문 수량을 넘는다.
    await tx.execute(sql`
      SELECT id FROM shop_orders WHERE id = ${String(order.id)}::uuid FOR UPDATE
    `);
    for (const l of refundPerLine) {
      const { rows } = await tx.execute(sql`
        SELECT quantity - cancelled_qty AS available FROM shop_order_items
        WHERE id = ${l.orderItemId}::uuid
      `);
      if (Number(rows[0]?.available ?? 0) < l.quantity) {
        throw new ShopError(409, "다른 요청이 먼저 처리되었습니다. 신청 가능 수량을 다시 확인해주세요.");
      }
    }

    await tx.execute(sql`
      INSERT INTO shop_returns
        (id, return_no, order_id, user_id, kind, reason_code, reason, images,
         return_shipping_fee, shipping_payer, refund_amount)
      VALUES
        (${id}, ${returnNo}, ${String(order.id)}::uuid,
         ${order.user_id ? sql`${String(order.user_id)}::uuid` : sql`NULL`},
         ${kind}, ${reasonCode}, ${String(params.input?.reason ?? "").slice(0, 2000) || null},
         ${JSON.stringify(normalizeImages(params.input?.images))}::jsonb,
         ${returnShippingFee}, ${payer}, ${refundAmount})
    `);

    for (const l of refundPerLine) {
      await tx.execute(sql`
        INSERT INTO shop_return_items
          (id, return_id, order_item_id, quantity, refund_amount,
           exchange_option_id, exchange_option_name)
        VALUES
          (${uuidv7()}, ${id}::uuid, ${l.orderItemId}::uuid, ${l.quantity}, ${l.refundAmount},
           ${l.exchangeOptionId ? sql`${l.exchangeOptionId}::uuid` : sql`NULL`},
           ${l.exchangeOptionName})
      `);
    }

    await tx.execute(sql`
      UPDATE shop_orders SET has_returns = true, updated_at = now()
      WHERE id = ${String(order.id)}::uuid
    `);
  });

  return { id, returnNo, refundAmount, shippingPayer: payer };
}

/**
 * 상태 변경 (운영자).
 *
 * `completed` 로 갈 때 실제 처리가 일어난다 — 재고 복원 · 환불 · 포인트 원복.
 * 그 전 단계는 진행 상황 표시일 뿐이다. 물건을 받기 전에 환불하면 돈만 나간다.
 */
export async function updateReturnStatus(
  db: Db,
  params: {
    returnId: string;
    status: string;
    actorId: string;
    note?: string;
    rejectReason?: string;
    pickupTrackingNo?: string;
    exchangeTrackingNo?: string;
    /** 실제 환불을 수행하는 함수 (payments.refundPayment 를 주입한다) */
    refund?: (orderNo: string, amount: number, reason: string) => Promise<void>;
    pointsPort?: PointsPort | null;
  },
): Promise<{
  status: string;
  refunded: number;
  stockRestored: number;
  /** 함께 취소된 현금영수증 수 (환불했는데 증빙이 남으면 세금을 더 낸다) */
  receiptsCancelled: number;
}> {
  const next = String(params.status) as ReturnStatus;
  if (!RETURN_STATUS.includes(next)) throw new ShopError(400, "상태가 올바르지 않습니다.");

  const { rows } = await db.execute(sql`
    SELECT r.id, r.return_no, r.status, r.kind, r.reason_code, r.refund_amount,
           r.return_shipping_fee, r.shipping_payer, r.order_id, r.user_id,
           o.order_no, o.status AS order_status, o.subtotal, o.shipping_fee, o.point_used
    FROM shop_returns r JOIN shop_orders o ON o.id = r.order_id
    WHERE r.id = ${params.returnId}::uuid LIMIT 1
  `);
  const ret = rows[0];
  if (!ret) throw new ShopError(404, "요청을 찾을 수 없습니다.");

  const current = String(ret.status) as ReturnStatus;
  if (current === next) return { status: next, refunded: 0, stockRestored: 0, receiptsCancelled: 0 };
  if (!RETURN_TRANSITIONS[current].includes(next)) {
    throw new ShopError(
      400,
      `${RETURN_STATUS_LABEL[current]} → ${RETURN_STATUS_LABEL[next]} 로는 바꿀 수 없습니다.`,
    );
  }
  if (next === "rejected" && !String(params.rejectReason ?? "").trim()) {
    // 거부는 반드시 이유를 남겨야 한다. 고객이 왜 거부됐는지 알아야 다투거나 승복할 수 있다.
    throw new ShopError(400, "거부 사유를 입력해주세요.");
  }

  let refunded = 0;
  let stockRestored = 0;
  let receiptsCancelled = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE shop_returns SET
        status = ${next},
        admin_note = coalesce(${params.note ?? null}, admin_note),
        reject_reason = coalesce(${params.rejectReason ?? null}, reject_reason),
        pickup_tracking_no = coalesce(${params.pickupTrackingNo ?? null}, pickup_tracking_no),
        exchange_tracking_no = coalesce(${params.exchangeTrackingNo ?? null}, exchange_tracking_no),
        handled_by = ${params.actorId}::uuid,
        updated_at = now()
      WHERE id = ${params.returnId}::uuid
    `);

    if (next !== "completed") return;

    // ── 완료 처리 ──
    const { rows: items } = await tx.execute(sql`
      SELECT ri.order_item_id, ri.quantity, ri.refund_amount,
             ri.exchange_option_id, ri.exchange_option_name,
             oi.product_id, oi.option_id
      FROM shop_return_items ri
      JOIN shop_order_items oi ON oi.id = ri.order_item_id
      WHERE ri.return_id = ${params.returnId}::uuid
    `);

    for (const item of items) {
      const qty = Number(item.quantity);

      if (String(ret.kind) === "exchange") {
        // 교환: 반품 옵션 재고는 늘리고 새 옵션 재고는 줄인다.
        // 주문 항목의 옵션을 바꿔 기록을 맞춘다 — 그래야 나중에 "무엇을 받았는가"가 맞다.
        if (item.option_id) {
          await tx.execute(sql`
            UPDATE shop_product_options SET stock = stock + ${qty}
            WHERE id = ${String(item.option_id)}::uuid AND stock IS NOT NULL
          `);
        }
        if (item.exchange_option_id) {
          const { rows: taken } = await tx.execute(sql`
            UPDATE shop_product_options SET stock = stock - ${qty}
            WHERE id = ${String(item.exchange_option_id)}::uuid
              AND (stock IS NULL OR stock >= ${qty})
            RETURNING id
          `);
          if (!taken.length) {
            throw new ShopError(409, "교환할 옵션의 재고가 부족합니다.");
          }
          await tx.execute(sql`
            UPDATE shop_order_items SET
              option_id = ${String(item.exchange_option_id)}::uuid,
              option_name = ${String(item.exchange_option_name ?? "")}
            WHERE id = ${String(item.order_item_id)}::uuid
          `);
        }
        stockRestored += qty;
        continue;
      }

      // 취소·반품: 취소 수량을 누적하고 재고를 되돌린다
      await tx.execute(sql`
        UPDATE shop_order_items SET
          cancelled_qty = cancelled_qty + ${qty},
          refunded_amount = refunded_amount + ${Number(item.refund_amount)}
        WHERE id = ${String(item.order_item_id)}::uuid
      `);
      if (item.product_id) {
        await tx.execute(sql`
          UPDATE shop_products SET
            stock = CASE WHEN stock IS NULL THEN NULL ELSE stock + ${qty} END,
            sold_count = greatest(0, sold_count - ${qty})
          WHERE id = ${String(item.product_id)}::uuid
        `);
      }
      if (item.option_id) {
        await tx.execute(sql`
          UPDATE shop_product_options SET stock = stock + ${qty}
          WHERE id = ${String(item.option_id)}::uuid AND stock IS NOT NULL
        `);
      }
      stockRestored += qty;
    }

    // 주문 전체가 취소·반품되었으면 주문 상태도 바꾼다.
    // 부분이면 주문은 그대로 둔다 — 남은 상품이 배송되어야 하기 때문이다.
    const { rows: remain } = await tx.execute(sql`
      SELECT coalesce(sum(quantity - cancelled_qty), 0) AS live
      FROM shop_order_items WHERE order_id = ${String(ret.order_id)}::uuid
    `);
    if (Number(remain[0]?.live ?? 0) === 0 && String(ret.kind) !== "exchange") {
      const finalStatus = String(ret.kind) === "cancel" ? "cancelled" : "refunded";
      await tx.execute(sql`
        UPDATE shop_orders SET status = ${finalStatus}, updated_at = now()
        WHERE id = ${String(ret.order_id)}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO shop_order_events (id, order_id, from_status, to_status, note, actor_id)
        VALUES (${uuidv7()}, ${String(ret.order_id)}::uuid, ${String(ret.order_status)},
                ${finalStatus}, ${`${KIND_LABEL[String(ret.kind) as ReturnKind]} 완료 (${String(ret.return_no)})`},
                ${params.actorId}::uuid)
      `);
    }

    await tx.execute(sql`
      UPDATE shop_returns SET refunded_at = now() WHERE id = ${params.returnId}::uuid
    `);
  });

  // 환불과 포인트 원복은 트랜잭션 밖에서 한다.
  //
  // 환불은 외부 PG 를 호출하므로 트랜잭션 안에 두면 커넥션을 네트워크 대기 동안
  // 잡고 있게 되고, PG 가 성공했는데 커밋이 실패하면 "돈은 나갔는데 기록이 없는"
  // 상태가 된다. 반대 순서(기록 먼저, 환불 나중)면 실패 시 재시도할 수 있다.
  if (next === "completed" && String(ret.kind) !== "exchange") {
    const amount = Number(ret.refund_amount);

    // 결제되지 않은 주문(무통장 입금 대기 등)은 환불할 것이 없다.
    // 이것을 확인하지 않으면 **가장 흔한 경우**인 "입금 전 취소"가 502 로 실패한다.
    const { rows: paid } = await db.execute(sql`
      SELECT count(*) AS n FROM shop_payments
      WHERE order_id = ${String(ret.order_id)}::uuid AND status IN ('paid', 'partial_refunded')
    `);
    const hasPayment = Number(paid[0]?.n ?? 0) > 0;

    if (amount > 0 && hasPayment && params.refund) {
      try {
        await params.refund(
          String(ret.order_no),
          amount,
          `${KIND_LABEL[String(ret.kind) as ReturnKind]} (${String(ret.return_no)})`,
        );
        refunded = amount;
      } catch (err) {
        // 실패를 삼키지 않는다 — 운영자가 알아야 수동으로 처리할 수 있다.
        // 상태는 이미 completed 이므로 재고는 돌아갔고, 환불만 남는다.
        throw new ShopError(
          502,
          `재고와 요청 상태는 처리했지만 환불에 실패했습니다: ${String(err)}. ` +
            `결제 관리에서 수동 환불해주세요.`,
        );
      }
    }

    // 사용한 포인트 원복 — 전체 취소·반품일 때만.
    // 부분이면 얼마를 되돌릴지 정할 근거가 약하고, 이중 환급 위험이 있다
    // (할인 안분에 point_used 가 이미 반영되어 있다).
    if (ret.user_id && params.pointsPort && Number(ret.point_used ?? 0) > 0) {
      const { rows: remain } = await db.execute(sql`
        SELECT coalesce(sum(quantity - cancelled_qty), 0) AS live
        FROM shop_order_items WHERE order_id = ${String(ret.order_id)}::uuid
      `);
      if (Number(remain[0]?.live ?? 0) === 0) {
        await params.pointsPort.refund({
          userId: String(ret.user_id),
          refType: "shop.order",
          refId: String(ret.order_no),
          reason: `${KIND_LABEL[String(ret.kind) as ReturnKind]}으로 포인트 반환`,
        });
      }
    }

    // 발급된 현금영수증을 취소한다.
    //
    // **환불했는데 증빙이 살아 있으면 세금을 더 낸다.** 교환은 금액이
    // 변하지 않으므로 건드리지 않는다.
    //
    // 실패해도 반품 처리를 막지 않는다 — 물건은 이미 돌려받고 환불도 나갔다.
    // 실패 사유는 cancelReceiptsForOrder 가 행에 남기므로 운영자가 홈택스에서
    // 직접 취소할 수 있다. 반품이 안 끝나는 것보다 증빙 취소가 밀리는 게 낫다.
    //
    // 조건을 `refunded > 0`(PG 환불이 실행된 금액)으로 걸면 안 된다 —
    // **무통장 주문에는 PG 결제 기록이 없어서 그 값이 항상 0이고**,
    // 현금영수증이 필요한 주문이 바로 그 무통장 주문이다. 운영자가 계좌로
    // 직접 환불하더라도 증빙은 취소되어야 한다. 그래서 **돌려줄 금액이
    // 있는가**(반품 건의 refund_amount)로 판단한다.
    if (String(ret.kind) !== "exchange" && Number(ret.refund_amount ?? 0) > 0) {
      receiptsCancelled = (
        await cancelReceiptsForOrder(db, {
          orderId: String(ret.order_id),
          reason: `${KIND_LABEL[String(ret.kind) as ReturnKind]} 환불 (${String(ret.return_no)})`,
        }).catch(() => ({ cancelled: 0 }))
      ).cancelled;
    }
  }

  return { status: next, refunded, stockRestored, receiptsCancelled };
}

/** 고객이 요청을 철회 */
export async function cancelRequest(
  db: Db,
  params: { returnId: string; viewer: { id: string; role: string } | null },
): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.status, r.user_id FROM shop_returns r WHERE r.id = ${params.returnId}::uuid LIMIT 1
  `);
  const ret = rows[0];
  if (!ret) throw new ShopError(404, "요청을 찾을 수 없습니다.");

  const isManager = params.viewer?.role === "admin" || params.viewer?.role === "manager";
  if (!isManager && String(ret.user_id) !== params.viewer?.id) {
    throw new ShopError(404, "요청을 찾을 수 없습니다.");
  }
  if (String(ret.status) !== "requested") {
    throw new ShopError(
      409,
      "이미 처리가 시작된 요청은 철회할 수 없습니다. 판매자에게 문의해주세요.",
    );
  }
  await db.execute(sql`
    UPDATE shop_returns SET status = 'cancelled', updated_at = now()
    WHERE id = ${params.returnId}::uuid
  `);
}

/** 내 요청 목록 */
export async function listMyReturns(db: Db, userId: string, page: number) {
  const size = 20;
  const { rows } = await db.execute(sql`
    SELECT r.id, r.return_no, r.kind, r.status, r.reason_code, r.refund_amount,
           r.return_shipping_fee, r.shipping_payer, r.created_at, o.order_no
    FROM shop_returns r JOIN shop_orders o ON o.id = r.order_id
    WHERE r.user_id = ${userId}::uuid
    ORDER BY r.created_at DESC LIMIT ${size} OFFSET ${(Math.max(1, page) - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_returns WHERE user_id = ${userId}::uuid
  `);
  return { items: rows.map(decorate), total: Number(cnt[0]?.n ?? 0), page: Math.max(1, page), pageSize: size };
}

/** 요청 상세 */
export async function getReturn(
  db: Db,
  params: { returnId: string; viewer: { id: string; role: string } | null },
) {
  const { rows } = await db.execute(sql`
    SELECT r.*, o.order_no FROM shop_returns r JOIN shop_orders o ON o.id = r.order_id
    WHERE r.id = ${params.returnId}::uuid LIMIT 1
  `);
  const ret = rows[0];
  if (!ret) throw new ShopError(404, "요청을 찾을 수 없습니다.");

  const isManager = params.viewer?.role === "admin" || params.viewer?.role === "manager";
  if (!isManager && String(ret.user_id) !== params.viewer?.id) {
    throw new ShopError(404, "요청을 찾을 수 없습니다.");
  }

  const { rows: items } = await db.execute(sql`
    SELECT ri.quantity, ri.refund_amount, ri.exchange_option_name,
           oi.product_name, oi.option_name, oi.unit_price
    FROM shop_return_items ri JOIN shop_order_items oi ON oi.id = ri.order_item_id
    WHERE ri.return_id = ${params.returnId}::uuid
  `);

  return { request: decorate(ret), items };
}

/** 관리자 목록 */
export async function listAllReturns(
  db: Db,
  params: { page: number; status?: string; kind?: string },
) {
  const size = 30;
  const status = params.status && RETURN_STATUS.includes(params.status as never) ? params.status : "";
  const kind = params.kind && RETURN_KINDS.includes(params.kind as never) ? params.kind : "";
  const filter = sql`
    (${status}::text = '' OR r.status = ${status})
    AND (${kind}::text = '' OR r.kind = ${kind})
  `;

  const { rows } = await db.execute(sql`
    SELECT r.id, r.return_no, r.kind, r.status, r.reason_code, r.reason,
           r.refund_amount, r.return_shipping_fee, r.shipping_payer,
           r.pickup_tracking_no, r.exchange_tracking_no, r.reject_reason, r.admin_note,
           r.created_at, o.order_no, o.orderer_name
    FROM shop_returns r JOIN shop_orders o ON o.id = r.order_id
    WHERE ${filter}
    ORDER BY (r.status = 'requested') DESC, r.created_at DESC
    LIMIT ${size} OFFSET ${(Math.max(1, params.page) - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n, count(*) FILTER (WHERE r.status = 'requested') AS pending
    FROM shop_returns r WHERE ${filter}
  `);
  return {
    items: rows.map(decorate),
    total: Number(cnt[0]?.n ?? 0),
    pendingCount: Number(cnt[0]?.pending ?? 0),
    page: Math.max(1, params.page),
    pageSize: size,
  };
}

/** 화면이 바로 쓸 수 있게 라벨을 붙인다 */
function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const kind = String(row.kind) as ReturnKind;
  const status = String(row.status) as ReturnStatus;
  const reason = String(row.reason_code) as ReasonCode;
  return {
    ...row,
    kind_label: KIND_LABEL[kind] ?? kind,
    status_label: RETURN_STATUS_LABEL[status] ?? status,
    reason_label: REASON_CODES[reason]?.label ?? reason,
    // 다음에 갈 수 있는 상태 — 관리 화면이 버튼을 만들 때 쓴다
    next_statuses: RETURN_TRANSITIONS[status] ?? [],
  };
}

function normalizeImages(input: unknown): string[] {
  return (Array.isArray(input) ? input : [])
    .map((u) => String(u).trim())
    .filter((u) => /^(\/|https?:\/\/)/.test(u) && u.length <= 1000)
    .slice(0, 5);
}
