import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";
import { t } from "./i18n.js";

/**
 * 배송지 — 회원이 주문할 때마다 주소를 다시 적지 않게.
 *
 * 주문에는 주소를 **복사해** 둔다(shop_orders 가 이미 그렇게 저장한다).
 * 배송지를 나중에 고치거나 지워도 지난 주문의 배송지는 그대로여야 하기
 * 때문이다 — 참조로 이어 두면 "그때 어디로 보냈는지"가 사라진다.
 */
export interface AddressInput {
  label?: string;
  receiverName: string;
  receiverPhone: string;
  postcode: string;
  address1: string;
  address2?: string;
  isDefault?: boolean;
}

const MAX_ADDRESSES = 20;

/** 주문서와 **같은 규칙**으로 본다 — 여기서 통과한 주소로 주문이 막히면 안 된다 */
function validate(a: AddressInput): void {
  const required: Array<[keyof AddressInput, string]> = [
    ["receiverName", "addr.field.receiverName"],
    ["receiverPhone", "addr.field.receiverPhone"],
    ["postcode", "addr.field.postcode"],
    ["address1", "addr.field.address1"],
  ];
  for (const [key, labelKey] of required) {
    if (!String(a?.[key] ?? "").trim()) {
      throw new ShopError(400, t("order.required", { label: t(labelKey) }), String(key));
    }
  }
  if (!/^[0-9\-+() ]{7,30}$/.test(String(a.receiverPhone).trim())) {
    throw new ShopError(400, t("err.badPhone"), "receiverPhone");
  }
}

function row(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    label: String(r.label ?? ""),
    receiverName: String(r.receiver_name ?? ""),
    receiverPhone: String(r.receiver_phone ?? ""),
    postcode: String(r.postcode ?? ""),
    address1: String(r.address1 ?? ""),
    address2: String(r.address2 ?? ""),
    isDefault: Boolean(r.is_default),
  };
}

export async function listAddresses(db: Db, userId: string) {
  const { rows } = await db.execute(sql`
    SELECT id, label, receiver_name, receiver_phone, postcode, address1, address2, is_default
    FROM shop_addresses WHERE user_id = ${userId}::uuid
    ORDER BY is_default DESC, created_at DESC
  `);
  return rows.map(row);
}

export async function addAddress(db: Db, userId: string, input: AddressInput) {
  validate(input);
  const { rows: countRows } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_addresses WHERE user_id = ${userId}::uuid
  `);
  const count = Number(countRows[0]?.n ?? 0);
  if (count >= MAX_ADDRESSES) throw new ShopError(400, t("err.tooManyAddresses", { n: MAX_ADDRESSES }));

  /*
   * 첫 배송지는 **무조건 기본**이다. 기본이 없는 목록은 주문서가 고를 것이
   * 없어서 결국 손님이 다시 적게 된다 — 저장한 보람이 없다.
   */
  const isDefault = input.isDefault === true || count === 0;
  const id = uuidv7();
  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx.execute(sql`
        UPDATE shop_addresses SET is_default = false, updated_at = now()
        WHERE user_id = ${userId}::uuid AND is_default
      `);
    }
    await tx.execute(sql`
      INSERT INTO shop_addresses
        (id, user_id, label, receiver_name, receiver_phone, postcode, address1, address2, is_default)
      VALUES (${id}, ${userId}::uuid, ${String(input.label ?? "").slice(0, 30)},
              ${String(input.receiverName).trim().slice(0, 50)}, ${String(input.receiverPhone).trim().slice(0, 20)},
              ${String(input.postcode).trim().slice(0, 10)}, ${String(input.address1).trim().slice(0, 200)},
              ${String(input.address2 ?? "").trim().slice(0, 200)}, ${isDefault})
    `);
  });
  return { id, isDefault };
}

export async function updateAddress(db: Db, userId: string, id: string, input: AddressInput) {
  validate(input);
  const wantDefault = input.isDefault === true;
  const { rows } = await db.transaction(async (tx) => {
    if (wantDefault) {
      await tx.execute(sql`
        UPDATE shop_addresses SET is_default = false, updated_at = now()
        WHERE user_id = ${userId}::uuid AND is_default AND id <> ${id}::uuid
      `);
    }
    return await tx.execute(sql`
      UPDATE shop_addresses SET
        label = ${String(input.label ?? "").slice(0, 30)},
        receiver_name = ${String(input.receiverName).trim().slice(0, 50)},
        receiver_phone = ${String(input.receiverPhone).trim().slice(0, 20)},
        postcode = ${String(input.postcode).trim().slice(0, 10)},
        address1 = ${String(input.address1).trim().slice(0, 200)},
        address2 = ${String(input.address2 ?? "").trim().slice(0, 200)},
        is_default = ${wantDefault} OR is_default,
        updated_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
      RETURNING id
    `);
  });
  if (!rows.length) throw new ShopError(404, t("err.addressNotFound"));
  return { ok: true };
}

export async function removeAddress(db: Db, userId: string, id: string) {
  const { rows } = await db.execute(sql`
    DELETE FROM shop_addresses WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    RETURNING is_default
  `);
  if (!rows.length) throw new ShopError(404, t("err.addressNotFound"));
  /*
   * 기본 배송지를 지웠으면 **다음 것을 기본으로 올린다.**
   * 기본이 없는 목록은 주문서가 고를 것이 없어 손님이 다시 적게 된다.
   */
  if (rows[0].is_default) {
    await db.execute(sql`
      UPDATE shop_addresses SET is_default = true, updated_at = now()
      WHERE id = (
        SELECT id FROM shop_addresses WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC LIMIT 1
      )
    `);
  }
  return { ok: true };
}

export async function setDefaultAddress(db: Db, userId: string, id: string) {
  const { rows } = await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE shop_addresses SET is_default = false, updated_at = now()
      WHERE user_id = ${userId}::uuid AND is_default AND id <> ${id}::uuid
    `);
    return await tx.execute(sql`
      UPDATE shop_addresses SET is_default = true, updated_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
      RETURNING id
    `);
  });
  if (!rows.length) throw new ShopError(404, t("err.addressNotFound"));
  return { ok: true };
}

/**
 * 주문한 주소를 배송지로 남긴다 — 주문서의 "이 주소 저장" 이 부른다.
 *
 * **같은 주소면 새로 만들지 않는다.** 열 번 주문하면 같은 주소가 열 개가 되고,
 * 그 목록은 안 쓰느니만 못하다. 우편번호+주소+상세주소가 같으면 이미 있는 것이다.
 */
export async function rememberAddress(
  db: Db,
  userId: string,
  input: AddressInput,
): Promise<{ saved: boolean }> {
  const { rows } = await db.execute(sql`
    SELECT id FROM shop_addresses
    WHERE user_id = ${userId}::uuid
      AND postcode = ${String(input.postcode ?? "").trim()}
      AND address1 = ${String(input.address1 ?? "").trim()}
      AND address2 = ${String(input.address2 ?? "").trim()}
    LIMIT 1
  `);
  if (rows.length) return { saved: false };
  try {
    await addAddress(db, userId, input);
    return { saved: true };
  } catch {
    // 저장에 실패해도 **주문은 이미 끝났다** — 여기서 던지면 성공한 주문이 실패로 보인다
    return { saved: false };
  }
}
