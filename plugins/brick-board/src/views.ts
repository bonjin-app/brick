import { sql } from "drizzle-orm";
import type { BlockRenderContext } from "@brick/plugin-sdk";
import { asListStyle, escapeHtml, fullDate, hasRole, humanSize, shortDate, type BoardRow, type Db } from "./types.js";
import { t } from "./i18n.js";

/**
 * 게시판 화면 렌더 — 목록 / 상세 / 글쓰기.
 *
 * 하나의 페이지(slug "board/free")가 세 화면을 모두 처리한다.
 * 구분은 ctx.pathTail 로 한다:
 *   ""        → 목록
 *   "write"   → 글쓰기
 *   "<uuid>"  → 상세
 *
 * 모든 화면이 서버 렌더다 — 검색엔진이 글을 그대로 읽는다.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 비회원용 자동입력 방지 필드.
 *
 * 이미지는 클라이언트가 /api/captcha 로 받아 채운다 — 서버 렌더에 넣으면
 * 캐시된 페이지에 같은 문제가 박혀 무의미해진다.
 */
const captchaField = () => `<div class="brick-field brick-captcha" data-captcha>
      <span class="brick-label">${escapeHtml(t("captcha.label"))}</span>
      <div class="brick-captcha-row">
        <span class="brick-captcha-image" aria-live="polite"></span>
        <button type="button" data-captcha-reload title="${escapeHtml(t("captcha.reload"))}">&#8635;</button>
        <input name="captchaAnswer" autocomplete="off" maxlength="10" placeholder="${escapeHtml(t("captcha.placeholder"))}" required />
      </div>
      <input type="hidden" name="captchaToken" value="" />
    </div>`;

/**
 * 작성자 표시 — 아바타 + 이름.
 * 이미지가 없으면 이름 첫 글자로 원을 그린다(색은 이름 해시). 회원이면 이름이
 * 프로필 카드 버튼이 된다(가입일·글·댓글 수). 비회원은 이름만.
 */
export function authorChip(
  name: unknown,
  authorId: unknown,
  avatar: unknown,
  size: "sm" | "md" = "sm",
): string {
  const n = String(name ?? "-");
  const initial = [...n.trim()][0] ?? "?";
  let hash = 0;
  for (const ch of n) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const pic = avatar
    ? `<img class="brick-avatar brick-avatar-${size}" src="${escapeHtml(String(avatar))}" alt="" loading="lazy" />`
    : `<span class="brick-avatar brick-avatar-${size}" style="--h:${hue}" aria-hidden="true">${escapeHtml(initial)}</span>`;
  const label = authorId
    ? `<button type="button" class="brick-author-name" data-author="${escapeHtml(String(authorId))}" data-author-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`
    : `<span class="brick-author-name">${escapeHtml(n)}</span>`;
  return `<span class="brick-author">${pic}${label}</span>`;
}

/** pathTail로 어떤 화면인지 판별 */
export function resolveView(pathTail: string): { view: "list" | "detail" | "write"; postId?: string } {
  const tail = pathTail.replace(/^\/+|\/+$/g, "");
  if (!tail) return { view: "list" };
  if (tail === "write") return { view: "write" };
  const [first, second] = tail.split("/");
  if (UUID_RE.test(first)) {
    // /board/free/<id>/edit 도 글쓰기 화면(수정 모드)으로 처리한다
    if (second === "edit") return { view: "write", postId: first };
    return { view: "detail", postId: first };
  }
  return { view: "list" };
}

/* ══════════════════════════════════════════════════════
   목록
   ══════════════════════════════════════════════════════ */
export async function renderList(
  db: Db,
  board: BoardRow,
  ctx: BlockRenderContext,
  opts: { listStyle?: string; embedded?: boolean } = {},
): Promise<string> {
  const base = `/board/${encodeURIComponent(board.slug)}`;
  // 위젯으로 끼운 목록: 제목은 h2(페이지에 이미 h1 이 있다), 검색폼은 뺀다(위젯이 아니라 화면의 일이다)
  const H = opts.embedded ? "h2" : "h1";
  // 스킨: 블록 속성이 게시판 설정보다 세다 (같은 게시판을 홈에서는 갤러리로, 목록에서는 표로)
  const style = asListStyle(opts.listStyle || board.list_style);
  const page = Math.max(1, Number(ctx.query.page ?? 1));
  const category = (ctx.query.category ?? "").trim();
  const q = (ctx.query.q ?? "").trim();
  const searchIn = ctx.query.in ?? "all";
  const size = board.page_size;
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const search = !q
    ? sql`TRUE`
    : searchIn === "title"
      ? sql`p.title ILIKE ${like}`
      : searchIn === "content"
        ? sql`p.content ILIKE ${like}`
        : searchIn === "author"
          ? sql`coalesce(p.author_name, '') ILIKE ${like}`
          : sql`(p.title ILIKE ${like} OR p.content ILIKE ${like} OR coalesce(p.author_name,'') ILIKE ${like})`;

  const filter = sql`
    p.board_id = ${board.id}::uuid
    AND (${category} = '' OR p.category = ${category})
    AND ${search}
  `;

  // 검색 중에는 공지를 섞지 않는다 (그누보드와 같은 동작)
  const { rows: notices } = q
    ? { rows: [] as Record<string, unknown>[] }
    : await db.execute(sql`
        SELECT p.id, p.title, p.category, p.author_name, p.created_at, p.view_count,
               p.comment_count, p.file_count, p.is_secret, p.depth, p.thumb_url,
               left(regexp_replace(p.content, '<[^>]*>', ' ', 'g'), 240) AS excerpt
        FROM board_posts p
        WHERE p.board_id = ${board.id}::uuid AND p.is_notice = true
        ORDER BY p.created_at DESC LIMIT 5
      `);

  const { rows: items } = await db.execute(sql`
    SELECT p.id, p.title, p.category, p.author_name, p.created_at, p.view_count,
           p.comment_count, p.file_count, p.is_secret, p.depth, p.thumb_url,
           left(regexp_replace(p.content, '<[^>]*>', ' ', 'g'), 240) AS excerpt
    FROM board_posts p
    WHERE ${filter} AND p.is_notice = false
    ORDER BY p.thread_created_at DESC, p.thread_path ASC
    LIMIT ${size} OFFSET ${(page - 1) * size}
  `);
  const { rows: counted } = await db.execute(sql`
    SELECT count(*) AS n FROM board_posts p WHERE ${filter} AND p.is_notice = false
  `);
  const total = Number(counted[0]?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / size));

  /**
   * 첫 열은 "공지" 표시 전용이다. 공지가 없는 게시판에서는 늘 비어 있으므로
   * 그 열을 아예 그리지 않는다 — 언제나 빈 열은 표를 넓히기만 한다.
   */
  const showNoticeCol = notices.length > 0;

  const row = (p: Record<string, unknown>, notice: boolean) => {
    const depth = Number(p.depth ?? 0);
    const indent = depth > 0 ? `<span class="brick-reply-mark" style="--d:${depth}">&#8627;</span>` : "";
    return `      <tr${notice ? ' class="brick-notice"' : ""}>
        ${showNoticeCol ? `<td class="brick-c-num">${notice ? escapeHtml(t("list.notice")) : ""}</td>` : ""}
        <td class="brick-c-title">
          ${p.category ? `<span class="brick-cat">${escapeHtml(p.category)}</span>` : ""}${indent}
          <a href="${base}/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a>
          ${p.is_secret ? `<span class="brick-lock" title="${escapeHtml(t("list.secretTitle"))}">&#128274;</span>` : ""}
          ${Number(p.comment_count) > 0 ? `<span class="brick-cmt">[${Number(p.comment_count)}]</span>` : ""}
          ${Number(p.file_count) > 0 ? `<span class="brick-clip" title="${escapeHtml(t("list.attachment"))}">&#128206;</span>` : ""}
        </td>
        <td class="brick-c-author">${escapeHtml(p.author_name ?? "-")}</td>
        <td class="brick-c-date">${shortDate(p.created_at)}</td>
        <td class="brick-c-view">${Number(p.view_count)}</td>
      </tr>`;
  };

  const cats = board.categories;
  const catNav = cats.length
    ? `  <nav class="brick-cat-nav">
    <a href="${base}"${!category ? ' class="is-active"' : ""}>${escapeHtml(t("list.all"))}</a>
    ${cats
      .map(
        (c) =>
          `<a href="${base}?category=${encodeURIComponent(c)}"${category === c ? ' class="is-active"' : ""}>${escapeHtml(c)}</a>`,
      )
      .join("\n    ")}
  </nav>`
    : "";

  // 페이지네이션 — 현재 필터를 유지한다
  const pageLink = (n: number) => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (q) { p.set("q", q); p.set("in", searchIn); }
    if (n > 1) p.set("page", String(n));
    const qs = p.toString();
    return `${base}${qs ? `?${qs}` : ""}`;
  };
  const pager = totalPages > 1 ? renderPager(page, totalPages, pageLink) : "";

  const canWrite = hasRole(ctx.user, board.write_role);

  /**
   * 스킨 — 같은 데이터를 세 가지 모양으로. 그누보드의 게시판 스킨(basic/gallery/webzine)에
   * 해당한다. 갤러리는 사진, 웹진은 글 소개가 주인공이므로 썸네일·발췌를 함께 그린다.
   */
  const thumb = (p: Record<string, unknown>) =>
    p.thumb_url
      ? `<img src="${escapeHtml(String(p.thumb_url))}" alt="" loading="lazy" />`
      : `<span class="brick-thumb-empty">${escapeHtml(t("list.noThumb"))}</span>`;
  const flags = (p: Record<string, unknown>) =>
    `${p.is_secret ? `<span class="brick-lock" title="${escapeHtml(t("list.secretTitle"))}">&#128274;</span>` : ""}` +
    `${Number(p.comment_count) > 0 ? `<span class="brick-cmt">[${Number(p.comment_count)}]</span>` : ""}`;
  const meta = (p: Record<string, unknown>) =>
    `<span class="brick-list-meta"><span>${escapeHtml(p.author_name ?? "-")}</span><span>${shortDate(p.created_at)}</span><span>${escapeHtml(t("detail.views", { n: Number(p.view_count) }))}</span></span>`;
  type Listed = Record<string, unknown> & { _notice: boolean };
  const all: Listed[] = [
    ...notices.map((p): Listed => ({ ...p, _notice: true })),
    ...items.map((p): Listed => ({ ...p, _notice: false })),
  ];
  const emptyMsg = `<p class="brick-board-empty">${escapeHtml(q ? t("list.emptySearch") : t("list.emptyFirst"))}</p>`;

  const gallery = () =>
    all.length
      ? `  <div class="brick-gallery-grid">
${all.map((p) => `    <a class="brick-gallery-item${p._notice ? " is-notice" : ""}" href="${base}/${escapeHtml(p.id)}">
      <span class="brick-gallery-thumb">${thumb(p)}${p._notice ? `<span class="brick-list-badge">${escapeHtml(t("list.notice"))}</span>` : ""}</span>
      <span class="brick-gallery-title">${p.category ? `<span class="brick-cat">${escapeHtml(p.category)}</span>` : ""}${escapeHtml(p.title)} ${flags(p)}</span>
      ${meta(p)}
    </a>`).join("\n")}
  </div>`
      : emptyMsg;

  const webzine = () =>
    all.length
      ? `  <ul class="brick-webzine">
${all.map((p) => `    <li class="brick-webzine-item${p._notice ? " is-notice" : ""}">
      <a href="${base}/${escapeHtml(p.id)}">
        <span class="brick-webzine-thumb">${thumb(p)}</span>
        <span class="brick-webzine-body">
          <span class="brick-webzine-title">${p._notice ? `<span class="brick-list-badge">${escapeHtml(t("list.notice"))}</span>` : ""}${p.category ? `<span class="brick-cat">${escapeHtml(p.category)}</span>` : ""}${escapeHtml(p.title)} ${flags(p)}</span>
          <span class="brick-webzine-excerpt">${escapeHtml(String(p.excerpt ?? "").replace(/\s+/g, " ").trim())}</span>
          ${meta(p)}
        </span>
      </a>
    </li>`).join("\n")}
  </ul>`
      : emptyMsg;

  const table = () => `  <table class="brick-board-table">
    <thead>
      <tr>${showNoticeCol ? '<th class="brick-c-num"></th>' : ""}<th>${escapeHtml(t("list.colTitle"))}</th><th class="brick-c-author">${escapeHtml(t("list.colAuthor"))}</th>
          <th class="brick-c-date">${escapeHtml(t("list.colDate"))}</th><th class="brick-c-view">${escapeHtml(t("list.colView"))}</th></tr>
    </thead>
    <tbody>
${notices.map((p) => row(p, true)).join("\n")}
${items.map((p) => row(p, false)).join("\n")}
${!notices.length && !items.length ? `      <tr><td colspan="${showNoticeCol ? 5 : 4}" class="brick-board-empty">${escapeHtml(q ? t("list.emptySearch") : t("list.emptyFirst"))}</td></tr>` : ""}
    </tbody>
  </table>`;

  const body = style === "gallery" ? gallery() : style === "webzine" ? webzine() : table();

  const searchForm = opts.embedded ? "" : `  <form class="brick-board-search" method="get" action="${base}">
    <select name="in">
      <option value="all"${searchIn === "all" ? " selected" : ""}>${escapeHtml(t("list.all"))}</option>
      <option value="title"${searchIn === "title" ? " selected" : ""}>${escapeHtml(t("list.colTitle"))}</option>
      <option value="content"${searchIn === "content" ? " selected" : ""}>${escapeHtml(t("write.content"))}</option>
      <option value="author"${searchIn === "author" ? " selected" : ""}>${escapeHtml(t("list.colAuthor"))}</option>
    </select>
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="${escapeHtml(t("list.searchPlaceholder"))}" />
    <button type="submit">${escapeHtml(t("list.searchBtn"))}</button>
    ${canWrite ? `<a class="brick-write-btn" href="${base}/write">${escapeHtml(t("list.writeBtn"))}</a>` : ""}
  </form>`;

  return `<div class="brick-board brick-list-${style}${opts.embedded ? " is-embedded" : ""}">
  <div class="brick-board-head">
    <${H}>${opts.embedded ? `<a href="${base}">${escapeHtml(board.title)}</a>` : escapeHtml(board.title)}</${H}>
    <span class="brick-board-total">${t("list.total", { n: total })}${q ? escapeHtml(t("list.searchLabel", { q })) : ""}</span>
  </div>
  ${board.description && !q && !opts.embedded ? `<p class="brick-board-desc">${escapeHtml(board.description)}</p>` : ""}
${catNav}
${body}
${pager}
${searchForm}
</div>`;
}

function renderPager(current: number, totalPages: number, link: (n: number) => string): string {
  const window = 5;
  const start = Math.max(1, current - Math.floor(window / 2));
  const end = Math.min(totalPages, start + window - 1);
  const parts: string[] = [];
  if (current > 1) parts.push(`<a href="${link(current - 1)}">&#8249; ${escapeHtml(t("pager.prev"))}</a>`);
  if (start > 1) parts.push(`<a href="${link(1)}">1</a>${start > 2 ? "<span>&hellip;</span>" : ""}`);
  for (let n = start; n <= end; n++) {
    parts.push(n === current ? `<strong>${n}</strong>` : `<a href="${link(n)}">${n}</a>`);
  }
  if (end < totalPages) {
    parts.push(`${end < totalPages - 1 ? "<span>&hellip;</span>" : ""}<a href="${link(totalPages)}">${totalPages}</a>`);
  }
  if (current < totalPages) parts.push(`<a href="${link(current + 1)}">${escapeHtml(t("pager.next"))} &#8250;</a>`);
  return `  <nav class="brick-pager">${parts.join("")}</nav>`;
}

/* ══════════════════════════════════════════════════════
   상세
   ══════════════════════════════════════════════════════ */
export async function renderDetail(
  db: Db,
  board: BoardRow,
  postId: string,
  ctx: BlockRenderContext,
  storage?: { publicUrl(key: string): string },
): Promise<string> {
  const base = `/board/${encodeURIComponent(board.slug)}`;
  const { rows } = await db.execute(sql`
    SELECT p.id, p.title, p.content, p.category, p.author_id, p.author_name, p.created_at, p.updated_at,
           p.view_count, p.up_count, p.down_count, p.comment_count, p.file_count, p.scrap_count,
           p.is_secret, p.is_notice, p.depth, p.thread_created_at, p.thread_path,
           u.avatar_url AS author_avatar
    FROM board_posts p LEFT JOIN users u ON u.id = p.author_id
    WHERE p.id = ${postId}::uuid AND p.board_id = ${board.id}::uuid LIMIT 1
  `);
  const post = rows[0];
  if (!post) {
    return `<div class="brick-board"><p class="brick-board-empty">${escapeHtml(t("detail.notFound"))}
      <a href="${base}">${escapeHtml(t("common.toList"))}</a></p></div>`;
  }

  const isOwner = Boolean(ctx.user && ctx.user.id === post.author_id);
  const isManager = hasRole(ctx.user, "manager");

  // 비밀글은 서버 렌더에 본문을 담지 않는다 — 캐시에 남으면 유출된다.
  // (비로그인 요청만 캐시되므로 로그인 사용자는 안전하지만, 방어를 이중으로 둔다)
  if (post.is_secret && !isOwner && !isManager) {
    return `<div class="brick-board">
  <div class="brick-post-head"><h1>${escapeHtml(post.title)}</h1></div>
  <div class="brick-secret-notice">
    <p>&#128274; ${escapeHtml(t("detail.secretNotice"))}</p>
    ${!ctx.user ? `<p>${escapeHtml(t("detail.loginRetry", { link: "\u0000" })).replace("\u0000", `<a href="/login">${escapeHtml(t("common.login"))}</a>`)}</p>` : ""}
    <p><a href="${base}">${escapeHtml(t("common.toList"))}</a></p>
  </div>
</div>`;
  }

  /**
   * 이 화면의 제목·설명은 글이다 — 브라우저 탭·공유 링크·검색 결과가 여기서
   * 나온다. 비밀글은 위에서 이미 돌려보냈으므로 여기서 본문을 요약해도 안전하다.
   */
  ctx.setSeo?.({
    title: String(post.title ?? ""),
    description: String(post.content ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 155),
    // 상세 화면은 글 제목을 자기 h1 으로 그린다
    ownHeading: true,
  });

  // 스크랩 여부 — 로그인 사용자에게만 의미가 있다
  let scrapped = false;
  if (ctx.user) {
    const { rows: sc } = await db.execute(sql`
      SELECT 1 FROM board_scraps WHERE post_id = ${postId}::uuid AND user_id = ${ctx.user.id}::uuid
    `);
    scrapped = sc.length > 0;
  }

  const { rows: files } = await db.execute(sql`
    SELECT id, file_name, content_type, size, download_count, storage_key
    FROM board_attachments WHERE post_id = ${postId}::uuid ORDER BY sort_order, created_at
  `);

  /**
   * 이전글·다음글 — 목록 순서(thread_created_at DESC, thread_path ASC)를 그대로 따른다.
   * "다음글"은 목록에서 위(더 새로운 글), "이전글"은 아래(더 오래된 글) — 그누보드의 관례.
   * 비밀글은 제목이 새므로 관리자가 아니면 건너뛴다.
   */
  const secretFilter = isManager ? sql`TRUE` : sql`p.is_secret = false`;
  const tca = post.thread_created_at as unknown;
  const tpath = String(post.thread_path ?? "");
  const [{ rows: prevRows }, { rows: nextRows }] = await Promise.all([
    db.execute(sql`
      SELECT p.id, p.title FROM board_posts p
      WHERE p.board_id = ${board.id}::uuid AND p.is_notice = false AND ${secretFilter}
        AND (p.thread_created_at < ${tca}::timestamptz
             OR (p.thread_created_at = ${tca}::timestamptz AND p.thread_path > ${tpath}))
      ORDER BY p.thread_created_at DESC, p.thread_path ASC LIMIT 1
    `),
    db.execute(sql`
      SELECT p.id, p.title FROM board_posts p
      WHERE p.board_id = ${board.id}::uuid AND p.is_notice = false AND ${secretFilter}
        AND (p.thread_created_at > ${tca}::timestamptz
             OR (p.thread_created_at = ${tca}::timestamptz AND p.thread_path < ${tpath}))
      ORDER BY p.thread_created_at ASC, p.thread_path DESC LIMIT 1
    `),
  ]);
  const navItem = (label: string, row: Record<string, unknown> | undefined, emptyLabel: string, cls: string) =>
    row
      ? `<a class="brick-post-nav-item ${cls}" href="${base}/${escapeHtml(row.id)}"><small>${escapeHtml(label)}</small><span>${escapeHtml(row.title)}</span></a>`
      : `<span class="brick-post-nav-item ${cls} is-empty"><small>${escapeHtml(label)}</small><span>${escapeHtml(emptyLabel)}</span></span>`;
  const postNav = `  <nav class="brick-post-nav" aria-label="${escapeHtml(t("detail.prev"))} / ${escapeHtml(t("detail.next"))}">
    ${navItem(t("detail.next"), nextRows[0], t("detail.noNext"), "is-next")}
    ${navItem(t("detail.prev"), prevRows[0], t("detail.noPrev"), "is-prev")}
  </nav>`;

  /**
   * 이미지 첨부는 본문 아래에 바로 보여준다 — 그누보드 갤러리의 관례이고, 사진을 올린
   * 사람은 그것이 화면에 보이길 기대한다("다운로드" 링크만 있으면 사진 게시판이 아니다).
   * 본문 안에 이미 같은 이미지가 삽입되어 있으면 두 번 그리지 않는다.
   */
  const contentHtml = String(post.content ?? "");
  const imageFiles: Array<{ url: string; file_name: string }> = storage
    ? files
        .filter((f) => /^image\//.test(String(f.content_type)))
        .map((f) => ({ url: storage.publicUrl(String(f.storage_key)), file_name: String(f.file_name ?? "") }))
        .filter((f) => !contentHtml.includes(f.url))
    : [];
  const imagesHtml = imageFiles.length
    ? `  <div class="brick-post-images">
${imageFiles.map((f) => `    <figure><img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.file_name)}" loading="lazy" /></figure>`).join("\n")}
  </div>`
    : "";

  const shareBar = `  <div class="brick-share" data-share-bar>
    <span class="brick-share-label">${escapeHtml(t("detail.share"))}</span>
    <button type="button" data-share="native" hidden>${escapeHtml(t("detail.share"))}</button>
    <button type="button" data-share="copy">${escapeHtml(t("detail.copyLink"))}</button>
    <a data-share="x" href="#" rel="noopener">${escapeHtml(t("detail.shareX"))}</a>
    <a data-share="facebook" href="#" rel="noopener">${escapeHtml(t("detail.shareFacebook"))}</a>
    <button type="button" data-print>${escapeHtml(t("detail.print"))}</button>
  </div>`;
  const { rows: comments } = await db.execute(sql`
    SELECT c.id, c.parent_id, c.author_id, c.author_name, c.content, c.is_secret, c.depth, c.created_at,
           u.avatar_url AS author_avatar
    FROM board_comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ${postId}::uuid ORDER BY c.created_at
  `);

  const canDownload = hasRole(ctx.user, board.download_role);
  // 이미지 첨부는 아래(imagesHtml)에서 본문에 바로 그리므로 목록에는 나머지 파일만 싣는다
  const inlineKeys = new Set(
    storage
      ? files.filter((f) => /^image\//.test(String(f.content_type))).map((f) => String(f.storage_key))
      : [],
  );
  const listedFiles = files.filter((f) => !inlineKeys.has(String(f.storage_key)));
  const filesHtml = listedFiles.length
    ? `  <div class="brick-files">
    <strong>${escapeHtml(t("files.heading", { n: listedFiles.length }))}</strong>
    <ul>
${listedFiles
  .map(
    (f) => `      <li>
        ${
          canDownload
            ? `<a href="#" data-file="${escapeHtml(f.id)}">${escapeHtml(f.file_name)}</a>`
            : `<span class="brick-file-locked">${escapeHtml(f.file_name)} ${escapeHtml(t("files.noPermission"))}</span>`
        }
        <span class="brick-file-meta">${humanSize(Number(f.size))} &middot; ${escapeHtml(t("files.downloads", { n: Number(f.download_count) }))}</span>
      </li>`,
  )
  .join("\n")}
    </ul>
  </div>`
    : "";

  const canComment = hasRole(ctx.user, board.comment_role);
  const commentsHtml = comments
    .map((c) => {
      const hidden = c.is_secret && !isManager && !(ctx.user && ctx.user.id === c.author_id);
      const own = Boolean(ctx.user && ctx.user.id === c.author_id) || isManager || !c.author_id;
      return `    <li class="brick-comment" style="--d:${Math.min(3, Number(c.depth ?? 0))}" data-id="${escapeHtml(c.id)}">
      <div class="brick-comment-head">
        ${authorChip(c.author_name, c.author_id, c.author_avatar)}
        <time>${shortDate(c.created_at)}</time>
        ${c.is_secret ? `<span class="brick-lock" title="${escapeHtml(t("comment.secretTitle"))}">&#128274;</span>` : ""}
      </div>
      <div class="brick-comment-body">${
        hidden ? `<em class="brick-hidden">${escapeHtml(t("comment.secret"))}</em>` : escapeHtml(c.content).replace(/\n/g, "<br />")
      }</div>
      <div class="brick-comment-actions">
        <button type="button" data-reply="${escapeHtml(c.id)}">${escapeHtml(t("comment.reply"))}</button>
        ${own ? `<button type="button" data-del-comment="${escapeHtml(c.id)}">${escapeHtml(t("common.delete"))}</button>` : ""}
      </div>
    </li>`;
    })
    .join("\n");

  const canModify = isOwner || isManager || !post.author_id;

  return `<div class="brick-board brick-post" data-board="${escapeHtml(board.slug)}" data-post="${escapeHtml(post.id)}">
  <div class="brick-post-head">
    ${post.category ? `<span class="brick-cat">${escapeHtml(post.category)}</span>` : ""}
    <h1>${escapeHtml(post.title)}</h1>
    <div class="brick-post-meta">
      ${authorChip(post.author_name, post.author_id, post.author_avatar, "md")}
      <time>${fullDate(post.created_at)}</time>
      <span>${escapeHtml(t("detail.views", { n: Number(post.view_count) }))}</span>
      ${String(post.updated_at) !== String(post.created_at) ? `<span class="brick-edited">${escapeHtml(t("detail.edited"))}</span>` : ""}
    </div>
  </div>

${filesHtml}

  <article class="brick-post-content">${contentHtml}</article>
${imagesHtml}
${shareBar}

  <div class="brick-post-foot">
    ${
      board.allow_vote
        ? `<div class="brick-vote">
      <button type="button" data-vote="1">&#128077; ${escapeHtml(t("vote.up"))} <span data-up>${Number(post.up_count)}</span></button>
      <button type="button" data-vote="-1">&#128078; <span data-down>${Number(post.down_count)}</span></button>
    </div>`
        : ""
    }
    ${
      ctx.user
        ? `<button type="button" class="brick-scrap${scrapped ? " is-on" : ""}" data-scrap
        aria-pressed="${scrapped ? "true" : "false"}">
      <span data-scrap-icon>${scrapped ? "&#9733;" : "&#9734;"}</span>
      ${escapeHtml(t("scrap.label"))} <span data-scrap-count>${Number(post.scrap_count ?? 0)}</span>
    </button>`
        : ""
    }
    <div class="brick-post-actions">
      <a href="${base}">${escapeHtml(t("common.list"))}</a>
      ${board.allow_reply && hasRole(ctx.user, board.write_role) ? `<a href="${base}/write?replyTo=${escapeHtml(post.id)}">${escapeHtml(t("detail.replyBtn"))}</a>` : ""}
      ${canModify ? `<a href="${base}/${escapeHtml(post.id)}/edit">${escapeHtml(t("common.edit"))}</a>` : ""}
      ${canModify ? `<button type="button" data-delete-post>${escapeHtml(t("common.delete"))}</button>` : ""}
    </div>
  </div>

${postNav}

  <section class="brick-comments" id="comments">
    <h3>${escapeHtml(t("comments.heading"))} <span data-comment-count>${Number(post.comment_count)}</span></h3>
    <ul class="brick-comment-list">
${commentsHtml || (canComment ? `      <li class="brick-board-empty">${escapeHtml(t("comment.first"))}</li>` : "")}
    </ul>
    ${
      canComment
        ? `<form class="brick-comment-form">
      <input type="hidden" name="parentId" value="" />
      ${
        ctx.user
          ? ""
          : `<div class="brick-guest-fields">
        <input name="guestName" placeholder="${escapeHtml(t("guest.name"))}" maxlength="20" required />
        <input name="guestPassword" type="password" placeholder="${escapeHtml(t("guest.password"))}" minlength="4" required />
      </div>
      ${captchaField()}`
      }
      <textarea name="content" rows="3" placeholder="${escapeHtml(t("comment.placeholder"))}" required></textarea>
      <div class="brick-comment-submit">
        ${ctx.user ? `<label><input type="checkbox" name="isSecret" /> ${escapeHtml(t("comment.secretOpt"))}</label>` : ""}
        <span class="brick-reply-to" hidden>${escapeHtml(t("comment.replying"))} <button type="button" data-cancel-reply>${escapeHtml(t("common.cancel"))}</button></span>
        <button type="submit">${escapeHtml(t("common.submit"))}</button>
      </div>
    </form>`
        : `<p class="brick-board-empty">${escapeHtml(t("comment.noPermission"))}
      ${!ctx.user ? `<a href="/login">${escapeHtml(t("common.login"))}</a>` : ""}</p>`
    }
  </section>
</div>`;
}

/* ══════════════════════════════════════════════════════
   글쓰기 / 수정
   ══════════════════════════════════════════════════════ */
export async function renderWrite(
  db: Db,
  board: BoardRow,
  ctx: BlockRenderContext,
  editPostId?: string,
): Promise<string> {
  const base = `/board/${encodeURIComponent(board.slug)}`;

  if (!hasRole(ctx.user, board.write_role)) {
    return `<div class="brick-board">
  <div class="brick-board-head"><h1>${escapeHtml(board.title)}</h1></div>
  <p class="brick-board-empty">${escapeHtml(t("write.noPermission"))}
    ${!ctx.user ? `<a href="/login">${escapeHtml(t("common.login"))}</a>` : ""} <a href="${base}">${escapeHtml(t("common.toList"))}</a></p>
</div>`;
  }

  // 수정 모드: 기존 값을 채운다
  let editing: Record<string, unknown> | null = null;
  if (editPostId) {
    const { rows } = await db.execute(sql`
      SELECT id, title, content, category, is_secret, author_id
      FROM board_posts WHERE id = ${editPostId}::uuid AND board_id = ${board.id}::uuid LIMIT 1
    `);
    editing = rows[0] ?? null;
    if (!editing) {
      return `<div class="brick-board"><p class="brick-board-empty">${escapeHtml(t("write.editNotFound"))}
        <a href="${base}">${escapeHtml(t("common.toList"))}</a></p></div>`;
    }
    const isOwner = Boolean(ctx.user && ctx.user.id === editing.author_id);
    // 비회원 글은 비밀번호로 확인하므로 폼은 보여주고 저장 시점에 검증한다
    if (editing.author_id && !isOwner && !hasRole(ctx.user, "manager")) {
      return `<div class="brick-board"><p class="brick-board-empty">${escapeHtml(t("write.ownOnly"))}
        <a href="${base}">${escapeHtml(t("common.toList"))}</a></p></div>`;
    }
  }

  const replyTo = (ctx.query.replyTo ?? "").trim();
  let replyTitle = "";
  if (replyTo && UUID_RE.test(replyTo)) {
    const { rows } = await db.execute(sql`SELECT title FROM board_posts WHERE id = ${replyTo}::uuid LIMIT 1`);
    replyTitle = String(rows[0]?.title ?? "");
  }

  const cats = board.categories;
  const currentCat = String(editing?.category ?? "");

  // 임시저장 키 — 게시판·(수정이면) 글 단위로 따로 둔다. 다른 글의 초안이 섞이면 안 된다
  const draftKey = `brick-draft:${board.slug}:${editing ? String(editing.id) : replyTo ? `re-${replyTo}` : "new"}`;
  const canInlineImage = Boolean(ctx.user) && board.allow_upload;

  return `<div class="brick-board brick-write"
     data-board="${escapeHtml(board.slug)}"
     data-draft-key="${escapeHtml(draftKey)}"
     ${editing ? `data-edit="${escapeHtml(editing.id)}"` : ""}
     ${replyTo && replyTitle ? `data-reply-to="${escapeHtml(replyTo)}"` : ""}>
  <div class="brick-board-head">
    <h1>${escapeHtml(editing ? t("write.editTitle") : replyTitle ? t("write.replyTitle") : t("write.title"))}</h1>
  </div>
  ${replyTitle ? `<p class="brick-board-desc">${escapeHtml(t("write.original", { title: replyTitle }))}</p>` : ""}

  <form class="brick-write-form">
    ${
      cats.length
        ? `<label class="brick-field">${escapeHtml(t("write.category"))}
      <select name="category">
        <option value="">${escapeHtml(t("write.noCategory"))}</option>
        ${cats.map((c) => `<option value="${escapeHtml(c)}"${currentCat === c ? " selected" : ""}>${escapeHtml(c)}</option>`).join("\n        ")}
      </select>
    </label>`
        : ""
    }

    ${
      ctx.user
        ? ""
        : `<div class="brick-guest-fields">
      <label class="brick-field">${escapeHtml(t("guest.name"))}
        <input name="guestName" maxlength="20" minlength="2" required />
      </label>
      <label class="brick-field">${escapeHtml(t("guest.password"))} <small>${escapeHtml(t("write.guestPasswordHint"))}</small>
        <input name="guestPassword" type="password" minlength="4" required />
      </label>
    </div>`
    }

    <label class="brick-field">${escapeHtml(t("write.subject"))}
      <input name="title" maxlength="500" required value="${escapeHtml(editing?.title ?? "")}" />
    </label>

    <div class="brick-field">
      <span class="brick-label">${escapeHtml(t("write.content"))}</span>
      <div class="brick-editor">
        <div class="brick-toolbar" role="toolbar" aria-label="${escapeHtml(t("editor.toolbar"))}">
          <button type="button" data-cmd="bold" title="${escapeHtml(t("editor.bold"))}"><b>B</b></button>
          <button type="button" data-cmd="italic" title="${escapeHtml(t("editor.italic"))}"><i>I</i></button>
          <button type="button" data-cmd="underline" title="${escapeHtml(t("editor.underline"))}"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="${escapeHtml(t("editor.strike"))}"><s>S</s></button>
          <span class="brick-sep"></span>
          <button type="button" data-block="h3" title="${escapeHtml(t("editor.heading"))}">H</button>
          <button type="button" data-cmd="insertUnorderedList" title="${escapeHtml(t("editor.ul"))}">&bull;</button>
          <button type="button" data-cmd="insertOrderedList" title="${escapeHtml(t("editor.ol"))}">1.</button>
          <button type="button" data-block="blockquote" title="${escapeHtml(t("editor.quote"))}">&ldquo;</button>
          <span class="brick-sep"></span>
          <button type="button" data-link title="${escapeHtml(t("editor.link"))}">&#128279;</button>
          ${canInlineImage
            ? `<button type="button" data-image title="${escapeHtml(t("editor.image"))}">&#128247;</button>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-image-input hidden />`
            : ""}
          <button type="button" data-cmd="removeFormat" title="${escapeHtml(t("editor.clear"))}">&#10006;</button>
        </div>
        <div class="brick-editor-body" contenteditable="true" role="textbox" aria-multiline="true"
             data-placeholder="${escapeHtml(t("write.contentPlaceholder"))}">${String(editing?.content ?? "")}</div>
      </div>
      <textarea name="content" hidden></textarea>
    </div>

    ${
      board.allow_upload && board.max_files > 0
        ? `<label class="brick-field">${escapeHtml(t("write.files"))} <small>${escapeHtml(t("write.filesMax", { n: board.max_files }))}</small>
      <input type="file" name="files" multiple />
    </label>`
        : ""
    }

    ${ctx.user ? "" : captchaField()}

    <div class="brick-write-options">
      ${board.allow_secret ? `<label><input type="checkbox" name="isSecret"${editing?.is_secret ? " checked" : ""} /> ${escapeHtml(t("write.secret"))}</label>` : ""}
      ${hasRole(ctx.user, "manager") ? `<label><input type="checkbox" name="isNotice" /> ${escapeHtml(t("write.notice"))}</label>` : ""}
    </div>

    <p class="brick-write-msg" role="status"></p>
    <p class="brick-draft-note" data-draft-note hidden>${escapeHtml(t("write.draftRestored"))} <button type="button" data-draft-discard>${escapeHtml(t("write.draftDiscard"))}</button></p>
    <div class="brick-write-actions">
      <button type="submit" class="brick-primary">${escapeHtml(editing ? t("write.submitEdit") : t("common.submit"))}</button>
      <a href="${base}">${escapeHtml(t("common.cancel"))}</a>
    </div>
  </form>
</div>`;
}
