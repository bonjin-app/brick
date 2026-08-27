import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { HelpError } from "./types.js";

/**
 * FAQ.
 *
 * 왜 페이지 빌더로 만들지 않는가:
 *   할 수는 있다. 하지만 FAQ는 **검색되어야** 하고, 어떤 질문이 많이 읽히는지
 *   알아야 개선할 수 있다. 페이지 하나에 손으로 적어두면 둘 다 안 된다.
 *   그리고 문의가 들어올 때 "FAQ에 이미 있는지" 운영자가 찾아봐야 한다.
 */

export async function listFaqs(
  db: Db,
  params: { category?: string; q?: string; limit?: number },
) {
  const q = String(params.q ?? "").trim();
  const category = String(params.category ?? "");
  const limit = Math.min(200, Math.max(1, Number(params.limit ?? 100)));

  // 검색은 to_tsvector(simple) — 한국어는 형태소 사전이 없으므로
  // simple 사전 + ILIKE 를 함께 쓴다 (ADR-9 와 같은 판단)
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const { rows } = await db.execute(sql`
    SELECT f.id, f.question, f.answer, f.view_count, f.helpful_count, f.unhelpful_count,
           c.name AS category_name, c.slug AS category_slug
    FROM help_faqs f
    LEFT JOIN help_faq_categories c ON c.id = f.category_id
    WHERE f.is_visible = true
      AND (c.id IS NULL OR c.is_visible = true)
      AND (${category} = '' OR c.slug = ${category})
      AND (${q} = '' OR f.question ILIKE ${like} OR f.answer ILIKE ${like})
    ORDER BY c.sort_order NULLS LAST, f.sort_order, f.created_at
    LIMIT ${limit}
  `);
  return { items: rows };
}

export async function listCategories(db: Db) {
  const { rows } = await db.execute(sql`
    SELECT c.id, c.name, c.slug, c.sort_order,
           (SELECT count(*) FROM help_faqs f WHERE f.category_id = c.id AND f.is_visible) AS faq_count
    FROM help_faq_categories c WHERE c.is_visible = true
    ORDER BY c.sort_order, c.name
  `);
  return { items: rows };
}

/**
 * 조회수 증가.
 *
 * 상세 조회가 없는 구조(아코디언으로 펼침)라 클라이언트가 알려준다.
 * 정확한 수치가 목적이 아니라 "어떤 질문이 많이 읽히는가"의 순위이므로
 * 중복 방지를 하지 않는다 — 하려면 세션 저장이 필요하고 그 비용이 이득보다 크다.
 */
export async function markViewed(db: Db, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE help_faqs SET view_count = view_count + 1 WHERE id = ${id}::uuid
  `);
}

/**
 * 도움이 되었는가.
 *
 * 답변 품질을 측정하는 유일한 신호다. 로그인을 요구하지 않는다 —
 * 요구하면 아무도 누르지 않고, 그러면 신호가 아예 없다.
 * 조작될 수 있지만 절대값이 아니라 항목 간 비교에 쓰므로 견딘다.
 */
export async function rateFaq(db: Db, id: string, helpful: boolean): Promise<void> {
  const { rows } = await db.execute(
    helpful
      ? sql`UPDATE help_faqs SET helpful_count = helpful_count + 1 WHERE id = ${id}::uuid RETURNING id`
      : sql`UPDATE help_faqs SET unhelpful_count = unhelpful_count + 1 WHERE id = ${id}::uuid RETURNING id`,
  );
  if (!rows.length) throw new HelpError(404, "FAQ를 찾을 수 없습니다.");
}

/* ── 관리자 ────────────────────────────────────────── */

export async function listFaqsAdmin(db: Db, page: number) {
  const size = 30;
  const { rows } = await db.execute(sql`
    SELECT f.id, f.question, f.answer, f.sort_order, f.is_visible, f.view_count,
           f.helpful_count, f.unhelpful_count, f.category_id, c.name AS category_name
    FROM help_faqs f
    LEFT JOIN help_faq_categories c ON c.id = f.category_id
    ORDER BY c.sort_order NULLS LAST, f.sort_order, f.created_at
    LIMIT ${size} OFFSET ${(Math.max(1, page) - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM help_faqs`);
  return { items: rows, total: Number(cnt[0]?.n ?? 0), page: Math.max(1, page), pageSize: size };
}

export function validateFaq(b: Record<string, unknown>) {
  const question = String(b.question ?? "").trim();
  const answer = String(b.answer ?? "").trim();
  if (!question) throw new HelpError(400, "질문을 입력해주세요.");
  if (question.length > 500) throw new HelpError(400, "질문이 너무 깁니다. (500자 이내)");
  if (!answer) throw new HelpError(400, "답변을 입력해주세요.");
  return {
    question,
    answer,
    categoryId: b.category_id ? String(b.category_id) : null,
    sortOrder: Math.floor(Number(b.sort_order ?? 0)) || 0,
    isVisible: b.is_visible !== false,
  };
}

export async function createFaq(db: Db, b: Record<string, unknown>): Promise<{ id: string }> {
  const v = validateFaq(b);
  const id = uuidv7();
  await db.execute(sql`
    INSERT INTO help_faqs (id, category_id, question, answer, sort_order, is_visible)
    VALUES (${id}, ${v.categoryId ? sql`${v.categoryId}::uuid` : sql`NULL`},
            ${v.question}, ${v.answer}, ${v.sortOrder}, ${v.isVisible})
  `);
  return { id };
}

export async function updateFaq(db: Db, id: string, b: Record<string, unknown>): Promise<void> {
  const v = validateFaq(b);
  const { rows } = await db.execute(sql`
    UPDATE help_faqs SET
      category_id = ${v.categoryId ? sql`${v.categoryId}::uuid` : sql`NULL`},
      question = ${v.question}, answer = ${v.answer},
      sort_order = ${v.sortOrder}, is_visible = ${v.isVisible}, updated_at = now()
    WHERE id = ${id}::uuid RETURNING id
  `);
  if (!rows.length) throw new HelpError(404, "FAQ를 찾을 수 없습니다.");
}

export async function deleteFaq(db: Db, id: string): Promise<void> {
  const { rows } = await db.execute(sql`
    DELETE FROM help_faqs WHERE id = ${id}::uuid RETURNING id
  `);
  if (!rows.length) throw new HelpError(404, "FAQ를 찾을 수 없습니다.");
}

export async function listCategoriesAdmin(db: Db) {
  const { rows } = await db.execute(sql`
    SELECT id, name, slug, sort_order, is_visible FROM help_faq_categories
    ORDER BY sort_order, name
  `);
  return { items: rows, total: rows.length, page: 1, pageSize: rows.length || 1 };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,98}$/;

export function validateCategory(b: Record<string, unknown>) {
  const name = String(b.name ?? "").trim();
  const slug = String(b.slug ?? "").trim();
  if (!name) throw new HelpError(400, "분류명을 입력해주세요.");
  if (!SLUG_RE.test(slug)) {
    throw new HelpError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");
  }
  return {
    name,
    slug,
    sortOrder: Math.floor(Number(b.sort_order ?? 0)) || 0,
    isVisible: b.is_visible !== false,
  };
}
