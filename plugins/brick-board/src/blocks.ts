import { dateScript, STACK_TABLE_CSS } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { effectiveReadRole, escapeHtml, hasRole, shortDate, PUBLIC_POST_SQL, type BoardRow, type Db } from "./types.js";
import { BOARD_CSS, boardScript } from "./client-script.js";
import { renderDetail, renderList, renderWrite, resolveView } from "./views.js";
import { bindI18n, t } from "./i18n.js";
import { boardActor, certBlock, selectBoard } from "./access.js";

/**
 * 게시판 블록 — 페이지 빌더로 배치한다.
 *
 * 모두 서버 렌더이므로 검색엔진이 글을 그대로 읽는다.
 * 상호작용(에디터·댓글·추천)은 인라인 스크립트로 붙인다 —
 * 테마가 빌드를 타지 않으므로 프레임워크에 의존할 수 없다.
 */
export function registerBoardBlocks(pluginCtx: PluginContext, db: Db): void {
  const ctx = pluginCtx;
  bindI18n(ctx);

  /** slug로 게시판 조회 (블록 렌더용 — 없으면 null) */
  /** 블록이 쓰는 게시판 조회 — 질의는 access.ts 하나뿐이다 (복사본이 어긋났던 적이 있다) */
  const findBoard = (slug: string): Promise<BoardRow | null> => selectBoard(db, slug);



  // ── 게시판 (목록 · 상세 · 글쓰기를 URL로 전환) ──────
  ctx.registerBlock({
    name: "board",
    displayName: "게시판",
    propsSchema: {
      type: "object",
      properties: {
        board: {
          type: "string",
          title: "게시판 slug (비우면 주소에서)",
          description:
            "지정하면 이 페이지가 그 게시판 전용이 됩니다. 비우면 주소의 다음 " +
            "구간을 게시판 slug 로 씁니다 — 'board' 페이지 하나로 모든 게시판이 동작합니다.",
        },
        listStyle: {
          type: "string",
          title: "목록 스킨 (비우면 게시판 설정) — basic / gallery / webzine",
        },
      },
    },
    render: async (props, ctx) => {
      /**
       * 게시판 결정 — 고정(prop) 또는 주소에서(pathTail 라우팅).
       *
       * 고정 방식만 있으면 **게시판마다 페이지를 만들어야** 하고, 스타터와
       * 메뉴가 가리키는 /board/notice 는 board/notice 페이지가 없으면 404 다.
       * pathTail 라우팅이면 'board' 페이지 하나로 모든 게시판이 열린다.
       * prop 을 지정한 기존 페이지는 그대로 동작한다 (tail 전체가 글 경로).
       */
      let slug = String(props.board ?? "");
      let tail = ctx.pathTail;
      /**
       * 고정 게시판(prop)으로 끼운 블록은 **위젯**이다 — 홈에 갤러리를 놓는 식이다.
       * 그 목록이 페이지 제목을 가져가면 홈의 문서 제목이 "갤러리"가 된다(실제로 그랬다).
       * 목록일 때만 그렇다: 상세·글쓰기는 화면이 그 글이므로 여전히 제목을 정한다.
       */
      const embedded = Boolean(slug);
      if (!slug) {
        const segments = ctx.pathTail.split("/").filter(Boolean);
        slug = segments[0] ?? "";
        tail = segments.slice(1).join("/");
        if (!slug) {
          // /board 루트 — 게시판 목록을 보여준다 (빈 화면보다 낫다)
          return renderBoardIndex(db, ctx.user);
        }
      }
      const board = await findBoard(slug);
      if (!board) {
        return `<div class="brick-board"><p class="brick-board-empty">
  ${escapeHtml(t("board.notFound"))}</p></div>${BOARD_CSS}`;
      }
      // 이 게시판의 관리자면 이 화면 안에서 운영진처럼(수정·삭제 단추, 비밀글, 공지 칸) — API 의 집행과 같은 규칙
      ctx = { ...ctx, user: boardActor(ctx.user as never, board) as never };

      // 읽기 권한을 통과하지 못하면 내용을 서버 렌더에 담지 않는다.
      // (비로그인 요청은 캐시되므로 담으면 유출된다)
      if (!hasRole(ctx.user, board.read_role)) {
        return `<div class="brick-board">
  <div class="brick-board-head"><h1>${escapeHtml(board.title)}</h1></div>
  <p class="brick-board-empty">${escapeHtml(board.read_role === "member" ? t("board.readMember") : t("board.readManager"))}
    ${!ctx.user ? `<a href="/login">${escapeHtml(t("common.login"))}</a>` : ""}</p>
</div>${BOARD_CSS}`;
      }

      /*
       * 본인인증·성인 인증을 요구하는 게시판 — 확인 전에는 목록·글·쓰기 화면을 그리지 않는다.
       * 비로그인 화면은 캐시되지만 비회원은 언제나 이 안내를 보므로 섞이지 않는다.
       */
      const blocked = await certBlock(board, ctx.user as never, (id) => pluginCtx.identity.status(id));
      if (blocked) {
        const back = `/board/${encodeURIComponent(board.slug)}`;
        const verifyUrl = pluginCtx.identity.url(back);
        const action = blocked.login
          ? `<a class="brick-primary" href="/login?next=${encodeURIComponent(verifyUrl)}">${escapeHtml(t("cert.loginAndVerify"))}</a>`
          : blocked.verify
            ? `<a class="brick-primary" href="${escapeHtml(verifyUrl)}">${escapeHtml(t("cert.verify"))}</a>`
            : "";
        return `<div class="brick-board">
  <div class="brick-board-head"><h1>${escapeHtml(board.title)}</h1></div>
  <p class="brick-board-empty">${escapeHtml(t(blocked.key))}</p>
  ${action ? `<p class="brick-board-empty">${action}</p>` : ""}
</div>${BOARD_CSS}`;
      }

      const { view, postId } = resolveView(tail);
      let html: string;
      if (view === "detail" && postId) {
        html = await renderDetail(db, board, postId, ctx, pluginCtx.storage);
      } else if (view === "write") {
        // 글쓰기 화면의 제목은 게시판 이름 + 무엇을 하는 화면인지
        ctx.setSeo?.({ title: `${board.title} — ${t("write.title")}`, ownHeading: true });
        html = await renderWrite(db, board, ctx, postId);
      } else {
        /**
         * 목록 화면의 제목은 게시판 이름이다. 라우터 페이지 제목("게시판")이
         * 그대로 쓰이면 게시판이 몇 개든 문서 제목이 하나가 된다.
         */
        if (!embedded) {
          ctx.setSeo?.({ title: board.title, description: board.description ?? undefined, ownHeading: true });
        }
        html = await renderList(db, board, ctx, {
          listStyle: props.listStyle ? String(props.listStyle) : undefined,
          embedded,
        });
      }
      return `${html}${boardScript()}${BOARD_CSS}`;
    },
  });

  /** /board 루트 — 열람 가능한 게시판 목록 */
  async function renderBoardIndex(database: Db, viewer: { id: string; role: string } | null): Promise<string> {
    const { rows } = await database.execute(sql`
      SELECT b.slug, b.title, b.description, b.read_role, g.title AS group_title, g.read_role AS group_read_role,
             g.sort_order AS group_order
      FROM board_boards b LEFT JOIN board_groups g ON g.id = b.group_id
      WHERE b.is_visible = true
      ORDER BY g.sort_order NULLS LAST, g.title NULLS LAST, b.sort_order, b.title
    `);
    // 읽을 수 없는 게시판(그룹 권한 포함)은 목록에서 감춘다
    const visible = rows.filter((b) => hasRole(viewer, effectiveReadRole(b.read_role, b.group_read_role)));
    if (!visible.length) {
      return `<div class="brick-board"><p class="brick-board-empty">${escapeHtml(t("index.empty"))}</p></div>${BOARD_CSS}`;
    }
    /**
     * 그룹별 소제목 — 그룹이 하나도 없으면 소제목 없이 그린다(그룹을 안 쓰는 사이트에
     * "기타"라는 제목이 뜨면 이상하다). 그룹이 있으면 그룹 없는 게시판은 마지막에 묶는다.
     */
    const item = (b: Record<string, unknown>) => `<a class="brick-board-index-item" href="/board/${encodeURIComponent(String(b.slug))}">
  <strong>${escapeHtml(b.title)}</strong>
  ${b.description ? `<span>${escapeHtml(b.description)}</span>` : ""}
</a>`;
    const anyGroup = visible.some((b) => b.group_title);
    let body: string;
    if (!anyGroup) {
      body = `<div class="brick-board-index">${visible.map(item).join("")}</div>`;
    } else {
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const b of visible) {
        const key = b.group_title ? String(b.group_title) : "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(b);
      }
      body = [...groups.entries()]
        .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0))
        .map(([title, list]) => `<section class="brick-board-group">
  <h2>${escapeHtml(title || t("index.ungrouped"))}</h2>
  <div class="brick-board-index">${list.map(item).join("")}</div>
</section>`).join("");
    }
    return `<div class="brick-board">${body}</div>
<style>.brick-board-index{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.brick-board-index-item{display:block;padding:16px;border:1px solid var(--color-line,#e4e4ea);border-radius:var(--radius-lg, 10px);text-decoration:none;color:inherit}
.brick-board-index-item span{display:block;color:var(--color-muted, #6c6c7a);font-size:13px;margin-top:4px}
.brick-board-group{margin:0 0 28px}.brick-board-group h2{font-size:17px;margin:0 0 10px;letter-spacing:-.3px}</style>${BOARD_CSS}`;
  }

  // ── 게시판 목록 (카드) ─────────────────────────────
  ctx.registerBlock({
    name: "board-list",
    displayName: "게시판 목록",
    render: async (_props, ctx) => {
      const { rows } = await db.execute(sql`
        SELECT b.slug, b.title, b.description, b.read_role, g.read_role AS group_read_role,
               (SELECT count(*) FROM board_posts p WHERE p.board_id = b.id) AS n
        FROM board_boards b LEFT JOIN board_groups g ON g.id = b.group_id
        WHERE b.is_visible = true ORDER BY g.sort_order NULLS LAST, b.sort_order, b.title
      `);
      // 읽을 수 없는 게시판(그룹 권한 포함)은 목록에서 감춘다
      const visible = rows.filter((b) => hasRole(ctx.user, effectiveReadRole(b.read_role, b.group_read_role)));
      if (!visible.length) return `<p class="brick-board-empty">${escapeHtml(t("cards.empty"))}</p>${BOARD_CSS}`;

      const items = visible
        .map(
          (b) => `  <a class="brick-board-card" href="/board/${encodeURIComponent(String(b.slug))}">
    <strong>${escapeHtml(b.title)}</strong>
    <span class="brick-board-count">${escapeHtml(t("cards.count", { n: Number(b.n) }))}</span>
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
        LEFT JOIN board_groups g ON g.id = b.group_id
        -- 그룹 권한·본인인증까지 — 게시판 권한만 보면 회원 전용 그룹의 글 제목이 공개 위젯에 나왔다
        WHERE ${sql.raw(PUBLIC_POST_SQL)}
          AND (${slug} = '' OR b.slug = ${slug})
        ORDER BY p.created_at DESC LIMIT ${limit}
      `);
      /**
       * 비었을 때도 제목은 그린다. 제목 없이 "게시물이 없습니다" 박스만 남으면
       * 손님은 **무엇이** 비었는지 알 수 없다 (홈에 공지 위젯이 그랬다).
       */
      const heading = props.title ? `<h3 class="brick-widget-title">${escapeHtml(String(props.title))}</h3>` : "";
      if (!rows.length) {
        return `${heading}<p class="brick-board-empty">${escapeHtml(t("latest.empty"))}</p>${BOARD_CSS}`;
      }

      const items = rows
        .map(
          (r) => `    <li>
      <a href="/board/${encodeURIComponent(String(r.board_slug))}/${escapeHtml(r.id)}">${escapeHtml(r.title)}</a>
      ${Number(r.comment_count) > 0 ? `<span class="brick-cmt">[${Number(r.comment_count)}]</span>` : ""}
      ${props.showDate !== false ? `<time>${shortDate(r.created_at)}</time>` : ""}
    </li>`,
        )
        .join("\n");
      return `${heading}<ul class="brick-latest-posts">\n${items}\n</ul>${BOARD_CSS}`;
    },
  });

  // ── 최신글 모아보기 (여러 게시판) ───────────────────
  //
  // 메인 화면의 핵심이다. latest() 를 게시판마다 호출해 상자를 여러 개
  // 늘어놓는 그 구조 — 이게 없으면 메인 페이지를 만들 수 없어서 블록을 손으로
  // 여러 개 배치해야 하고, 게시판을 추가할 때마다 페이지를 고쳐야 한다.
  ctx.registerBlock({
    name: "latest-multi",
    displayName: "최신글 모아보기 (여러 게시판)",
    propsSchema: {
      type: "object",
      properties: {
        boards: {
          type: "string",
          title: "게시판 slug 목록 (쉼표로 구분, 비우면 전체)",
          description: "예: notice,free,qna — 적은 순서대로 배치됩니다",
        },
        limit: { type: "number", title: "게시판당 표시 개수", default: 5 },
        columns: { type: "number", title: "열 수", default: 3 },
        showDate: { type: "boolean", title: "날짜 표시", default: true },
        showMore: { type: "boolean", title: "더보기 링크", default: true },
      },
    },
    render: async (props) => {
      const limit = Math.min(20, Math.max(1, Number(props.limit ?? 5)));
      const columns = Math.min(4, Math.max(1, Number(props.columns ?? 3)));
      const wanted = String(props.boards ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      // 공개 게시판만. 위젯은 어디에나 놓이므로 로그인 상태에 따라 달라지면
      // 렌더 캐시(비로그인 전용)에 회원 전용 제목이 섞일 수 있다.
      // ANY(${배열}) 은 쓰지 않는다 — drizzle 이 JS 배열을 PostgreSQL 배열 리터럴로
      // 직렬화하지 않아 "malformed array literal" 이 난다. IN 목록을 명시적으로 만든다.
      const slugFilter = wanted.length
        ? sql`AND b.slug IN (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)})`
        : sql``;
      const { rows: boards } = await db.execute(sql`
        SELECT b.id, b.slug, b.title FROM board_boards b
        LEFT JOIN board_groups g ON g.id = b.group_id
        WHERE b.read_role = 'guest' AND b.is_visible = true
          AND coalesce(g.read_role, 'guest') = 'guest' AND b.cert_required = '' ${slugFilter}
        ORDER BY b.sort_order, b.title
      `);
      if (!boards.length) return `<p class="brick-board-empty">${escapeHtml(t("list.emptyBoards"))}</p>${BOARD_CSS}`;

      // 적어준 순서를 지킨다 — 관리자가 notice 를 먼저 적었으면 먼저 나와야 한다
      const ordered = wanted.length
        ? wanted
            .map((slug) => boards.find((b) => String(b.slug) === slug))
            .filter((b): b is (typeof boards)[number] => Boolean(b))
        : boards;

      // 게시판 수만큼 쿼리하지 않는다. 윈도우 함수로 한 번에 가져온다 —
      // 게시판이 열 개면 쿼리 열 번이 되고, 메인 페이지는 가장 많이 열리는 화면이다.
      const idList = sql.join(
        ordered.map((b) => sql`${String(b.id)}::uuid`),
        sql`, `,
      );
      const { rows: posts } = await db.execute(sql`
        SELECT board_id, id, title, created_at, comment_count FROM (
          SELECT p.board_id, p.id, p.title, p.created_at, p.comment_count,
                 row_number() OVER (PARTITION BY p.board_id ORDER BY p.created_at DESC) AS rn
          FROM board_posts p
          WHERE p.board_id IN (${idList}) AND p.is_secret = false
        ) ranked
        WHERE rn <= ${limit}
      `);

      const byBoard = new Map<string, typeof posts>();
      for (const row of posts) {
        const key = String(row.board_id);
        const list = byBoard.get(key) ?? [];
        list.push(row);
        byBoard.set(key, list);
      }

      const cards = ordered
        .map((b) => {
          const base = `/board/${encodeURIComponent(String(b.slug))}`;
          const list = byBoard.get(String(b.id)) ?? [];
          const items = list.length
            ? list
                .map(
                  (r) => `      <li>
        <a href="${base}/${escapeHtml(r.id)}">${escapeHtml(r.title)}</a>
        ${Number(r.comment_count) > 0 ? `<span class="brick-cmt">[${Number(r.comment_count)}]</span>` : ""}
        ${props.showDate !== false ? `<time>${shortDate(r.created_at)}</time>` : ""}
      </li>`,
                )
                .join("\n")
            : `      <li class="brick-board-empty">${escapeHtml(t("list.emptyPosts"))}</li>`;
          return `  <section class="brick-latest-card">
    <h3><a href="${base}">${escapeHtml(b.title)}</a>${
      props.showMore !== false ? `<a class="brick-more" href="${base}">${escapeHtml(t("list.more"))}</a>` : ""
    }</h3>
    <ul class="brick-latest-posts">
${items}
    </ul>
  </section>`;
        })
        .join("\n");

      return `<div class="brick-latest-grid" style="--brick-latest-cols:${columns}">
${cards}
</div>${BOARD_CSS}${LATEST_MULTI_CSS}`;
    },
  });
  /**
   * 내 스크랩 — 스크랩 API(/my/scraps)는 있었지만 화면이 없었다.
   * 담아둔 글을 다시 볼 방법이 없으면 스크랩 기능도 반쪽이다.
   *
   * 골격만 서버 렌더 — 내 스크랩은 사용자별 내용이므로 캐시에 실으면 안 된다.
   */
  ctx.registerBlock({
    name: "my-scraps",
    displayName: "내 스크랩",
    render: async (_props, blockCtx) => {
      if (!blockCtx.user) {
        return `<div class="brick-scraps"><p class="brick-b-empty">${escapeHtml(t("scrap.loginRequired"))} <a href="/login">${escapeHtml(t("scrap.login"))}</a></p></div>${SCRAPS_CSS}`;
      }
      return `
<div class="brick-scraps" id="brick-scraps">
  <div id="brick-scraps-body"><p class="brick-b-empty">${escapeHtml(t("scrap.loading"))}</p></div>
</div>
${scrapsScript()}${SCRAPS_CSS}`;
    },
  });

}

/* ── 최신글 모아보기 스타일 ────────────────────────── */
const LATEST_MULTI_CSS = `
<style>
.brick-latest-grid{display:grid;grid-template-columns:repeat(var(--brick-latest-cols,3),1fr);gap:20px;margin:20px 0;align-items:start}
@media(max-width:1024px){.brick-latest-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:640px){.brick-latest-grid{grid-template-columns:1fr}}
.brick-latest-card{border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 16px);padding:18px 20px;background:var(--color-bg, #fff)}
.brick-latest-card h3{margin:0 0 6px;font-size:16px;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px}
/* 제목·더보기는 손가락으로 누르는 링크다 — 글자 높이(26px)가 아니라 44px 을 터치 영역으로 준다 */
.brick-latest-card h3 a{text-decoration:none;color:inherit;display:inline-flex;align-items:center;min-height:44px;padding:0 6px;margin:0 -6px}
.brick-latest-card .brick-more{font-size:12px;color:var(--color-muted, #6c6c7a);font-weight:400}
.brick-latest-card .brick-latest-posts{margin:0}
</style>`;

const SCRAPS_CSS = `
<style>
.brick-scraps table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.brick-scraps th, .brick-scraps td { padding: 10px 8px; border-bottom: 1px solid var(--color-line, #e7e7ec); text-align: left; }
.brick-scraps th { font-size: 13px; color: var(--color-muted, #71717d); }
.brick-scraps a { color: inherit; text-decoration: none; }
.brick-scraps a:hover { text-decoration: underline; }
.brick-scraps .brick-s-board { width: 120px; color: var(--color-muted, #71717d); font-size: 13.5px; }
.brick-scraps .brick-s-date { width: 110px; color: var(--color-muted, #71717d); font-size: 13px; }
.brick-scraps .brick-s-act { width: 60px; text-align: right; }
.brick-scraps .brick-s-act button { border: 0; background: none; color: var(--color-muted, #71717d); cursor: pointer; font-size: 12.5px; }
.brick-b-empty { padding: 36px; text-align: center; color: var(--color-muted, #999); }
/* 목록 표는 폰에서 카드로 접는다 — 맨 뒤에 와야 위의 너비 규칙을 덮는다 */
${STACK_TABLE_CSS}
</style>`;

/** 스크랩 목록 클라이언트 — 목록 조회와 해제 */
const scrapsScript = () => `
<script>
${dateScript()}
(function(){
  var root = document.getElementById('brick-scraps');
  if (!root) return;
  var body = document.getElementById('brick-scraps-body');
  var API = '/api/plugins/brick-board';
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  // 날짜는 사이트 시간대로 — 서버가 그리는 목록과 같은 날짜를 보여야 한다
  var d2 = window.brickDate.day;

  function load(){
    fetch(API + '/my/scraps').then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (!d) { body.innerHTML = '<p class="brick-b-empty">' + ${JSON.stringify(t("scrap.loadFail"))} + '</p>'; return; }
      if (!d.items || !d.items.length) {
        body.innerHTML = '<p class="brick-b-empty">' + ${JSON.stringify(t("scrap.empty"))} + '</p>';
        return;
      }
      /* 칸 이름은 머리글과 접힌 카드의 제목(data-label)에 같이 쓴다 */
      var C_BOARD = ${JSON.stringify(t("scrap.colBoard"))};
      var C_TITLE = ${JSON.stringify(t("scrap.colTitle"))};
      var C_DATE = ${JSON.stringify(t("scrap.colDate"))};
      body.innerHTML = '<table class="brick-stack-table"><thead><tr>' +
        '<th class="brick-s-board">' + C_BOARD + '</th>' +
        '<th>' + C_TITLE + '</th>' +
        '<th class="brick-s-date">' + C_DATE + '</th><th></th>' +
        '</tr></thead><tbody>' +
        d.items.map(function(it){
          return '<tr><td class="brick-s-board" data-label="' + C_BOARD + '">' + esc(it.board_title) + '</td>' +
            '<td data-label="' + C_TITLE + '"><a href="/board/' + esc(it.board_slug) + '/' + esc(it.id) + '">' + esc(it.title) + '</a>' +
            (it.comment_count ? ' <small>[' + it.comment_count + ']</small>' : '') + '</td>' +
            '<td class="brick-s-date" data-label="' + C_DATE + '">' + d2(it.scrapped_at) + '</td>' +
            '<td class="brick-s-act" data-label=""><button type="button" data-unscrap="' + esc(it.id) + '">' +
            ${JSON.stringify(t("scrap.remove"))} + '</button></td></tr>';
        }).join('') + '</tbody></table>';

      body.querySelectorAll('[data-unscrap]').forEach(function(btn){
        btn.addEventListener('click', function(){
          // 스크랩은 토글이다 — 같은 엔드포인트를 다시 부르면 해제된다
          fetch(API + '/posts/' + encodeURIComponent(btn.dataset.unscrap) + '/scrap', { method: 'POST' })
            .then(load);
        });
      });
    }).catch(function(){
      body.innerHTML = '<p class="brick-b-empty">' + ${JSON.stringify(t("scrap.loadFail"))} + '</p>';
    });
  }
  load();
})();
</script>`;
