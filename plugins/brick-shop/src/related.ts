/**
 * 관련 상품 · 함께 구매.
 *
 * 수동 지정을 먼저 쓰고, 자리가 남으면 함께 구매로 채운다. 이유는
 * migrations/0008_related.sql 주석에 적어 두었다 — 새 쇼핑몰에는 주문
 * 이력이 없고, 상품이 많은 쇼핑몰에서는 전부 수동 지정할 수 없다.
 *
 * ── 추천에서 빼야 하는 것 ────────────────────────────
 *
 * 추천은 **틀리면 손해로 이어진다.** 걸러야 하는 것:
 *
 *   - `selling`·`soldout` 이 아닌 상품 — `draft`(작성 중)나 `hidden`(내린
 *     상품)을 추천하면 아직/이미 안 파는 것을 노출한다. draft 노출은
 *     정보 유출이기도 하다.
 *   - **결제되지 않은 주문** — 장바구니를 만들어 두기만 한 것으로 추천이
 *     만들어지면, 아무도 안 산 조합이 "함께 구매"로 뜬다.
 *   - **취소·반품된 항목** — 반품된 상품을 "함께 구매하셨습니다"로 미는
 *     것은 반품 사유를 반복시키는 짓이다. `quantity > cancelled_qty` 로
 *     걸러 산 것만 센다.
 *   - 자기 자신.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/** 상품 상세에 붙일 만큼 (한 줄에 4개 × 2줄) */
export const RELATED_LIMIT = 8;

export interface RelatedProduct {
  id: string;
  slug: string;
  name: string;
  price: number;
  listPrice: number | null;
  imageUrl: string | null;
  status: string;
  /** manual(운영자 지정) | copurchase(함께 구매) */
  source: "manual" | "copurchase";
}

/** 추천 가능한 상품 상태 — 파는 것만 */
const SELLABLE = sql`p.status IN ('selling', 'soldout')`;

/**
 * 수동 지정을 slug 목록으로 교체한다.
 *
 * 폼에서는 한 줄에 하나씩 slug 를 넣는다(상품 옵션·설문 항목과 같은 방식).
 * uuid 를 넣게 하면 운영자가 쓸 수 없고, 상품명을 쓰게 하면 같은 이름이
 * 여럿일 때 무엇을 가리키는지 알 수 없다. slug 는 유일하고 사람이 읽는다.
 *
 * **없는 slug 는 오류로 알려준다.** 조용히 버리면 운영자는 지정했다고
 * 믿는데 화면에는 안 나온다 — 오타를 영원히 못 찾는다.
 */
export async function syncRelated(
  db: Db,
  productId: string,
  text: string,
): Promise<{ count: number }> {
  const slugs = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 같은 slug 를 두 번 써도 한 번만 (PK 충돌 대신 조용히 정리한다 —
  // 운영자가 복사해 붙이면 흔한 일이고, 의도는 명확하다)
  const unique = [...new Set(slugs)];

  if (unique.length === 0) {
    await db.execute(sql`DELETE FROM shop_related_products WHERE product_id = ${productId}::uuid`);
    return { count: 0 };
  }

  if (unique.length > 50) throw new ShopError(400, "관련 상품은 50개까지 지정할 수 있습니다.");

  const list = sql.join(unique.map((s) => sql`${s}`), sql`, `);
  const { rows } = await db.execute(sql`
    SELECT id, slug FROM shop_products WHERE slug IN (${list})
  `);
  const bySlug = new Map(rows.map((r) => [String(r.slug), String(r.id)]));

  const missing = unique.filter((s) => !bySlug.has(s));
  if (missing.length) {
    throw new ShopError(400, `이런 주소(slug)의 상품이 없습니다: ${missing.join(", ")}`);
  }
  const self = unique.filter((s) => bySlug.get(s) === productId);
  if (self.length) throw new ShopError(400, "자기 자신을 관련 상품으로 지정할 수 없습니다.");

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM shop_related_products WHERE product_id = ${productId}::uuid`);
    // 입력한 순서를 유지한다 — 운영자가 위에 쓴 것을 먼저 보여주려 한 것이다
    for (const [i, slug] of unique.entries()) {
      await tx.execute(sql`
        INSERT INTO shop_related_products (product_id, related_id, sort_order)
        VALUES (${productId}::uuid, ${bySlug.get(slug)}::uuid, ${i})
      `);
    }
  });

  return { count: unique.length };
}

/** 폼에 되돌려 보여줄 텍스트 (한 줄에 slug 하나) */
export async function relatedText(db: Db, productId: string): Promise<string> {
  const { rows } = await db.execute(sql`
    SELECT p.slug FROM shop_related_products r
    JOIN shop_products p ON p.id = r.related_id
    WHERE r.product_id = ${productId}::uuid
    ORDER BY r.sort_order, p.name
  `);
  return rows.map((r) => String(r.slug)).join("\n");
}

/**
 * 상품 상세에 보여줄 관련 상품.
 *
 * 수동 지정 → 함께 구매 순으로 채운다. 이미 나온 상품은 다시 넣지 않는다.
 */
export async function listRelated(
  db: Db,
  productId: string,
  limit = RELATED_LIMIT,
): Promise<RelatedProduct[]> {
  const cap = Math.min(24, Math.max(1, Math.floor(limit)));

  const { rows: manual } = await db.execute(sql`
    SELECT p.id, p.slug, p.name, p.price, p.list_price, p.image_url, p.status
    FROM shop_related_products r
    JOIN shop_products p ON p.id = r.related_id
    WHERE r.product_id = ${productId}::uuid AND ${SELLABLE}
    ORDER BY r.sort_order, p.name
    LIMIT ${cap}
  `);

  const result: RelatedProduct[] = manual.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    price: Number(r.price),
    listPrice: r.list_price === null ? null : Number(r.list_price),
    imageUrl: r.image_url ? String(r.image_url) : null,
    status: String(r.status),
    source: "manual",
  }));

  if (result.length >= cap) return result;

  const exclude = [productId, ...result.map((r) => r.id)];
  const fill = await coPurchased(db, productId, cap - result.length, exclude);
  return [...result, ...fill];
}

/**
 * 함께 구매한 상품.
 *
 * "이 상품이 든 결제 완료 주문"을 찾아 그 주문의 다른 상품을 센다.
 *
 * 주문 수를 제한하는 이유(`LIMIT 500`): 많이 팔린 상품은 주문이 수만 건이고,
 * 전부 훑으면 상품 상세가 느려진다. **최근 주문 500건이면 추천 순서는 거의
 * 같다** — 오래된 주문일수록 지금의 함께 구매 경향과 멀다. 정확도보다
 * 상세 페이지 응답 시간이 중요하다(가장 많이 열리는 화면이다).
 */
export async function coPurchased(
  db: Db,
  productId: string,
  limit: number,
  exclude: string[] = [],
): Promise<RelatedProduct[]> {
  const cap = Math.min(24, Math.max(1, Math.floor(limit)));
  const excludeList = sql.join(
    [...new Set([productId, ...exclude])].map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const { rows } = await db.execute(sql`
    WITH src AS (
      -- 이 상품이 실제로 팔린 주문 (결제 완료 · 취소되지 않은 항목)
      SELECT oi.order_id
      FROM shop_order_items oi
      JOIN shop_orders o ON o.id = oi.order_id
      WHERE oi.product_id = ${productId}::uuid
        AND oi.quantity > oi.cancelled_qty
        AND o.paid_at IS NOT NULL
      ORDER BY o.paid_at DESC
      LIMIT 500
    )
    SELECT p.id, p.slug, p.name, p.price, p.list_price, p.image_url, p.status,
           count(DISTINCT oi.order_id) AS together
    FROM shop_order_items oi
    JOIN src ON src.order_id = oi.order_id
    JOIN shop_products p ON p.id = oi.product_id
    WHERE oi.product_id NOT IN (${excludeList})
      AND oi.quantity > oi.cancelled_qty
      AND ${SELLABLE}
    GROUP BY p.id, p.slug, p.name, p.price, p.list_price, p.image_url, p.status
    ORDER BY together DESC, p.sold_count DESC, p.name
    LIMIT ${cap}
  `);

  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    price: Number(r.price),
    listPrice: r.list_price === null ? null : Number(r.list_price),
    imageUrl: r.image_url ? String(r.image_url) : null,
    status: String(r.status),
    source: "copurchase",
  }));
}
