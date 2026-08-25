import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, humanSize, shortDate, type Db } from "./types.js";

/**
 * 게시판 블록 — 페이지 빌더로 배치한다.
 *
 * 모두 서버 렌더이므로 검색엔진이 글을 그대로 읽는다.
 * 상호작용(글쓰기 폼, 추천, 댓글)은 인라인 스크립트로 처리한다 —
 * 테마가 빌드를 타지 않으므로 프레임워크에 의존할 수 없다.
 */
export function registerBoardBlocks(ctx: PluginContext, db: Db): void {
  // ── 게시판 목록 ────────────────────────────────────
  ctx.registerBlock({
    name: "board-list",
    displayName: "게시판 목록",
    render: async () => {
      const { rows } = await db.execute(sql`
        SELECT slug, title, description,
               (SELECT count(*) FROM board_posts p WHERE p.board_id = b.id) AS n
        FROM board_boards b
        WHERE is_visible = true AND read_role = 'guest'
        ORDER BY sort_order, title
      `);
      if (!rows.length) return `<p class="brick-board-empty">공개된 게시판이 없습니다.</p>`;
      const items = rows
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
    render: async (props) => {
      const limit = Math.min(30, Math.max(1, Number(props.limit ?? 5)));
      const slug = String(props.board ?? "");
      const { rows } = await db.execute(sql`
        SELECT p.id, p.title, p.created_at, p.comment_count, b.slug AS board_slug
        FROM board_posts p JOIN board_boards b ON b.id = p.board_id
        WHERE b.read_role = 'guest' AND b.is_visible = true
          AND p.is_secret = false
          AND (${slug} = '' OR b.slug = ${slug})
        ORDER BY p.created_at DESC LIMIT ${limit}
      `);
      if (!rows.length) return `<p class="brick-board-empty">게시물이 없습니다.</p>`;

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

  // ── 게시판 (목록 + 검색 + 글쓰기 링크) ──────────────
  ctx.registerBlock({
    name: "board",
    displayName: "게시판",
    propsSchema: {
      type: "object",
      properties: {
        board: { type: "string", title: "게시판 slug", description: "비우면 주소에서 읽습니다" },
      },
    },
    render: async (props) => {
      const slug = String(props.board ?? "");
      if (!slug) {
        return `<p class="brick-board-empty">블록 설정에서 게시판 slug를 지정하세요.</p>`;
      }
      const { rows: boards } = await db.execute(sql`
        SELECT id, slug, title, description, read_role, write_role, categories, page_size
        FROM board_boards WHERE slug = ${slug} AND is_visible = true LIMIT 1
      `);
      const board = boards[0];
      if (!board) return `<p class="brick-board-empty">게시판을 찾을 수 없습니다.</p>`;

      // 비공개 게시판은 서버 렌더에 내용을 담지 않는다 (캐시에 남으면 유출된다).
      // 대신 클라이언트가 로그인 상태로 API를 호출한다.
      if (board.read_role !== "guest") {
        return `<div class="brick-board" data-board="${escapeHtml(board.slug)}" data-private="1">
  <h2>${escapeHtml(board.title)}</h2>
  <p class="brick-board-empty">로그인이 필요한 게시판입니다.</p>
</div>${BOARD_SCRIPT}${BOARD_CSS}`;
      }

      const size = Number(board.page_size);
      const { rows: notices } = await db.execute(sql`
        SELECT id, title, author_name, created_at, view_count, comment_count, file_count
        FROM board_posts WHERE board_id = ${String(board.id)}::uuid AND is_notice = true
        ORDER BY created_at DESC LIMIT 5
      `);
      const { rows: posts } = await db.execute(sql`
        SELECT id, title, category, author_name, created_at, view_count, comment_count,
               file_count, up_count, is_secret, depth
        FROM board_posts
        WHERE board_id = ${String(board.id)}::uuid AND is_notice = false
        ORDER BY thread_created_at DESC, thread_path ASC LIMIT ${size}
      `);
      const { rows: cnt } = await db.execute(sql`
        SELECT count(*) AS n FROM board_posts
        WHERE board_id = ${String(board.id)}::uuid AND is_notice = false
      `);

      const cats = Array.isArray(board.categories) ? (board.categories as string[]) : [];
      const row = (p: Record<string, unknown>, notice: boolean) => {
        const depth = Number(p.depth ?? 0);
        // 답변형은 들여쓰기로 계층을 보여준다 (그누보드와 같은 표현)
        const indent = depth > 0 ? `<span class="brick-reply-mark" style="--d:${depth}">↳</span>` : "";
        return `      <tr${notice ? ' class="brick-notice"' : ""}>
        <td class="brick-c-num">${notice ? "공지" : ""}</td>
        <td class="brick-c-title">
          ${p.category ? `<span class="brick-cat">${escapeHtml(p.category)}</span>` : ""}
          ${indent}
          <a href="/board/${encodeURIComponent(String(board.slug))}/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a>
          ${p.is_secret ? `<span class="brick-lock" title="비밀글">🔒</span>` : ""}
          ${Number(p.comment_count) > 0 ? `<span class="brick-cmt">[${Number(p.comment_count)}]</span>` : ""}
          ${Number(p.file_count) > 0 ? `<span class="brick-clip" title="첨부파일">📎</span>` : ""}
        </td>
        <td class="brick-c-author">${escapeHtml(p.author_name ?? "-")}</td>
        <td class="brick-c-date">${shortDate(p.created_at)}</td>
        <td class="brick-c-view">${Number(p.view_count)}</td>
      </tr>`;
      };

      const catNav = cats.length
        ? `  <nav class="brick-cat-nav">
    <a href="?" class="is-active">전체</a>
    ${cats.map((c) => `<a href="?category=${encodeURIComponent(c)}">${escapeHtml(c)}</a>`).join("\n    ")}
  </nav>`
        : "";

      return `<div class="brick-board" data-board="${escapeHtml(board.slug)}">
  <div class="brick-board-head">
    <h2>${escapeHtml(board.title)}</h2>
    <span class="brick-board-total">${Number(cnt[0]?.n ?? 0)}개의 글</span>
  </div>
  ${board.description ? `<p class="brick-board-desc">${escapeHtml(board.description)}</p>` : ""}
${catNav}
  <table class="brick-board-table">
    <thead>
      <tr><th class="brick-c-num"></th><th>제목</th><th class="brick-c-author">작성자</th>
          <th class="brick-c-date">날짜</th><th class="brick-c-view">조회</th></tr>
    </thead>
    <tbody>
${notices.map((p) => row(p, true)).join("\n")}
${posts.map((p) => row(p, false)).join("\n")}
${!notices.length && !posts.length ? `      <tr><td colspan="5" class="brick-board-empty">첫 글을 작성해보세요.</td></tr>` : ""}
    </tbody>
  </table>

  <form class="brick-board-search" method="get">
    <select name="in">
      <option value="all">전체</option>
      <option value="title">제목</option>
      <option value="content">내용</option>
      <option value="author">작성자</option>
    </select>
    <input type="search" name="q" placeholder="검색어" />
    <button type="submit">검색</button>
    <a class="brick-write-btn" href="/board/${encodeURIComponent(String(board.slug))}/write">글쓰기</a>
  </form>
</div>${BOARD_SCRIPT}${BOARD_CSS}`;
    },
  });
}

/* ── 스타일: 테마가 빌드를 타지 않으므로 블록이 함께 낸다 ── */
const BOARD_CSS = `
<style>
.brick-board{margin:20px 0}
.brick-board-head{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid var(--color-text,#1a1a1a);padding-bottom:10px}
.brick-board-head h2{margin:0;font-size:22px}
.brick-board-total{color:#888;font-size:13px}
.brick-board-desc{color:#666;font-size:14px;margin:10px 0}
.brick-cat-nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.brick-cat-nav a{padding:5px 12px;border:1px solid #e3e3ea;border-radius:16px;text-decoration:none;color:inherit;font-size:13px}
.brick-cat-nav a.is-active{background:var(--color-primary,#d0402c);color:#fff;border-color:transparent}
.brick-board-table{width:100%;border-collapse:collapse;font-size:14px}
.brick-board-table th{padding:10px 8px;border-bottom:1px solid #ddd;color:#666;font-weight:600;font-size:13px}
.brick-board-table td{padding:11px 8px;border-bottom:1px solid #f0f0f4}
.brick-board-table a{color:inherit;text-decoration:none}
.brick-board-table a:hover{text-decoration:underline}
.brick-notice{background:#fafafc}
.brick-notice .brick-c-num{color:var(--color-primary,#d0402c);font-weight:700;font-size:12px}
.brick-c-num{width:52px;text-align:center;color:#aaa;font-size:12px}
.brick-c-author{width:110px;color:#666}
.brick-c-date{width:60px;color:#999;font-size:13px;text-align:center}
.brick-c-view{width:56px;color:#999;font-size:13px;text-align:center}
.brick-cat{display:inline-block;padding:1px 7px;margin-right:5px;background:#f0f0f4;border-radius:10px;font-size:11.5px;color:#666}
.brick-reply-mark{color:#aaa;margin-right:4px;margin-left:calc((var(--d,1) - 1) * 14px)}
.brick-cmt{color:var(--color-primary,#d0402c);font-size:12.5px;margin-left:4px;font-weight:600}
.brick-clip,.brick-lock{font-size:12px;margin-left:3px}
.brick-board-search{display:flex;gap:6px;margin-top:18px;align-items:center;flex-wrap:wrap}
.brick-board-search select,.brick-board-search input{padding:8px;border:1px solid #ddd;border-radius:6px}
.brick-board-search button{padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer}
.brick-write-btn{margin-left:auto;padding:9px 20px;background:var(--color-primary,#d0402c);color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}
.brick-board-empty{padding:36px;text-align:center;color:#999}
.brick-board-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:18px 0}
.brick-board-card{display:block;padding:18px;border:1px solid #e8e8ee;border-radius:10px;text-decoration:none;color:inherit}
.brick-board-card strong{display:block;font-size:16px}
.brick-board-count{color:#999;font-size:12.5px}
.brick-board-card p{margin:8px 0 0;color:#666;font-size:13.5px}
.brick-latest-posts{list-style:none;padding:0;margin:10px 0}
.brick-latest-posts li{display:flex;align-items:baseline;gap:6px;padding:6px 0;border-bottom:1px solid #f4f4f7}
.brick-latest-posts a{color:inherit;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brick-latest-posts time{color:#aaa;font-size:12.5px}
.brick-widget-title{font-size:16px;margin:0 0 4px}
</style>`;

/* ── 비공개 게시판을 클라이언트에서 불러오는 스크립트 ── */
const BOARD_SCRIPT = `
<script>
(function(){
  var el = document.querySelector('.brick-board[data-private="1"]');
  if (!el) return;
  var slug = el.dataset.board;
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  fetch('/api/plugins/brick-board/boards/' + encodeURIComponent(slug) + '/posts')
    .then(function(r){
      if (r.status === 401) throw new Error('로그인이 필요합니다.');
      if (r.status === 403) throw new Error('열람 권한이 없습니다.');
      if (!r.ok) throw new Error('목록을 불러올 수 없습니다.');
      return r.json();
    })
    .then(function(d){
      var all = (d.notices || []).concat(d.items || []);
      if (!all.length) {
        el.querySelector('.brick-board-empty').textContent = '첫 글을 작성해보세요.';
        return;
      }
      var rows = all.map(function(p){
        return '<tr><td class="brick-c-num"></td><td class="brick-c-title">' +
          '<a href="/board/' + encodeURIComponent(slug) + '/' + esc(p.id) + '">' + esc(p.title) + '</a>' +
          (p.comment_count > 0 ? '<span class="brick-cmt">[' + p.comment_count + ']</span>' : '') +
          '</td><td class="brick-c-author">' + esc(p.author_name || '-') + '</td>' +
          '<td class="brick-c-view">' + (p.view_count || 0) + '</td></tr>';
      }).join('');
      el.querySelector('.brick-board-empty').outerHTML =
        '<table class="brick-board-table"><thead><tr><th class="brick-c-num"></th><th>제목</th>' +
        '<th class="brick-c-author">작성자</th><th class="brick-c-view">조회</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    })
    .catch(function(e){
      el.querySelector('.brick-board-empty').textContent = e.message;
    });
})();
</script>`;

export { humanSize };
