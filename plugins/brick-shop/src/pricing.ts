import { sql } from "drizzle-orm";
import type { Db, ShopSettings } from "./types.js";
import { ShopError } from "./types.js";

export interface PricedLine {
  /** 호출자가 넘긴 참조값 (장바구니 항목 id 등). 관대 모드에서 항목이 건너뛰어져도
   *  인덱스로 짝을 맞추다 어긋나는 것을 막는다 */
  ref?: string;
  productId: string;
  optionId: string | null;
  productName: string;
  optionName: string | null;
  slug: string;
  imageUrl: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  freeShipping: boolean;
  /** 현재 남은 재고 (null이면 무한) */
  stock: number | null;
  /** 지금 이 수량으로 주문 가능한가 */
  available: boolean;
  /** 주문할 수 없는 이유 (available=false일 때) */
  issue?: string;
}

export interface Quote {
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  shippingFee: number;
  total: number;
  couponCode: string | null;
  /** 쿠폰을 적용하지 못한 이유 (관대 모드에서만 채워진다) */
  couponError?: string;
  /** 주문할 수 없는 항목이 있는가 */
  hasUnavailable: boolean;
}

export interface QuoteOptions {
  /**
   * true(기본)면 재고 부족·판매중지를 예외로 던진다 — 주문 생성 시.
   * false면 해당 항목을 available=false로 표시하고 합계에서 제외한다 — 장바구니 조회 시.
   *
   * 장바구니 조회가 재고 부족으로 실패하면 사용자가 장바구니를 볼 수도, 수량을
   * 줄일 수도 없게 된다. 다른 사람이 먼저 구매하는 것은 정상 상황이므로
   * 화면이 깨지지 않아야 한다.
   */
  enforceStock?: boolean;
}

/**
 * 금액 계산 — **항상 서버에서 DB 가격으로 다시 계산한다.**
 * 클라이언트가 보낸 가격을 신뢰하면 가격 조작이 가능하다.
 *
 * 모든 금액은 원 단위 integer. 퍼센트 할인은 Math.floor로 절사한다.
 */
export async function quote(
  db: Db,
  items: Array<{ productId: string; optionId?: string | null; quantity: number; ref?: string }>,
  settings: ShopSettings,
  couponCode?: string | null,
  opts: QuoteOptions = {},
): Promise<Quote> {
  const strict = opts.enforceStock !== false;
  if (!items.length) {
    if (strict) throw new ShopError(400, "주문할 상품이 없습니다.");
    return { lines: [], subtotal: 0, discount: 0, shippingFee: 0, total: 0, couponCode: null, hasUnavailable: false };
  }

  const lines: PricedLine[] = [];
  for (const item of items) {
    const qty = Math.floor(Number(item.quantity));
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
      throw new ShopError(400, "수량은 1~999 사이여야 합니다.");
    }

    const { rows } = await db.execute(sql`
      SELECT p.id, p.slug, p.name, p.price, p.stock, p.status, p.free_shipping, p.image_url,
             o.id AS option_id, o.name AS option_name, o.extra_price, o.stock AS option_stock, o.is_active
      FROM shop_products p
      LEFT JOIN shop_product_options o
        ON o.id = ${item.optionId ?? null}::uuid AND o.product_id = p.id
      WHERE p.id = ${item.productId}::uuid
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) {
      if (strict) throw new ShopError(404, "상품을 찾을 수 없습니다.");
      continue; // 삭제된 상품은 장바구니에서 조용히 제외
    }

    // 옵션 재고가 지정되어 있으면 그것이, 없으면 상품 재고가 기준이다
    const stock =
      row.option_id && row.option_stock !== null
        ? Number(row.option_stock)
        : row.stock === null
          ? null
          : Number(row.stock);

    const unitPrice = Number(row.price) + Number(row.extra_price ?? 0);
    let issue: string | undefined;

    if (row.status !== "selling") issue = "판매중이 아닙니다";
    else if (item.optionId && !row.option_id) issue = "선택한 옵션이 없습니다";
    else if (item.optionId && row.is_active === false) issue = "선택한 옵션을 판매하지 않습니다";
    else if (stock !== null && stock <= 0) issue = "품절되었습니다";
    else if (stock !== null && stock < qty) issue = `재고가 ${stock}개만 남았습니다`;

    if (issue && strict) {
      // 주문 시에는 명확한 에러로 막는다
      const status = issue.includes("재고") || issue.includes("품절") ? 409 : 400;
      throw new ShopError(status, `"${row.name}" ${issue}.`);
    }

    lines.push({
      ...(item.ref ? { ref: item.ref } : {}),
      productId: String(row.id),
      optionId: row.option_id ? String(row.option_id) : null,
      productName: String(row.name),
      optionName: row.option_name ? String(row.option_name) : null,
      slug: String(row.slug),
      imageUrl: row.image_url ? String(row.image_url) : null,
      unitPrice,
      quantity: qty,
      lineTotal: unitPrice * qty,
      freeShipping: Boolean(row.free_shipping),
      stock,
      available: !issue,
      ...(issue ? { issue } : {}),
    });
  }

  // 합계는 주문 가능한 항목만 (품절 상품이 금액에 섞이면 안 된다)
  const payable = lines.filter((l) => l.available);
  const subtotal = payable.reduce((sum, l) => sum + l.lineTotal, 0);

  let discount = 0;
  let appliedCode: string | null = null;
  let couponError: string | undefined;
  try {
    const applied = await applyCoupon(db, subtotal, couponCode);
    discount = applied.discount;
    appliedCode = applied.code;
  } catch (err) {
    if (strict) throw err;
    // 장바구니 조회에서는 쿠폰 문제로 화면이 깨지지 않게 한다
    couponError = err instanceof Error ? err.message : String(err);
  }

  const shippingFee = payable.length ? calcShipping(payable, subtotal - discount, settings) : 0;

  return {
    lines,
    subtotal,
    discount,
    shippingFee,
    total: subtotal - discount + shippingFee,
    couponCode: appliedCode,
    ...(couponError ? { couponError } : {}),
    hasUnavailable: lines.some((l) => !l.available),
  };
}

/** 배송비: 모든 상품이 무료배송이거나 기준 금액 이상이면 0 */
function calcShipping(lines: PricedLine[], amountAfterDiscount: number, settings: ShopSettings): number {
  if (lines.every((l) => l.freeShipping)) return 0;
  if (settings.freeShippingOver > 0 && amountAfterDiscount >= settings.freeShippingOver) return 0;
  return Math.max(0, Math.floor(settings.shippingFee));
}

/** 쿠폰 검증 및 할인액 계산 */
async function applyCoupon(
  db: Db,
  subtotal: number,
  code?: string | null,
): Promise<{ discount: number; code: string | null }> {
  const trimmed = (code ?? "").trim().toUpperCase();
  if (!trimmed) return { discount: 0, code: null };

  const { rows } = await db.execute(sql`
    SELECT code, discount_type, discount_value, min_amount, max_discount, usage_limit, used_count,
           starts_at, ends_at, is_active
    FROM shop_coupons WHERE upper(code) = ${trimmed} LIMIT 1
  `);
  const c = rows[0];
  if (!c) throw new ShopError(400, "존재하지 않는 쿠폰입니다.");
  if (!c.is_active) throw new ShopError(400, "사용할 수 없는 쿠폰입니다.");

  const now = Date.now();
  if (c.starts_at && new Date(String(c.starts_at)).getTime() > now) {
    throw new ShopError(400, "아직 사용할 수 없는 쿠폰입니다.");
  }
  if (c.ends_at && new Date(String(c.ends_at)).getTime() < now) {
    throw new ShopError(400, "사용 기간이 지난 쿠폰입니다.");
  }
  if (c.usage_limit !== null && Number(c.used_count) >= Number(c.usage_limit)) {
    throw new ShopError(400, "쿠폰 사용 한도가 모두 소진되었습니다.");
  }
  if (subtotal < Number(c.min_amount)) {
    throw new ShopError(400, `${Number(c.min_amount).toLocaleString("ko-KR")}원 이상 구매 시 사용할 수 있습니다.`);
  }

  let discount =
    c.discount_type === "percent"
      ? Math.floor((subtotal * Number(c.discount_value)) / 100)
      : Number(c.discount_value);
  if (c.max_discount !== null) discount = Math.min(discount, Number(c.max_discount));
  // 할인이 상품 금액을 넘어 총액이 음수가 되지 않게 한다
  discount = Math.min(discount, subtotal);

  return { discount, code: String(c.code) };
}
