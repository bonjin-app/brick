import { sql } from "drizzle-orm";
import type { BlockRenderContext } from "@brick/plugin-sdk";
import { escapeHtml, hasRole, humanSize, shortDate, type BoardRow, type Db } from "./types.js";
import { localeTag, t } from "./i18n.js";

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
): Promise<string> {
  const base = `/board/${encodeURIComponent(board.slug)}`;
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
               p.comment_count, p.file_count, p.is_secret, p.depth
        FROM board_posts p
        WHERE p.board_id = ${board.id}::uuid AND p.is_notice = true
        ORDER BY p.created_at DESC LIMIT 5
      `);

  const { rows: items } = await db.execute(sql`
    SELECT p.id, p.title, p.category, p.author_name, p.created_at, p.view_count,
           p.comment_count, p.file_count, p.is_secret, p.depth
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

  const row = (p: Record<string, unknown>, notice: boolean) => {
    const depth = Number(p.depth ?? 0);
    const indent = depth > 0 ? `<span class="brick-reply-mark" style="--d:${depth}">&#8627;</span>` : "";
    return `      <tr${notice ? ' class="brick-notice"' : ""}>
        <td class="brick-c-num">${notice ? escapeHtml(t("list.notice")) : ""}</td>
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

  return `<div class="brick-board">
  <div class="brick-board-head">
    <h2>${escapeHtml(board.title)}</h2>
    <span class="brick-board-total">${t("list.total", { n: total })}${q ? escapeHtml(t("list.searchLabel", { q })) : ""}</span>
  </div>
  ${board.description && !q ? `<p class="brick-board-desc">${escapeHtml(board.description)}</p>` : ""}
${catNav}
  <table class="brick-board-table">
    <thead>
      <tr><th class="brick-c-num"></th><th>${escapeHtml(t("list.colTitle"))}</th><th class="brick-c-author">${escapeHtml(t("list.colAuthor"))}</th>
          <th class="brick-c-date">${escapeHtml(t("list.colDate"))}</th><th class="brick-c-view">${escapeHtml(t("list.colView"))}</th></tr>
    </thead>
    <tbody>
${notices.map((p) => row(p, true)).join("\n")}
${items.map((p) => row(p, false)).join("\n")}
${!notices.length && !items.length ? `      <tr><td colspan="5" class="brick-board-empty">${escapeHtml(q ? t("list.emptySearch") : t("list.emptyFirst"))}</td></tr>` : ""}
    </tbody>
  </table>
${pager}
  <form class="brick-board-search" method="get" action="${base}">
    <select name="in">
      <option value="all"${searchIn === "all" ? " selected" : ""}>${escapeHtml(t("list.all"))}</option>
      <option value="title"${searchIn === "title" ? " selected" : ""}>${escapeHtml(t("list.colTitle"))}</option>
      <option value="content"${searchIn === "content" ? " selected" : ""}>${escapeHtml(t("write.content"))}</option>
      <option value="author"${searchIn === "author" ? " selected" : ""}>${escapeHtml(t("list.colAuthor"))}</option>
    </select>
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="${escapeHtml(t("list.searchPlaceholder"))}" />
    <button type="submit">${escapeHtml(t("list.searchBtn"))}</button>
    ${canWrite ? `<a class="brick-write-btn" href="${base}/write">${escapeHtml(t("list.writeBtn"))}</a>` : ""}
  </form>
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
): Promise<string> {
  const base = `/board/${encodeURIComponent(board.slug)}`;
  const { rows } = await db.execute(sql`
    SELECT id, title, content, category, author_id, author_name, created_at, updated_at,
           view_count, up_count, down_count, comment_count, file_count, scrap_count,
           is_secret, is_notice, depth
    FROM board_posts WHERE id = ${postId}::uuid AND board_id = ${board.id}::uuid LIMIT 1
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
  <div class="brick-post-head"><h2>${escapeHtml(post.title)}</h2></div>
  <div class="brick-secret-notice">
    <p>&#128274; ${escapeHtml(t("detail.secretNotice"))}</p>
    ${!ctx.user ? `<p>${escapeHtml(t("detail.loginRetry", { link: "\u0000" })).replace("\u0000", `<a href="/login">${escapeHtml(t("common.login"))}</a>`)}</p>` : ""}
    <p><a href="${base}">${escapeHtml(t("common.toList"))}</a></p>
  </div>
</div>`;
  }

  // 스크랩 여부 — 로그인 사용자에게만 의미가 있다
  let scrapped = false;
  if (ctx.user) {
    const { rows: sc } = await db.execute(sql`
      SELECT 1 FROM board_scraps WHERE post_id = ${postId}::uuid AND user_id = ${ctx.user.id}::uuid
    `);
    scrapped = sc.length > 0;
  }

  const { rows: files } = await db.execute(sql`
    SELECT id, file_name, content_type, size, download_count
    FROM board_attachments WHERE post_id = ${postId}::uuid ORDER BY sort_order, created_at
  `);
  const { rows: comments } = await db.execute(sql`
    SELECT id, parent_id, author_id, author_name, content, is_secret, depth, created_at
    FROM board_comments WHERE post_id = ${postId}::uuid ORDER BY created_at
  `);

  const canDownload = hasRole(ctx.user, board.download_role);
  const filesHtml = files.length
    ? `  <div class="brick-files">
    <strong>${escapeHtml(t("files.heading", { n: files.length }))}</strong>
    <ul>
${files
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

  const commentsHtml = comments
    .map((c) => {
      const hidden = c.is_secret && !isManager && !(ctx.user && ctx.user.id === c.author_id);
      const own = Boolean(ctx.user && ctx.user.id === c.author_id) || isManager || !c.author_id;
      return `    <li class="brick-comment" style="--d:${Math.min(3, Number(c.depth ?? 0))}" data-id="${escapeHtml(c.id)}">
      <div class="brick-comment-head">
        <strong>${escapeHtml(c.author_name ?? "-")}</strong>
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

  const canComment = hasRole(ctx.user, board.comment_role);
  const canModify = isOwner || isManager || !post.author_id;

  return `<div class="brick-board brick-post" data-board="${escapeHtml(board.slug)}" data-post="${escapeHtml(post.id)}">
  <div class="brick-post-head">
    ${post.category ? `<span class="brick-cat">${escapeHtml(post.category)}</span>` : ""}
    <h2>${escapeHtml(post.title)}</h2>
    <div class="brick-post-meta">
      <span>${escapeHtml(post.author_name ?? "-")}</span>
      <time>${new Date(String(post.created_at)).toLocaleString(localeTag())}</time>
      <span>${escapeHtml(t("detail.views", { n: Number(post.view_count) }))}</span>
      ${String(post.updated_at) !== String(post.created_at) ? `<span class="brick-edited">${escapeHtml(t("detail.edited"))}</span>` : ""}
    </div>
  </div>

${filesHtml}

  <article class="brick-post-content">${String(post.content ?? "")}</article>

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

  <section class="brick-comments">
    <h3>${escapeHtml(t("comments.heading"))} <span data-comment-count>${Number(post.comment_count)}</span></h3>
    <ul class="brick-comment-list">
${commentsHtml || `      <li class="brick-board-empty">${escapeHtml(t("comment.first"))}</li>`}
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
  <div class="brick-board-head"><h2>${escapeHtml(board.title)}</h2></div>
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

  return `<div class="brick-board brick-write"
     data-board="${escapeHtml(board.slug)}"
     ${editing ? `data-edit="${escapeHtml(editing.id)}"` : ""}
     ${replyTo && replyTitle ? `data-reply-to="${escapeHtml(replyTo)}"` : ""}>
  <div class="brick-board-head">
    <h2>${escapeHtml(editing ? t("write.editTitle") : replyTitle ? t("write.replyTitle") : t("write.title"))}</h2>
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
    <div class="brick-write-actions">
      <button type="submit" class="brick-primary">${escapeHtml(editing ? t("write.submitEdit") : t("common.submit"))}</button>
      <a href="${base}">${escapeHtml(t("common.cancel"))}</a>
    </div>
  </form>
</div>`;
}
