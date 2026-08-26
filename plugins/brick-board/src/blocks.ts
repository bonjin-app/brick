import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, hasRole, shortDate, type BoardRow, type Db } from "./types.js";
import { BOARD_CSS, BOARD_SCRIPT } from "./client-script.js";
import { renderDetail, renderList, renderWrite, resolveView } from "./views.js";

/**
 * 게시판 블록 — 페이지 빌더로 배치한다.
 *
 * 모두 서버 렌더이므로 검색엔진이 글을 그대로 읽는다.
 * 상호작용(에디터·댓글·추천)은 인라인 스크립트로 붙인다 —
 * 테마가 빌드를 타지 않으므로 프레임워크에 의존할 수 없다.
 */
export function registerBoardBlocks(ctx: PluginContext, db: Db): void {
  /** slug로 게시판 조회 (블록 렌더용 — 없으면 null) */
  async function findBoard(slug: string): Promise<BoardRow | null> {
    if (!slug) return null;
    const { rows } = await db.execute(sql`
      SELECT id, slug, title, description, read_role, write_role, comment_role, download_role,
             categories, page_size, allow_reply, allow_secret, allow_vote, allow_upload,
             max_files, write_interval
      FROM board_boards WHERE slug = ${slug} AND is_visible = true LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      ...(row as unknown as BoardRow),
      categories: Array.isArray(row.categories) ? (row.categories as string[]) : [],
    };
  }

  // ── 게시판 (목록 · 상세 · 글쓰기를 URL로 전환) ──────
  ctx.registerBlock({
    name: "board",
    displayName: "게시판",
    propsSchema: {
      type: "object",
      properties: {
        board: {
          type: "string",
          title: "게시판 slug",
          description: "페이지 주소를 'board/<slug>' 로 만들면 목록·상세·글쓰기가 모두 동작합니다",
        },
      },
    },
    render: async (props, ctx) => {
      const slug = String(props.board ?? "");
      const board = await findBoard(slug);
      if (!board) {
        return `<div class="brick-board"><p class="brick-board-empty">
  게시판을 찾을 수 없습니다. 블록 설정에서 slug를 확인하세요.</p></div>${BOARD_CSS}`;
      }

      // 읽기 권한을 통과하지 못하면 내용을 서버 렌더에 담지 않는다.
      // (비로그인 요청은 캐시되므로 담으면 유출된다)
      if (!hasRole(ctx.user, board.read_role)) {
        return `<div class="brick-board">
  <div class="brick-board-head"><h2>${escapeHtml(board.title)}</h2></div>
  <p class="brick-board-empty">이 게시판은 ${board.read_role === "member" ? "회원" : "운영자"}만 열람할 수 있습니다.
    ${!ctx.user ? `<a href="/login">로그인</a>` : ""}</p>
</div>${BOARD_CSS}`;
      }

      const { view, postId } = resolveView(ctx.pathTail);
      let html: string;
      if (view === "detail" && postId) {
        html = await renderDetail(db, board, postId, ctx);
      } else if (view === "write") {
        html = await renderWrite(db, board, ctx, postId);
      } else {
        html = await renderList(db, board, ctx);
      }
      return `${html}${BOARD_SCRIPT}${BOARD_CSS}`;
    },
  });

  // ── 게시판 목록 (카드) ─────────────────────────────
  ctx.registerBlock({
    name: "board-list",
    displayName: "게시판 목록",
    render: async (_props, ctx) => {
      const { rows } = await db.execute(sql`
        SELECT slug, title, description, read_role,
               (SELECT count(*) FROM board_posts p WHERE p.board_id = b.id) AS n
        FROM board_boards b WHERE is_visible = true ORDER BY sort_order, title
      `);
      // 읽을 수 없는 게시판은 목록에서 감춘다
      const visible = rows.filter((b) => hasRole(ctx.user, String(b.read_role)));
      if (!visible.length) return `<p class="brick-board-empty">공개된 게시판이 없습니다.</p>${BOARD_CSS}`;

      const items = visible
        .map(
          (b) => `  <a class="brick-board-card" href="/board/${encodeURIComponent(String(b.slug))}">
    <strong>${escapeHtml(b.title)}</strong>
    <span class="brick-board-count">${Number(b.n)}개의 글</span>
    ${b.description ? `<p>${escapeHtml(b.description)}</p>` : ""}
  </a>`,
        )
        .join("\n");
      return `<nav class="brick-board-cards">\n${items}\n</nav>${BOARD_CSS}`;
    },
  });

  // ── 최근 게시물 (위젯) ─────────────────────────────
  ctx.registerBlock({
    name: "latest-posts",
    displayName: "최근 게시물",
    propsSchema: {
      type: "object",
      properties: {
        board: { type: "string", title: "게시판 slug (비우면 전체)" },
        limit: { type: "number", title: "표시 개수", default: 5 },
        title: { type: "string", title: "제목 (비우면 표시 안 함)" },
        showDate: { type: "boolean", title: "날짜 표시", default: true },
      },
    },
    render: async (props, ctx) => {
      const limit = Math.min(30, Math.max(1, Number(props.limit ?? 5)));
      const slug = String(props.board ?? "");
      // 위젯은 어디에나 놓이므로 공개 게시판의 공개 글만 보여준다.
      // (로그인 사용자별로 달라지면 캐시가 복잡해지고 유출 위험이 생긴다)
      const { rows } = await db.execute(sql`
        SELECT p.id, p.title, p.created_at, p.comment_count, b.slug AS board_slug
        FROM board_posts p JOIN board_boards b ON b.id = p.board_id
        WHERE b.read_role = 'guest' AND b.is_visible = true
          AND p.is_secret = false
          AND (${slug} = '' OR b.slug = ${slug})
        ORDER BY p.created_at DESC LIMIT ${limit}
      `);
      if (!rows.length) return `<p class="brick-board-empty">게시물이 없습니다.</p>${BOARD_CSS}`;

      const items = rows
        .map(
          (r) => `    <li>
      <a href="/board/${encodeURIComponent(String(r.board_slug))}/${escapeHtml(r.id)}">${escapeHtml(r.title)}</a>
      ${Number(r.comment_count) > 0 ? `<span class="brick-cmt">[${Number(r.comment_count)}]</span>` : ""}
      ${props.showDate !== false ? `<time>${shortDate(r.created_at)}</time>` : ""}
    </li>`,
        )
        .join("\n");
      const heading = props.title ? `<h3 class="brick-widget-title">${escapeHtml(props.title)}</h3>` : "";
      return `${heading}<ul class="brick-latest-posts">\n${items}\n</ul>${BOARD_CSS}`;
    },
  });
}
