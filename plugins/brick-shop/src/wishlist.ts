import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/**
 * 위시리스트 · 최근 본 상품 · 지역별 배송비.
 *
 * 위시리스트는 **비회원도 쓸 수 있어야 한다.** "마음에 드는 걸 담아두다가
 * 나중에 가입"이 실제 흐름이고, 로그인을 요구하면 아무도 쓰지 않는다.
 * 장바구니와 같은 판단이고, 같은 게스트 토큰을 쓴다.
 */

export interface Owner {
  userId?: string | null;
  guestToken?: string | null;
}

/** 소유자 조건. 둘 다 없으면 에러 — 조용히 전체를 반환하면 남의 목록이 보인다 */
function ownerFilter(owner: Owner) {
  if (owner.userId) return sql`user_id = ${owner.userId}::uuid`;
  if (owner.guestToken) return sql`guest_token = ${owner.guestToken}`;
  throw new ShopError(400, "위시리스트를 식별할 수 없습니다.");
}

/* ── 위시리스트 ────────────────────────────────────── */

export async function addToWishlist(
  db: Db,
  params: { owner: Owner; productId: string },
): Promise<{ added: boolean; guestToken: string | null }> {
  const { rows: product } = await db.execute(sql`
    SELECT id FROM shop_products
    WHERE id = ${params.productId}::uuid AND status IN ('selling', 'soldout') LIMIT 1
  `);
  if (!product[0]) throw new ShopError(404, "상품을 찾을 수 없습니다.");

  // 비회원은 토큰을 만들어 준다 (장바구니와 같은 방식)
  const guestToken = params.owner.userId
    ? null
    : params.owner.guestToken || uuidv7().replace(/-/g, "");

  // 이미 담긴 상품은 조용히 넘어간다. 두 번 눌렀다고 오류를 주면
  // "담기"가 실패한 것처럼 보인다.
  const { rows } = await db.execute(sql`
    INSERT INTO shop_wishlist (id, user_id, guest_token, product_id)
    VALUES (${uuidv7()},
            ${params.owner.userId ? sql`${params.owner.userId}::uuid` : sql`NULL`},
            ${guestToken}, ${params.productId}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING id
  `);

  return { added: rows.length > 0, guestToken };
}

export async function removeFromWishlist(
  db: Db,
  params: { owner: Owner; productId: string },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM shop_wishlist
    WHERE ${ownerFilter(params.owner)} AND product_id = ${params.productId}::uuid
  `);
}

export async function listWishlist(db: Db, owner: Owner) {
  const { rows } = await db.execute(sql`
    SELECT w.product_id, w.created_at,
           p.slug, p.name, p.price, p.list_price, p.image_url, p.status, p.stock,
           p.review_count, p.rating_sum
    FROM shop_wishlist w JOIN shop_products p ON p.id = w.product_id
    WHERE ${ownerFilter(owner)}
    ORDER BY w.created_at DESC
    LIMIT 200
  `);
  return {
    items: rows.map((r) => ({
      ...r,
      // 담아둔 뒤 품절이 될 수 있다 — 화면이 알려줘야 한다
      soldout: r.status === "soldout" || (r.stock !== null && Number(r.stock) <= 0),
    })),
    total: rows.length,
  };
}

/** 이 상품이 내 위시리스트에 있는가 (상세 화면의 하트 상태) */
export async function isInWishlist(
  db: Db,
  params: { owner: Owner; productIds: string[] },
): Promise<string[]> {
  if (!params.productIds.length) return [];
  if (!params.owner.userId && !params.owner.guestToken) return [];

  const list = sql.join(params.productIds.map((id) => sql`${id}::uuid`), sql`, `);
  const { rows } = await db.execute(sql`
    SELECT product_id FROM shop_wishlist
    WHERE ${ownerFilter(params.owner)} AND product_id IN (${list})
  `);
  return rows.map((r) => String(r.product_id));
}

/**
 * 로그인할 때 비회원 위시리스트를 회원으로 옮긴다.
 *
 * 이게 없으면 "담아두고 가입했더니 사라졌다"가 된다 — 위시리스트를 비회원에게
 * 허용한 이유가 무의미해진다.
 */
export async function mergeGuestWishlist(
  db: Db,
  params: { userId: string; guestToken: string },
): Promise<number> {
  if (!params.guestToken) return 0;
  const { rows } = await db.execute(sql`
    INSERT INTO shop_wishlist (id, user_id, product_id, created_at)
    SELECT gen_random_uuid(), ${params.userId}::uuid, w.product_id, w.created_at
    FROM shop_wishlist w
    WHERE w.guest_token = ${params.guestToken}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  await db.execute(sql`DELETE FROM shop_wishlist WHERE guest_token = ${params.guestToken}`);
  return rows.length;
}

/* ── 최근 본 상품 ──────────────────────────────────── */

/** 보관하는 개수 — 넘으면 오래된 것부터 지운다 */
const RECENT_LIMIT = 30;

export async function recordView(
  db: Db,
  params: { owner: Owner; productId: string },
): Promise<{ guestToken: string | null }> {
  const guestToken = params.owner.userId
    ? null
    : params.owner.guestToken || uuidv7().replace(/-/g, "");

  const ownerCol = params.owner.userId ? sql`user_id` : sql`guest_token`;
  const ownerVal = params.owner.userId
    ? sql`${params.owner.userId}::uuid`
    : sql`${guestToken}`;

  // 같은 상품을 다시 보면 시각만 갱신한다 — 행이 쌓이지 않는다
  await db.execute(sql`
    INSERT INTO shop_recent_views (id, user_id, guest_token, product_id)
    VALUES (${uuidv7()},
            ${params.owner.userId ? sql`${params.owner.userId}::uuid` : sql`NULL`},
            ${guestToken}, ${params.productId}::uuid)
    ON CONFLICT (${ownerCol}, product_id)
      ${params.owner.userId ? sql`WHERE user_id IS NOT NULL` : sql`WHERE guest_token IS NOT NULL`}
      DO UPDATE SET viewed_at = now()
  `);

  // 개수를 넘으면 오래된 것을 지운다.
  // 매 조회마다 지우는 것이 낭비처럼 보이지만, 배치 작업을 두면 그 작업이
  // 실패했을 때 조용히 무한히 쌓인다.
  await db.execute(sql`
    DELETE FROM shop_recent_views WHERE id IN (
      SELECT id FROM shop_recent_views
      WHERE ${ownerCol} = ${ownerVal}
      ORDER BY viewed_at DESC OFFSET ${RECENT_LIMIT}
    )
  `);

  return { guestToken };
}

export async function listRecentViews(db: Db, owner: Owner, limit = 10) {
  if (!owner.userId && !owner.guestToken) return { items: [] };
  const { rows } = await db.execute(sql`
    SELECT r.product_id, r.viewed_at,
           p.slug, p.name, p.price, p.list_price, p.image_url, p.status, p.stock
    FROM shop_recent_views r JOIN shop_products p ON p.id = r.product_id
    WHERE ${ownerFilter(owner)} AND p.status IN ('selling', 'soldout')
    ORDER BY r.viewed_at DESC
    LIMIT ${Math.min(RECENT_LIMIT, Math.max(1, limit))}
  `);
  return { items: rows };
}

/** 로그인 시 비회원 열람 기록 이어받기 */
export async function mergeGuestViews(
  db: Db,
  params: { userId: string; guestToken: string },
): Promise<void> {
  if (!params.guestToken) return;
  await db.execute(sql`
    INSERT INTO shop_recent_views (id, user_id, product_id, viewed_at)
    SELECT gen_random_uuid(), ${params.userId}::uuid, v.product_id, v.viewed_at
    FROM shop_recent_views v
    WHERE v.guest_token = ${params.guestToken}
    ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL
      DO UPDATE SET viewed_at = greatest(shop_recent_views.viewed_at, excluded.viewed_at)
  `);
  await db.execute(sql`DELETE FROM shop_recent_views WHERE guest_token = ${params.guestToken}`);
}

/**
 * 오래된 열람 기록 정리.
 *
 * 개인의 관심사가 담긴 기록이므로 오래 보관할 이유가 없다.
 * 개인정보 최소 보관 원칙에 맞춘다.
 */
export async function purgeOldViews(db: Db, days = 90): Promise<number> {
  const { rows } = await db.execute(sql`
    DELETE FROM shop_recent_views
    WHERE viewed_at < now() - ${sql.raw(`interval '${Math.max(1, Math.floor(days))} days'`)}
    RETURNING id
  `);
  return rows.length;
}

/* ── 지역별 추가 배송비 ────────────────────────────── */

export interface ZoneFee {
  name: string;
  extraFee: number;
}

/**
 * 우편번호로 추가 배송비를 찾는다.
 *
 * 주소 문자열로 판단하지 않는다 — "제주도청"과 "제주식당"을 구분할 수 없고,
 * 서울 "제주도로"처럼 이름만 같은 곳이 실제로 있다.
 *
 * 구간이 겹치면 **가장 비싼 것**을 적용한다. 겹치게 설정한 것은 실수일 가능성이
 * 높고, 그때 덜 받는 쪽으로 기울면 사업자가 손해를 본다.
 */
export async function findZoneFee(db: Db, postcode: string): Promise<ZoneFee | null> {
  const code = String(postcode ?? "").replace(/\D/g, "");
  if (code.length !== 5) return null;

  const { rows } = await db.execute(sql`
    SELECT name, extra_fee FROM shop_shipping_zones
    WHERE is_active = true AND ${code} BETWEEN postcode_from AND postcode_to
    ORDER BY extra_fee DESC LIMIT 1
  `);
  if (!rows[0]) return null;
  return { name: String(rows[0].name), extraFee: Number(rows[0].extra_fee) };
}

export async function listZones(db: Db) {
  const { rows } = await db.execute(sql`
    SELECT id, name, postcode_from, postcode_to, extra_fee, is_active, sort_order
    FROM shop_shipping_zones ORDER BY sort_order, name
  `);
  return { items: rows, total: rows.length, page: 1, pageSize: rows.length || 1 };
}

const POSTCODE_RE = /^\d{5}$/;

export function validateZone(b: Record<string, unknown>) {
  const name = String(b.name ?? "").trim();
  if (!name) throw new ShopError(400, "지역명을 입력해주세요.");

  const from = String(b.postcode_from ?? "").replace(/\D/g, "");
  const to = String(b.postcode_to ?? "").replace(/\D/g, "");
  if (!POSTCODE_RE.test(from) || !POSTCODE_RE.test(to)) {
    throw new ShopError(400, "우편번호는 5자리 숫자로 입력해주세요.");
  }
  if (from > to) {
    throw new ShopError(400, "시작 우편번호가 끝 우편번호보다 큽니다.");
  }

  const extraFee = Math.floor(Number(b.extra_fee ?? 0));
  if (!Number.isFinite(extraFee) || extraFee < 0) {
    throw new ShopError(400, "추가 배송비는 0원 이상이어야 합니다.");
  }
  return {
    name: name.slice(0, 100),
    from,
    to,
    extraFee,
    isActive: b.is_active !== false,
    sortOrder: Math.floor(Number(b.sort_order ?? 0)) || 0,
  };
}

export async function createZone(db: Db, b: Record<string, unknown>): Promise<{ id: string }> {
  const v = validateZone(b);
  const id = uuidv7();
  await db.execute(sql`
    INSERT INTO shop_shipping_zones
      (id, name, postcode_from, postcode_to, extra_fee, is_active, sort_order)
    VALUES (${id}, ${v.name}, ${v.from}, ${v.to}, ${v.extraFee}, ${v.isActive}, ${v.sortOrder})
  `);
  return { id };
}

export async function updateZone(db: Db, id: string, b: Record<string, unknown>): Promise<void> {
  const v = validateZone(b);
  const { rows } = await db.execute(sql`
    UPDATE shop_shipping_zones SET
      name = ${v.name}, postcode_from = ${v.from}, postcode_to = ${v.to},
      extra_fee = ${v.extraFee}, is_active = ${v.isActive}, sort_order = ${v.sortOrder}
    WHERE id = ${id}::uuid RETURNING id
  `);
  if (!rows.length) throw new ShopError(404, "지역을 찾을 수 없습니다.");
}

export async function deleteZone(db: Db, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM shop_shipping_zones WHERE id = ${id}::uuid`);
}
