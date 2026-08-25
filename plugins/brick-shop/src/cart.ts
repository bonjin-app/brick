import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/** 장바구니 소유자 — 회원이면 userId, 비회원이면 guestToken */
export interface CartOwner {
  userId?: string | null;
  guestToken?: string | null;
}

async function findOrCreateCart(db: Db, owner: CartOwner): Promise<string> {
  if (!owner.userId && !owner.guestToken) throw new ShopError(400, "장바구니를 식별할 수 없습니다.");

  const where = owner.userId
    ? sql`user_id = ${owner.userId}::uuid`
    : sql`guest_token = ${owner.guestToken}`;
  const { rows } = await db.execute(sql`SELECT id FROM shop_carts WHERE ${where} LIMIT 1`);
  if (rows[0]) return String(rows[0].id);

  const id = uuidv7();
  await db.execute(sql`
    INSERT INTO shop_carts (id, user_id, guest_token)
    VALUES (${id}, ${owner.userId ?? null}::uuid, ${owner.userId ? null : owner.guestToken})
    ON CONFLICT DO NOTHING
  `);
  // 경합으로 다른 요청이 먼저 만들었을 수 있다
  const { rows: again } = await db.execute(sql`SELECT id FROM shop_carts WHERE ${where} LIMIT 1`);
  if (!again[0]) throw new ShopError(500, "장바구니를 만들 수 없습니다.");
  return String(again[0].id);
}

export async function addToCart(
  db: Db,
  owner: CartOwner,
  input: { productId: string; optionId?: string | null; quantity?: number },
): Promise<{ cartId: string }> {
  const qty = Math.floor(Number(input.quantity ?? 1));
  if (!Number.isFinite(qty) || qty < 1 || qty > 999) throw new ShopError(400, "수량은 1~999 사이여야 합니다.");

  const { rows } = await db.execute(sql`
    SELECT status FROM shop_products WHERE id = ${input.productId}::uuid LIMIT 1
  `);
  if (!rows[0]) throw new ShopError(404, "상품을 찾을 수 없습니다.");
  if (rows[0].status !== "selling") throw new ShopError(400, "현재 구매할 수 없는 상품입니다.");

  const cartId = await findOrCreateCart(db, owner);
  // 같은 상품+옵션이면 수량을 합친다 (유니크 인덱스 + ON CONFLICT)
  await db.execute(sql`
    INSERT INTO shop_cart_items (id, cart_id, product_id, option_id, quantity)
    VALUES (${uuidv7()}, ${cartId}::uuid, ${input.productId}::uuid, ${input.optionId ?? null}::uuid, ${qty})
    ON CONFLICT (cart_id, product_id, coalesce(option_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET quantity = least(999, shop_cart_items.quantity + ${qty})
  `);
  await db.execute(sql`UPDATE shop_carts SET updated_at = now() WHERE id = ${cartId}::uuid`);
  return { cartId };
}

export async function getCartItems(
  db: Db,
  owner: CartOwner,
): Promise<Array<{ id: string; productId: string; optionId: string | null; quantity: number }>> {
  const where = owner.userId
    ? sql`c.user_id = ${owner.userId}::uuid`
    : sql`c.guest_token = ${owner.guestToken ?? ""}`;
  const { rows } = await db.execute(sql`
    SELECT i.id, i.product_id, i.option_id, i.quantity
    FROM shop_cart_items i
    JOIN shop_carts c ON c.id = i.cart_id
    WHERE ${where}
    ORDER BY i.created_at
  `);
  return rows.map((r) => ({
    id: String(r.id),
    productId: String(r.product_id),
    optionId: r.option_id ? String(r.option_id) : null,
    quantity: Number(r.quantity),
  }));
}

export async function updateCartItem(
  db: Db,
  owner: CartOwner,
  itemId: string,
  quantity: number,
): Promise<void> {
  const qty = Math.floor(Number(quantity));
  const where = owner.userId
    ? sql`c.user_id = ${owner.userId}::uuid`
    : sql`c.guest_token = ${owner.guestToken ?? ""}`;

  if (qty < 1) {
    await db.execute(sql`
      DELETE FROM shop_cart_items i USING shop_carts c
      WHERE i.cart_id = c.id AND i.id = ${itemId}::uuid AND ${where}
    `);
    return;
  }
  if (qty > 999) throw new ShopError(400, "수량은 999개까지 가능합니다.");
  const { rows } = await db.execute(sql`
    UPDATE shop_cart_items i SET quantity = ${qty}
    FROM shop_carts c
    WHERE i.cart_id = c.id AND i.id = ${itemId}::uuid AND ${where}
    RETURNING i.id
  `);
  if (!rows.length) throw new ShopError(404, "장바구니 항목을 찾을 수 없습니다.");
}

export async function clearCart(db: Db, owner: CartOwner): Promise<void> {
  const where = owner.userId
    ? sql`c.user_id = ${owner.userId}::uuid`
    : sql`c.guest_token = ${owner.guestToken ?? ""}`;
  await db.execute(sql`
    DELETE FROM shop_cart_items i USING shop_carts c WHERE i.cart_id = c.id AND ${where}
  `);
}
