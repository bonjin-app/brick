import { sql } from "drizzle-orm";
import type { BlockRenderContext } from "@brick/plugin-sdk";
import { escapeHtml, hasRole, humanSize, shortDate, type BoardRow, type Db } from "./types.js";

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
const CAPTCHA_FIELD = `<div class="brick-field brick-captcha" data-captcha>
      <span class="brick-label">자동입력 방지</span>
      <div class="brick-captcha-row">
        <span class="brick-captcha-image" aria-live="polite"></span>
        <button type="button" data-captcha-reload title="새로고침">&#8635;</button>
        <input name="captchaAnswer" autocomplete="off" maxlength="10" placeholder="보이는 문자 입력" required />
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
        <td class="brick-c-num">${notice ? "공지" : ""}</td>
        <td class="brick-c-title">
          ${p.category ? `<span class="brick-cat">${escapeHtml(p.category)}</span>` : ""}${indent}
          <a href="${base}/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a>
          ${p.is_secret ? `<span class="brick-lock" title="비밀글">&#128274;</span>` : ""}
          ${Number(p.comment_count) > 0 ? `<span class="brick-cmt">[${Number(p.comment_count)}]</span>` : ""}
          ${Number(p.file_count) > 0 ? `<span class="brick-clip" title="첨부파일">&#128206;</span>` : ""}
        </td>
        <td class="brick-c-author">${escapeHtml(p.author_name ?? "-")}</td>
        <td class="brick-c-date">${shortDate(p.created_at)}</td>
        <td class="brick-c-view">${Number(p.view_count)}</td>
      </tr>`;
  };

  const cats = board.categories;
  const catNav = cats.length
    ? `  <nav class="brick-cat-nav">
    <a href="${base}"${!category ? ' class="is-active"' : ""}>전체</a>
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
    <span class="brick-board-total">${total}개의 글${q ? ` (검색: ${escapeHtml(q)})` : ""}</span>
  </div>
  ${board.description && !q ? `<p class="brick-board-desc">${escapeHtml(board.description)}</p>` : ""}
${catNav}
  <table class="brick-board-table">
    <thead>
      <tr><th class="brick-c-num"></th><th>제목</th><th class="brick-c-author">작성자</th>
          <th class="brick-c-date">날짜</th><th class="brick-c-view">조회</th></tr>
    </thead>
    <tbody>
${notices.map((p) => row(p, true)).join("\n")}
${items.map((p) => row(p, false)).join("\n")}
${!notices.length && !items.length ? `      <tr><td colspan="5" class="brick-board-empty">${q ? "검색 결과가 없습니다." : "첫 글을 작성해보세요."}</td></tr>` : ""}
    </tbody>
  </table>
${pager}
  <form class="brick-board-search" method="get" action="${base}">
    <select name="in">
      <option value="all"${searchIn === "all" ? " selected" : ""}>전체</option>
      <option value="title"${searchIn === "title" ? " selected" : ""}>제목</option>
      <option value="content"${searchIn === "content" ? " selected" : ""}>내용</option>
      <option value="author"${searchIn === "author" ? " selected" : ""}>작성자</option>
    </select>
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="검색어" />
    <button type="submit">검색</button>
    ${canWrite ? `<a class="brick-write-btn" href="${base}/write">글쓰기</a>` : ""}
  </form>
</div>`;
}

function renderPager(current: number, totalPages: number, link: (n: number) => string): string {
  const window = 5;
  const start = Math.max(1, current - Math.floor(window / 2));
  const end = Math.min(totalPages, start + window - 1);
  const parts: string[] = [];
  if (current > 1) parts.push(`<a href="${link(current - 1)}">&#8249; 이전</a>`);
  if (start > 1) parts.push(`<a href="${link(1)}">1</a>${start > 2 ? "<span>&hellip;</span>" : ""}`);
  for (let n = start; n <= end; n++) {
    parts.push(n === current ? `<strong>${n}</strong>` : `<a href="${link(n)}">${n}</a>`);
  }
  if (end < totalPages) {
    parts.push(`${end < totalPages - 1 ? "<span>&hellip;</span>" : ""}<a href="${link(totalPages)}">${totalPages}</a>`);
  }
  if (current < totalPages) parts.push(`<a href="${link(current + 1)}">다음 &#8250;</a>`);
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
           view_count, up_count, down_count, comment_count, file_count, is_secret, is_notice, depth
    FROM board_posts WHERE id = ${postId}::uuid AND board_id = ${board.id}::uuid LIMIT 1
  `);
  const post = rows[0];
  if (!post) {
    return `<div class="brick-board"><p class="brick-board-empty">글을 찾을 수 없습니다.
      <a href="${base}">목록으로</a></p></div>`;
  }

  const isOwner = Boolean(ctx.user && ctx.user.id === post.author_id);
  const isManager = hasRole(ctx.user, "manager");

  // 비밀글은 서버 렌더에 본문을 담지 않는다 — 캐시에 남으면 유출된다.
  // (비로그인 요청만 캐시되므로 로그인 사용자는 안전하지만, 방어를 이중으로 둔다)
  if (post.is_secret && !isOwner && !isManager) {
    return `<div class="brick-board">
  <div class="brick-post-head"><h2>${escapeHtml(post.title)}</h2></div>
  <div class="brick-secret-notice">
    <p>&#128274; 비밀글입니다. 작성자와 운영자만 열람할 수 있습니다.</p>
    ${!ctx.user ? `<p><a href="/login">로그인</a> 후 다시 시도해주세요.</p>` : ""}
    <p><a href="${base}">목록으로</a></p>
  </div>
</div>`;
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
    <strong>첨부파일 ${files.length}개</strong>
    <ul>
${files
  .map(
    (f) => `      <li>
        ${
          canDownload
            ? `<a href="#" data-file="${escapeHtml(f.id)}">${escapeHtml(f.file_name)}</a>`
            : `<span class="brick-file-locked">${escapeHtml(f.file_name)} (다운로드 권한 없음)</span>`
        }
        <span class="brick-file-meta">${humanSize(Number(f.size))} &middot; ${Number(f.download_count)}회</span>
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
        ${c.is_secret ? `<span class="brick-lock" title="비밀 댓글">&#128274;</span>` : ""}
      </div>
      <div class="brick-comment-body">${
        hidden ? `<em class="brick-hidden">비밀 댓글입니다.</em>` : escapeHtml(c.content).replace(/\n/g, "<br />")
      }</div>
      <div class="brick-comment-actions">
        <button type="button" data-reply="${escapeHtml(c.id)}">답글</button>
        ${own ? `<button type="button" data-del-comment="${escapeHtml(c.id)}">삭제</button>` : ""}
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
      <time>${new Date(String(post.created_at)).toLocaleString("ko-KR")}</time>
      <span>조회 ${Number(post.view_count)}</span>
      ${String(post.updated_at) !== String(post.created_at) ? `<span class="brick-edited">수정됨</span>` : ""}
    </div>
  </div>

${filesHtml}

  <article class="brick-post-content">${String(post.content ?? "")}</article>

  <div class="brick-post-foot">
    ${
      board.allow_vote
        ? `<div class="brick-vote">
      <button type="button" data-vote="1">&#128077; 추천 <span data-up>${Number(post.up_count)}</span></button>
      <button type="button" data-vote="-1">&#128078; <span data-down>${Number(post.down_count)}</span></button>
    </div>`
        : ""
    }
    <div class="brick-post-actions">
      <a href="${base}">목록</a>
      ${board.allow_reply && hasRole(ctx.user, board.write_role) ? `<a href="${base}/write?replyTo=${escapeHtml(post.id)}">답변</a>` : ""}
      ${canModify ? `<a href="${base}/${escapeHtml(post.id)}/edit">수정</a>` : ""}
      ${canModify ? `<button type="button" data-delete-post>삭제</button>` : ""}
    </div>
  </div>

  <section class="brick-comments">
    <h3>댓글 <span data-comment-count>${Number(post.comment_count)}</span></h3>
    <ul class="brick-comment-list">
${commentsHtml || `      <li class="brick-board-empty">첫 댓글을 남겨보세요.</li>`}
    </ul>
    ${
      canComment
        ? `<form class="brick-comment-form">
      <input type="hidden" name="parentId" value="" />
      ${
        ctx.user
          ? ""
          : `<div class="brick-guest-fields">
        <input name="guestName" placeholder="이름" maxlength="20" required />
        <input name="guestPassword" type="password" placeholder="비밀번호" minlength="4" required />
      </div>
      ${CAPTCHA_FIELD}`
      }
      <textarea name="content" rows="3" placeholder="댓글을 입력하세요" required></textarea>
      <div class="brick-comment-submit">
        ${ctx.user ? `<label><input type="checkbox" name="isSecret" /> 비밀 댓글</label>` : ""}
        <span class="brick-reply-to" hidden>답글 작성 중 <button type="button" data-cancel-reply>취소</button></span>
        <button type="submit">등록</button>
      </div>
    </form>`
        : `<p class="brick-board-empty">댓글을 작성할 권한이 없습니다.
      ${!ctx.user ? `<a href="/login">로그인</a>` : ""}</p>`
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
  <p class="brick-board-empty">글을 작성할 권한이 없습니다.
    ${!ctx.user ? `<a href="/login">로그인</a>` : ""} <a href="${base}">목록으로</a></p>
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
      return `<div class="brick-board"><p class="brick-board-empty">수정할 글을 찾을 수 없습니다.
        <a href="${base}">목록으로</a></p></div>`;
    }
    const isOwner = Boolean(ctx.user && ctx.user.id === editing.author_id);
    // 비회원 글은 비밀번호로 확인하므로 폼은 보여주고 저장 시점에 검증한다
    if (editing.author_id && !isOwner && !hasRole(ctx.user, "manager")) {
      return `<div class="brick-board"><p class="brick-board-empty">본인이 작성한 글만 수정할 수 있습니다.
        <a href="${base}">목록으로</a></p></div>`;
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
    <h2>${editing ? "글 수정" : replyTitle ? "답변 쓰기" : "글쓰기"}</h2>
  </div>
  ${replyTitle ? `<p class="brick-board-desc">원글: ${escapeHtml(replyTitle)}</p>` : ""}

  <form class="brick-write-form">
    ${
      cats.length
        ? `<label class="brick-field">분류
      <select name="category">
        <option value="">선택하지 않음</option>
        ${cats.map((c) => `<option value="${escapeHtml(c)}"${currentCat === c ? " selected" : ""}>${escapeHtml(c)}</option>`).join("\n        ")}
      </select>
    </label>`
        : ""
    }

    ${
      ctx.user
        ? ""
        : `<div class="brick-guest-fields">
      <label class="brick-field">이름
        <input name="guestName" maxlength="20" minlength="2" required />
      </label>
      <label class="brick-field">비밀번호 <small>(수정·삭제에 사용)</small>
        <input name="guestPassword" type="password" minlength="4" required />
      </label>
    </div>`
    }

    <label class="brick-field">제목
      <input name="title" maxlength="500" required value="${escapeHtml(editing?.title ?? "")}" />
    </label>

    <div class="brick-field">
      <span class="brick-label">내용</span>
      <div class="brick-editor">
        <div class="brick-toolbar" role="toolbar" aria-label="서식">
          <button type="button" data-cmd="bold" title="굵게"><b>B</b></button>
          <button type="button" data-cmd="italic" title="기울임"><i>I</i></button>
          <button type="button" data-cmd="underline" title="밑줄"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="취소선"><s>S</s></button>
          <span class="brick-sep"></span>
          <button type="button" data-block="h3" title="제목">H</button>
          <button type="button" data-cmd="insertUnorderedList" title="목록">&bull;</button>
          <button type="button" data-cmd="insertOrderedList" title="번호 목록">1.</button>
          <button type="button" data-block="blockquote" title="인용">&ldquo;</button>
          <span class="brick-sep"></span>
          <button type="button" data-link title="링크">&#128279;</button>
          <button type="button" data-cmd="removeFormat" title="서식 지우기">&#10006;</button>
        </div>
        <div class="brick-editor-body" contenteditable="true" role="textbox" aria-multiline="true"
             data-placeholder="내용을 입력하세요">${String(editing?.content ?? "")}</div>
      </div>
      <textarea name="content" hidden></textarea>
    </div>

    ${
      board.allow_upload && board.max_files > 0
        ? `<label class="brick-field">첨부파일 <small>(최대 ${board.max_files}개)</small>
      <input type="file" name="files" multiple />
    </label>`
        : ""
    }

    ${ctx.user ? "" : CAPTCHA_FIELD}

    <div class="brick-write-options">
      ${board.allow_secret ? `<label><input type="checkbox" name="isSecret"${editing?.is_secret ? " checked" : ""} /> 비밀글</label>` : ""}
      ${hasRole(ctx.user, "manager") ? `<label><input type="checkbox" name="isNotice" /> 공지로 등록</label>` : ""}
    </div>

    <p class="brick-write-msg" role="status"></p>
    <div class="brick-write-actions">
      <button type="submit" class="brick-primary">${editing ? "수정 완료" : "등록"}</button>
      <a href="${base}">취소</a>
    </div>
  </form>
</div>`;
}
