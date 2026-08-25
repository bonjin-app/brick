import { definePlugin } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

type Db = { execute(q: unknown): Promise<{ rows: Array<Record<string, unknown>> }> };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * brick-board — 게시판 플러그인 (Brick 플러그인 레퍼런스 구현).
 *
 *  - registerRoute  → /api/plugins/brick-board/* REST API (":param" 지원, 세션 user 주입)
 *  - registerBlock  → 페이지 빌더용 "최근 게시물" 블록 (서버 렌더 = SEO)
 *  - hooks          → 코어 이벤트 발행/구독
 */
export default definePlugin((ctx) => {
  const db = ctx.db as Db;

  // ── 게시판 관리 ─────────────────────────────────────
  ctx.registerRoute("GET", "/boards", async () => {
    const { rows } = await db.execute(sql`SELECT id, slug, title, description FROM board_boards ORDER BY created_at`);
    return rows;
  });

  ctx.registerRoute("POST", "/boards", async (req) => {
    if (req.user?.role !== "admin") throw new HttpError(403, "admin only");
    const { slug, title, description } = req.body as { slug: string; title: string; description?: string };
    if (!/^[a-z0-9-]{2,50}$/.test(slug ?? "")) throw new HttpError(400, "invalid slug");
    if (!title) throw new HttpError(400, "title required");
    const id = uuidv7();
    await db.execute(
      sql`INSERT INTO board_boards (id, slug, title, description) VALUES (${id}, ${slug}, ${title}, ${description ?? null})`,
    );
    return { id };
  });

  // ── 게시글 ─────────────────────────────────────────
  ctx.registerRoute("GET", "/boards/:slug/posts", async (req) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 20;
    const { rows } = await db.execute(sql`
      SELECT p.id, p.title, p.is_notice, p.view_count, p.created_at, u.display_name AS author,
        (SELECT count(*) FROM board_comments c WHERE c.post_id = p.id) AS comment_count
      FROM board_posts p
      JOIN board_boards b ON b.id = p.board_id
      LEFT JOIN users u ON u.id = p.author_id
      WHERE b.slug = ${req.params.slug}
      ORDER BY p.is_notice DESC, p.created_at DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}
    `);
    return { items: rows, page, pageSize: size };
  });

  ctx.registerRoute("POST", "/boards/:slug/posts", async (req) => {
    if (!req.user) throw new HttpError(401, "login required");
    const { title, content, category, isNotice } = req.body as {
      title: string; content: string; category?: string; isNotice?: boolean;
    };
    if (!title?.trim() || !content?.trim()) throw new HttpError(400, "title and content required");
    // 공지는 관리자만
    const notice = Boolean(isNotice) && req.user.role === "admin";
    const id = uuidv7();
    const { rows } = await db.execute(sql`
      INSERT INTO board_posts (id, board_id, author_id, title, content, category, is_notice)
      SELECT ${id}, b.id, ${req.user.id}, ${title}, ${content}, ${category ?? null}, ${notice}
      FROM board_boards b WHERE b.slug = ${req.params.slug}
      RETURNING id
    `);
    if (!rows.length) throw new HttpError(404, "board not found");
    await ctx.hooks.doAction("board.post.created", { postId: id, board: req.params.slug, authorId: req.user.id });
    return { id };
  });

  ctx.registerRoute("GET", "/posts/:id", async (req) => {
    const { rows } = await db.execute(sql`
      UPDATE board_posts SET view_count = view_count + 1
      WHERE id = ${req.params.id}
      RETURNING id, title, content, category, is_notice, view_count, created_at, author_id
    `);
    const post = rows[0];
    if (!post) throw new HttpError(404, "post not found");
    const { rows: comments } = await db.execute(sql`
      SELECT c.id, c.parent_id, c.content, c.created_at, u.display_name AS author
      FROM board_comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.post_id = ${req.params.id} ORDER BY c.created_at
    `);
    return { post, comments };
  });

  ctx.registerRoute("DELETE", "/posts/:id", async (req) => {
    if (!req.user) throw new HttpError(401, "login required");
    // 본인 글 또는 관리자만 삭제
    const { rows } = await db.execute(sql`
      DELETE FROM board_posts
      WHERE id = ${req.params.id} AND (author_id = ${req.user.id} OR ${req.user.role === "admin"})
      RETURNING id
    `);
    if (!rows.length) throw new HttpError(403, "not allowed");
    return { ok: true };
  });

  // ── 댓글 ───────────────────────────────────────────
  ctx.registerRoute("POST", "/posts/:id/comments", async (req) => {
    if (!req.user) throw new HttpError(401, "login required");
    const { content, parentId } = req.body as { content: string; parentId?: string };
    if (!content?.trim()) throw new HttpError(400, "content required");
    const id = uuidv7();
    await db.execute(sql`
      INSERT INTO board_comments (id, post_id, parent_id, author_id, content)
      VALUES (${id}, ${req.params.id}, ${parentId ?? null}, ${req.user.id}, ${content})
    `);
    return { id };
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
