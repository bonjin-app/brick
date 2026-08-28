/**
 * 기획전 — 상품을 묶어 보여주는 진열.
 *
 * 분류는 소속(하나뿐), 기획전은 진열(여럿 가능, 기간 있음).
 * 상품 지정은 관련 상품과 같은 방식이다 — slug 한 줄에 하나, 없는 slug 는
 * 오류로 알려준다(조용히 버리면 오타를 영원히 못 찾는다).
 */
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { isUniqueViolation } from "@brick/plugin-sdk";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,98}$/;

export interface CollectionSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isVisible: boolean;
  /** now 기준 상태 — 화면이 "예정/진행/종료" 를 보여준다 */
  state: "upcoming" | "active" | "ended";
  productCount: number;
}

function stateOf(startsAt: unknown, endsAt: unknown): "upcoming" | "active" | "ended" {
  const now = Date.now();
  if (startsAt && new Date(startsAt as Date).getTime() > now) return "upcoming";
  if (endsAt && new Date(endsAt as Date).getTime() < now) return "ended";
  return "active";
}

function validate(b: Record<string, unknown>) {
  const slug = String(b.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) throw new ShopError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");
  const title = String(b.title ?? "").trim();
  if (!title) throw new ShopError(400, "기획전 제목을 입력해주세요.");

  const date = (v: unknown): Date | null => {
    if (v === null || v === undefined || v === "") return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new ShopError(400, "날짜 형식이 올바르지 않습니다.");
    return d;
  };
  const startsAt = date(b.starts_at ?? b.startsAt);
  const endsAt = date(b.ends_at ?? b.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new ShopError(400, "종료가 시작보다 빠릅니다.");
  }

  return {
    slug, title, startsAt, endsAt,
    description: String(b.description ?? "").trim() || null,
    isVisible: b.is_visible !== false && b.isVisible !== false,
    sortOrder: Math.floor(Number(b.sort_order ?? b.sortOrder ?? 0)) || 0,
  };
}

/**
 * 상품 목록 텍스트(slug 한 줄에 하나) → 진열 순서대로 상품 id.
 * 없는 slug 는 오류 — 관련 상품과 같은 규칙.
 *
 * **쓰기 전에** 해석한다. 기획전 행을 먼저 INSERT 하고 나서 상품 오타로
 * 실패하면 반쪽짜리 기획전이 남고, 오타를 고쳐 다시 저장하면 "이미 사용
 * 중인 주소" 409 가 난다 — 스모크 테스트가 실제로 잡은 버그다.
 */
async function resolveItems(db: Db, text: string): Promise<Array<{ id: string; slug: string }>> {
  const slugs = [...new Set(
    String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
  )];
  if (slugs.length > 200) throw new ShopError(400, "기획전에는 200개까지 담을 수 있습니다.");
  if (!slugs.length) return [];

  const list = sql.join(slugs.map((s) => sql`${s}`), sql`, `);
  const { rows } = await db.execute(sql`
    SELECT id, slug FROM shop_products WHERE slug IN (${list})
  `);
  const bySlug = new Map(rows.map((r) => [String(r.slug), String(r.id)]));
  const missing = slugs.filter((s) => !bySlug.has(s));
  if (missing.length) {
    throw new ShopError(400, `이런 주소(slug)의 상품이 없습니다: ${missing.join(", ")}`);
  }
  return slugs.map((slug) => ({ id: bySlug.get(slug)!, slug }));
}

async function writeItems(
  tx: Db, collectionId: string, items: Array<{ id: string; slug: string }>,
): Promise<void> {
  await tx.execute(sql`DELETE FROM shop_collection_items WHERE collection_id = ${collectionId}::uuid`);
  for (const [i, item] of items.entries()) {
    await tx.execute(sql`
      INSERT INTO shop_collection_items (collection_id, product_id, sort_order)
      VALUES (${collectionId}::uuid, ${item.id}::uuid, ${i})
    `);
  }
}

export async function createCollection(db: Db, body: Record<string, unknown>): Promise<{ id: string }> {
  const c = validate(body);
  const items = await resolveItems(db, String(body.products_text ?? ""));
  const id = uuidv7();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO shop_collections (id, slug, title, description, starts_at, ends_at, is_visible, sort_order)
        VALUES (${id}, ${c.slug}, ${c.title}, ${c.description}, ${c.startsAt}, ${c.endsAt},
                ${c.isVisible}, ${c.sortOrder})
      `);
      await writeItems(tx, id, items);
    });
  } catch (err) {
    if (isUniqueViolation(err, "shop_collections_slug")) {
      throw new ShopError(409, `이미 사용 중인 주소(slug)입니다: ${c.slug}`);
    }
    throw err;
  }
  return { id };
}

export async function updateCollection(db: Db, id: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const c = validate(body);
  const items = await resolveItems(db, String(body.products_text ?? ""));
  try {
    await db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`
        UPDATE shop_collections SET slug = ${c.slug}, title = ${c.title}, description = ${c.description},
          starts_at = ${c.startsAt}, ends_at = ${c.endsAt}, is_visible = ${c.isVisible},
          sort_order = ${c.sortOrder}
        WHERE id = ${id}::uuid RETURNING id
      `);
      if (!rows.length) throw new ShopError(404, "기획전을 찾을 수 없습니다.");
      await writeItems(tx, id, items);
    });
  } catch (err) {
    if (isUniqueViolation(err, "shop_collections_slug")) {
      throw new ShopError(409, `이미 사용 중인 주소(slug)입니다: ${c.slug}`);
    }
    throw err;
  }
  return { ok: true };
}

export async function deleteCollection(db: Db, id: string): Promise<{ ok: true }> {
  await db.execute(sql`DELETE FROM shop_collections WHERE id = ${id}::uuid`);
  return { ok: true };
}

/** 관리자 목록 — 상태·상품 수 포함, products_text 되돌려 준다 (수정 저장이 지우지 않게) */
export async function listCollectionsAdmin(db: Db, page = 1) {
  const p = Math.max(1, Math.floor(page));
  const { rows } = await db.execute(sql`
    SELECT c.id, c.slug, c.title, c.description, c.starts_at, c.ends_at, c.is_visible, c.sort_order,
           coalesce((
             SELECT string_agg(pr.slug, E'\n' ORDER BY ci.sort_order)
             FROM shop_collection_items ci JOIN shop_products pr ON pr.id = ci.product_id
             WHERE ci.collection_id = c.id
           ), '') AS products_text,
           (SELECT count(*) FROM shop_collection_items ci WHERE ci.collection_id = c.id) AS n
    FROM shop_collections c
    ORDER BY c.sort_order, c.created_at DESC
    LIMIT 30 OFFSET ${(p - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_collections`);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      title: String(r.title),
      description: r.description ? String(r.description) : null,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      is_visible: r.is_visible === true,
      sort_order: Number(r.sort_order),
      products_text: String(r.products_text),
      product_count: Number(r.n),
      state_label: { upcoming: "예정", active: "진행 중", ended: "종료" }[stateOf(r.starts_at, r.ends_at)],
    })),
    total: Number(cnt[0]?.n ?? 0),
    page: p,
    pageSize: 30,
  };
}

/** 공개: 진행 중 기획전 목록 (예정·종료·숨김 제외) */
export async function activeCollections(db: Db): Promise<CollectionSummary[]> {
  const { rows } = await db.execute(sql`
    SELECT c.id, c.slug, c.title, c.description, c.starts_at, c.ends_at, c.is_visible,
           (SELECT count(*) FROM shop_collection_items ci WHERE ci.collection_id = c.id) AS n
    FROM shop_collections c
    WHERE c.is_visible = true
      AND (c.starts_at IS NULL OR c.starts_at <= now())
      AND (c.ends_at IS NULL OR c.ends_at >= now())
    ORDER BY c.sort_order, c.created_at DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    startsAt: (r.starts_at as Date | null) ?? null,
    endsAt: (r.ends_at as Date | null) ?? null,
    isVisible: true,
    state: "active" as const,
    productCount: Number(r.n),
  }));
}

/**
 * 공개: 기획전 하나 + 상품.
 *
 * 종료·예정이어도 **찾아는 진다** — 공유된 링크로 온 손님에게 404 대신
 * "종료된 기획전입니다"를 보여줘야 한다. 숨김은 404 다(운영자가 감춘 것).
 */
export async function viewCollection(db: Db, slug: string) {
  const { rows } = await db.execute(sql`
    SELECT id, slug, title, description, starts_at, ends_at, is_visible
    FROM shop_collections WHERE slug = ${String(slug ?? "")} LIMIT 1
  `);
  const c = rows[0];
  if (!c || c.is_visible !== true) return null;

  const state = stateOf(c.starts_at, c.ends_at);
  const { rows: products } = await db.execute(sql`
    SELECT p.slug, p.name, p.price, p.list_price, p.image_url, p.status
    FROM shop_collection_items ci
    JOIN shop_products p ON p.id = ci.product_id
    WHERE ci.collection_id = ${String(c.id)}::uuid
      AND p.status IN ('selling', 'soldout')
    ORDER BY ci.sort_order
  `);

  return {
    slug: String(c.slug),
    title: String(c.title),
    description: c.description ? String(c.description) : null,
    startsAt: (c.starts_at as Date | null) ?? null,
    endsAt: (c.ends_at as Date | null) ?? null,
    state,
    products: products.map((p) => ({
      slug: String(p.slug),
      name: String(p.name),
      price: Number(p.price),
      listPrice: p.list_price === null ? null : Number(p.list_price),
      imageUrl: p.image_url ? String(p.image_url) : null,
      soldout: String(p.status) === "soldout",
    })),
  };
}
