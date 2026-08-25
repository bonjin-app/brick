import { definePlugin } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

type Db = { execute(q: unknown): Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * brick-board — 게시판 플러그인.
 *
 * 이 파일이 Brick 플러그인의 레퍼런스 구현이다:
 *  - registerRoute  → /api/plugins/brick-board/* REST API
 *  - registerBlock  → 페이지 빌더에서 쓰는 "최근 게시물" 블록 (서버 렌더 = SEO)
 *  - hooks          → 코어 이벤트 구독
 */
export default definePlugin((ctx) => {
  const db = ctx.db as Db;

  // ── REST API ─────────────────────────────────────────
  ctx.registerRoute("GET", "/boards", async () => {
    const { rows } = await db.execute(sql`SELECT id, slug, title, description FROM board_boards ORDER BY created_at`);
    return rows;
  });

  ctx.registerRoute("POST", "/boards", async (req) => {
    if (req.user?.role !== "admin") throw new Error("forbidden");
    const { slug, title, description } = req.body as { slug: string; title: string; description?: string };
    const id = uuidv7();
    await db.execute(
      sql`INSERT INTO board_boards (id, slug, title, description) VALUES (${id}, ${slug}, ${title}, ${description ?? null})`,
    );
    return { id };
  });

  ctx.registerRoute("GET", "/boards/:slug/posts", async (req) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 20;
    const { rows } = await db.execute(sql`
      SELECT p.id, p.title, p.is_notice, p.view_count, p.created_at, u.display_name AS author
      FROM board_posts p
      JOIN board_boards b ON b.id = p.board_id
      LEFT JOIN users u ON u.id = p.author_id
      WHERE b.slug = ${req.params.slug}
      ORDER BY p.is_notice DESC, p.created_at DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}
    `);
    return { items: rows, page, pageSize: size };
  });

  // ── 페이지 빌더 블록: 최근 게시물 (서버 렌더 → 검색엔진이 본다) ──
  ctx.registerBlock({
    name: "latest-posts",
    displayName: "최근 게시물",
    propsSchema: {
      type: "object",
      properties: {
        board: { type: "string", title: "게시판 slug" },
        limit: { type: "number", title: "표시 개수", default: 5 },
      },
    },
    render: async (props) => {
      const limit = Math.min(20, Number(props.limit ?? 5));
      const { rows } = await db.execute(sql`
        SELECT p.title, p.id, p.created_at FROM board_posts p
        JOIN board_boards b ON b.id = p.board_id
        WHERE b.slug = ${String(props.board ?? "")}
        ORDER BY p.created_at DESC LIMIT ${limit}
      `);
      const items = rows
        .map((r) => `<li><a href="/board/${props.board}/${r.id}">${escapeHtml(String(r.title))}</a></li>`)
        .join("");
      return `<ul class="brick-latest-posts">${items}</ul>`;
    },
  });

  ctx.registerAdminMenu({ label: "게시판", path: "/admin/plugins/brick-board" });

  return {};
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
