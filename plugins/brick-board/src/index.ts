import { definePlugin, searchExcerpt, isUniqueViolation, rawResponse } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { BoardError, escapeHtml, hasRole, rankOf, type Db, type SessionUser } from "./types.js";
import { hashGuestPassword } from "./guest.js";
import { assertCanModify, canReadSecret, checkWriteInterval, loadBoard, requireRole } from "./access.js";
import { attachFiles, claimDownload, deleteAttachments, listAttachments } from "./attachments.js";
import { createPost, listPosts, type WritePostInput } from "./posts.js";
import { sanitizeHtml, toPlainText } from "./sanitize.js";
import { BOARD_RESOURCE, POST_RESOURCE } from "./admin-resources.js";
import { registerBoardBlocks } from "./blocks.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,50}$/;

/**
 * brick-board — 게시판 (그누보드 게시판에 대응).
 *
 * 그누보드에서 옮겨오는 사람이 기대하는 것을 갖춘다:
 *  다중 게시판 · 등급별 권한 · 분류 · 답변형(계층) · 비밀글 · 첨부파일 ·
 *  추천/비추천 · 비회원 글쓰기 · 검색 · 도배 방지 · RSS
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as Db;

  /** 라우트 요청에서 세션 사용자 추출 */
  const userOf = (req: { user: unknown }): SessionUser | null => (req.user as SessionUser | null) ?? null;
  /** 요청 IP — 코어가 프록시 헤더를 해석해 넣어준다 (도배 방지에 쓴다) */
  const ipOf = (req: { ip: string }): string | null => req.ip ?? null;

  const requireManager = (req: { user: unknown }) => {
    if (!hasRole(userOf(req), "manager")) throw new BoardError(403, "관리자 권한이 필요합니다.");
  };

  /**
   * 비회원 작성에 캡차를 요구한다.
   *
   * 회원은 요구하지 않는다 — 계정이 있으면 도배 방지와 계정 정지로 대응할 수 있고,
   * 매 글마다 캡차를 풀게 하면 정상 사용자가 떠난다.
   * 비회원은 추적 수단이 IP뿐이므로 캡차가 실질적인 유일한 방어다.
   */
  const requireCaptchaForGuest = async (
    user: SessionUser | null,
    body: { captchaToken?: string; captchaAnswer?: string } | undefined,
  ) => {
    if (user) return;
    if (!ctx.captcha.enabled) return;
    const passed = await ctx.captcha.verify(body?.captchaToken ?? "", body?.captchaAnswer ?? "");
    if (!passed) {
      throw new BoardError(400, "자동입력 방지 문자가 올바르지 않습니다. 다시 시도해주세요.");
    }
  };

  // ════════════════════════════════════════════════════
  //  공개 API
  // ════════════════════════════════════════════════════

  /** 게시판 목록 */
  ctx.registerRoute("GET", "/boards", async (req) => {
    const user = userOf(req);
    const { rows } = await db.execute(sql`
      SELECT slug, title, description, read_role, write_role, categories,
             (SELECT count(*) FROM board_posts p WHERE p.board_id = b.id) AS post_count
      FROM board_boards b WHERE is_visible = true ORDER BY sort_order, title
    `);
    // 읽을 수 없는 게시판은 목록에서 감춘다
    return rows.filter((b) => hasRole(user, String(b.read_role)));
  });

  /** 글 목록 */
  ctx.registerRoute("GET", "/boards/:slug/posts", async (req) => {
    const board = await loadBoard(db, req.params.slug);
    requireRole(userOf(req), board.read_role, "이 게시판 열람");
    return listPosts(db, {
      board,
      page: Number(req.query.page ?? 1),
      category: req.query.category,
      q: req.query.q,
      searchIn: req.query.in,
    });
  });

  /** 글 작성 */
  ctx.registerRoute("POST", "/boards/:slug/posts", async (req) => {
    const board = await loadBoard(db, req.params.slug);
    const user = userOf(req);
    requireRole(user, board.write_role, "글쓰기");
    await requireCaptchaForGuest(user, req.body as never);
    await checkWriteInterval(db, board, user, ipOf(req));

    const result = await createPost(db, {
      board,
      input: req.body as WritePostInput,
      user,
      ip: ipOf(req),
    });
    await ctx.hooks.doAction("board.post.created", {
      postId: result.id, board: board.slug, authorId: user?.id ?? null,
    });
    await ctx.cache.invalidateTag("pages"); // 목록 블록이 실린 페이지를 갱신
    return result;
  });

  /** 글 읽기 */
  ctx.registerRoute("GET", "/posts/:id", async (req) => {
    const { rows } = await db.execute(sql`
      SELECT p.*, b.slug AS board_slug, b.title AS board_title, b.read_role, b.download_role,
             b.allow_vote, b.allow_reply
      FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    const post = rows[0];
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");

    const user = userOf(req);
    requireRole(user, String(post.read_role), "이 게시판 열람");

    const guestPw = req.query.pw;
    if (!canReadSecret(post as never, user, guestPw)) {
      throw new BoardError(403, "비밀글입니다. 작성자만 열람할 수 있습니다.");
    }

    // 조회수는 읽기 권한을 통과한 뒤에만 올린다
    await db.execute(sql`
      UPDATE board_posts SET view_count = view_count + 1 WHERE id = ${req.params.id}::uuid
    `);

    const [attachments, comments] = await Promise.all([
      listAttachments(db, String(post.id)),
      db.execute(sql`
        SELECT id, parent_id, author_id, author_name, content, is_secret, depth, created_at
        FROM board_comments WHERE post_id = ${String(post.id)}::uuid ORDER BY created_at
      `).then((r) => r.rows),
    ]);

    // 내 투표·스크랩 상태 (있으면 UI가 표시)
    let myVote = 0;
    let scrapped = false;
    if (user) {
      const [{ rows: v }, { rows: sc }] = await Promise.all([
        db.execute(sql`
          SELECT value FROM board_votes WHERE post_id = ${String(post.id)}::uuid AND user_id = ${user.id}::uuid
        `),
        db.execute(sql`
          SELECT 1 FROM board_scraps WHERE post_id = ${String(post.id)}::uuid AND user_id = ${user.id}::uuid
        `),
      ]);
      myVote = Number(v[0]?.value ?? 0);
      scrapped = sc.length > 0;
    }

    // 비밀번호 해시는 절대 응답에 넣지 않는다
    const { guest_password: _pw, ...safe } = post as Record<string, unknown>;
    return {
      post: { ...safe, view_count: Number(post.view_count) + 1 },
      attachments,
      comments: comments.map((c) =>
        // 비밀댓글은 작성자·관리자만 내용을 본다
        c.is_secret && !hasRole(user, "manager") && !(user && user.id === c.author_id)
          ? { ...c, content: "비밀 댓글입니다." }
          : c,
      ),
      myVote,
      scrapped,
      canModify: hasRole(user, "manager") || Boolean(user && user.id === post.author_id),
    };
  });

  /** 글 수정 */
  ctx.registerRoute("PUT", "/posts/:id", async (req) => {
    const body = req.body as WritePostInput & { guestPassword?: string };
    const { rows } = await db.execute(sql`
      SELECT p.id, p.author_id, p.guest_password, b.categories, b.allow_secret
      FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    const post = rows[0];
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");
    assertCanModify(post as never, userOf(req), body.guestPassword);

    const title = String(body.title ?? "").trim();
    // 수정 경로에서도 새니타이즈를 빼먹으면 우회 통로가 된다
    const content = sanitizeHtml(String(body.content ?? "").trim());
    if (!title || !content.replace(/<[^>]*>/g, "").trim()) {
      throw new BoardError(400, "제목과 내용을 입력해주세요.");
    }

    const cats = Array.isArray(post.categories) ? (post.categories as string[]) : [];
    const category = body.category ? String(body.category).trim() : null;
    if (category && cats.length && !cats.includes(category)) {
      throw new BoardError(400, `허용되지 않는 분류입니다: ${category}`);
    }

    await db.execute(sql`
      UPDATE board_posts SET title = ${title}, content = ${content}, category = ${category},
        is_secret = ${Boolean(body.isSecret) && Boolean(post.allow_secret)}, updated_at = now()
      WHERE id = ${req.params.id}::uuid
    `);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  /** 글 삭제 — 첨부파일까지 정리한다 */
  ctx.registerRoute("DELETE", "/posts/:id", async (req) => {
    const body = (req.body ?? {}) as { guestPassword?: string };
    const { rows } = await db.execute(sql`
      SELECT id, author_id, guest_password FROM board_posts WHERE id = ${req.params.id}::uuid LIMIT 1
    `);
    const post = rows[0];
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");
    assertCanModify(post as never, userOf(req), body.guestPassword ?? req.query.pw);

    // 스토리지 파일은 CASCADE로 지워지지 않으므로 먼저 정리한다
    await deleteAttachments(db, ctx.storage, String(post.id));
    await db.execute(sql`DELETE FROM board_posts WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 첨부파일 ────────────────────────────────────────
  /** 업로드 (글 작성 후 별도 호출 — multipart) */
  ctx.registerRoute("POST", "/posts/:id/files", async (req) => {
    const { rows } = await db.execute(sql`
      SELECT p.id, p.author_id, p.guest_password, p.file_count, b.slug
      FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    const post = rows[0];
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");
    assertCanModify(post as never, userOf(req), req.query.pw);

    const board = await loadBoard(db, String(post.slug));
    const files = await req.files();
    if (!files.length) throw new BoardError(400, "첨부할 파일이 없습니다.");

    const saved = await attachFiles(db, ctx.storage, {
      postId: String(post.id),
      board,
      files,
      existingCount: Number(post.file_count),
    });
    return { ok: true, saved };
  });

  /** 다운로드 — 권한 검사 후 스토리지 URL로 안내 */
  ctx.registerRoute("GET", "/files/:id", async (req) => {
    const { rows } = await db.execute(sql`
      SELECT a.id, b.download_role FROM board_attachments a
      JOIN board_posts p ON p.id = a.post_id
      JOIN board_boards b ON b.id = p.board_id
      WHERE a.id = ${req.params.id}::uuid LIMIT 1
    `);
    if (!rows[0]) throw new BoardError(404, "파일을 찾을 수 없습니다.");
    requireRole(userOf(req), String(rows[0].download_role), "파일 다운로드");

    const file = await claimDownload(db, req.params.id);
    if (!file) throw new BoardError(404, "파일을 찾을 수 없습니다.");
    return {
      url: ctx.storage.publicUrl(file.storageKey),
      fileName: file.fileName,
      contentType: file.contentType,
    };
  });

  // ── 댓글 ────────────────────────────────────────────
  ctx.registerRoute("POST", "/posts/:id/comments", async (req) => {
    const body = req.body as {
      content: string; parentId?: string; isSecret?: boolean;
      guestName?: string; guestPassword?: string;
      captchaToken?: string; captchaAnswer?: string;
    };
    const { rows } = await db.execute(sql`
      SELECT p.id, b.slug, b.comment_role FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    const post = rows[0];
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");

    const user = userOf(req);
    requireRole(user, String(post.comment_role), "댓글 작성");
    await requireCaptchaForGuest(user, body);

    // 댓글은 서식을 허용하지 않는다 — 평문으로 저장하고 렌더 시 이스케이프한다.
    // (댓글에까지 HTML을 허용할 이유가 없고, 표면을 줄이는 것이 안전하다)
    const content = String(body.content ?? "").replace(/<[^>]*>/g, "").trim();
    if (!content) throw new BoardError(400, "댓글 내용을 입력해주세요.");
    if (content.length > 5000) throw new BoardError(400, "댓글이 너무 깁니다.");

    let guestName: string | null = null;
    let guestHash: string | null = null;
    if (!user) {
      guestName = String(body.guestName ?? "").trim();
      const pw = String(body.guestPassword ?? "");
      if (guestName.length < 2) throw new BoardError(400, "이름을 입력해주세요.");
      if (pw.length < 4) throw new BoardError(400, "비밀번호를 4자 이상 입력해주세요.");
      guestHash = hashGuestPassword(pw);
    }

    let depth = 0;
    if (body.parentId) {
      const { rows: parent } = await db.execute(sql`
        SELECT depth FROM board_comments WHERE id = ${body.parentId}::uuid AND post_id = ${String(post.id)}::uuid
      `);
      if (!parent[0]) throw new BoardError(404, "부모 댓글을 찾을 수 없습니다.");
      depth = Math.min(3, Number(parent[0].depth) + 1);
    }

    const id = uuidv7();
    // 댓글 수 집계를 함께 갱신한다 (목록에서 매번 count하지 않기 위해)
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO board_comments
          (id, post_id, parent_id, author_id, author_name, content, is_secret, depth, guest_name, guest_password)
        VALUES
          (${id}, ${String(post.id)}::uuid, ${body.parentId ?? null}::uuid, ${user?.id ?? null}::uuid,
           ${user ? user.displayName : guestName}, ${content}, ${Boolean(body.isSecret)}, ${depth},
           ${guestName}, ${guestHash})
      `);
      await tx.execute(sql`
        UPDATE board_posts SET comment_count = comment_count + 1 WHERE id = ${String(post.id)}::uuid
      `);
    });
    // 구독자가 누가 썼는지 알아야 한다 (포인트 적립 등). 비회원이면 null.
    await ctx.hooks.doAction("board.comment.created", {
      commentId: id,
      postId: String(post.id),
      board: String(post.slug),
      authorId: user?.id ?? null,
    });
    return { id };
  });

  ctx.registerRoute("DELETE", "/comments/:id", async (req) => {
    const body = (req.body ?? {}) as { guestPassword?: string };
    const { rows } = await db.execute(sql`
      SELECT id, post_id, author_id, guest_password FROM board_comments
      WHERE id = ${req.params.id}::uuid LIMIT 1
    `);
    const comment = rows[0];
    if (!comment) throw new BoardError(404, "댓글을 찾을 수 없습니다.");
    assertCanModify(comment as never, userOf(req), body.guestPassword ?? req.query.pw);

    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM board_comments WHERE id = ${req.params.id}::uuid`);
      await tx.execute(sql`
        UPDATE board_posts SET comment_count = greatest(0, comment_count - 1)
        WHERE id = ${String(comment.post_id)}::uuid
      `);
    });
    return { ok: true };
  });

  // ── 추천 / 비추천 ───────────────────────────────────
  ctx.registerRoute("POST", "/posts/:id/vote", async (req) => {
    const user = userOf(req);
    if (!user) throw new BoardError(401, "추천에는 로그인이 필요합니다.");
    const value = Number((req.body as { value?: number })?.value);
    if (value !== 1 && value !== -1) throw new BoardError(400, "value는 1 또는 -1이어야 합니다.");

    const { rows } = await db.execute(sql`
      SELECT p.id, b.allow_vote FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    if (!rows[0]) throw new BoardError(404, "글을 찾을 수 없습니다.");
    if (!rows[0].allow_vote) throw new BoardError(400, "이 게시판은 추천을 허용하지 않습니다.");

    // 1인 1표: 같은 값을 다시 누르면 취소, 다른 값이면 변경.
    // 집계 컬럼과 투표 테이블을 한 트랜잭션에서 맞춘다.
    return db.transaction(async (tx) => {
      const { rows: existing } = await tx.execute(sql`
        SELECT value FROM board_votes
        WHERE post_id = ${req.params.id}::uuid AND user_id = ${user.id}::uuid FOR UPDATE
      `);
      const prev = existing[0] ? Number(existing[0].value) : 0;

      if (prev === value) {
        await tx.execute(sql`
          DELETE FROM board_votes WHERE post_id = ${req.params.id}::uuid AND user_id = ${user.id}::uuid
        `);
      } else if (prev === 0) {
        await tx.execute(sql`
          INSERT INTO board_votes (post_id, user_id, value)
          VALUES (${req.params.id}::uuid, ${user.id}::uuid, ${value})
        `);
      } else {
        await tx.execute(sql`
          UPDATE board_votes SET value = ${value}
          WHERE post_id = ${req.params.id}::uuid AND user_id = ${user.id}::uuid
        `);
      }

      // 집계를 다시 계산한다 (증감 누적보다 정확하다)
      const { rows: agg } = await tx.execute(sql`
        UPDATE board_posts SET
          up_count   = (SELECT count(*) FROM board_votes v WHERE v.post_id = board_posts.id AND v.value = 1),
          down_count = (SELECT count(*) FROM board_votes v WHERE v.post_id = board_posts.id AND v.value = -1)
        WHERE id = ${req.params.id}::uuid
        RETURNING up_count, down_count
      `);
      return {
        up: Number(agg[0]?.up_count ?? 0),
        down: Number(agg[0]?.down_count ?? 0),
        myVote: prev === value ? 0 : value,
      };
    });
  });

  // ── 스크랩 ──────────────────────────────────────────
  /**
   * 스크랩 토글.
   * 이미 스크랩했으면 해제한다 — 별도 API를 두지 않아 UI가 단순해진다.
   */
  ctx.registerRoute("POST", "/posts/:id/scrap", async (req) => {
    const user = userOf(req);
    if (!user) throw new BoardError(401, "스크랩에는 로그인이 필요합니다.");

    // 읽을 수 있는 글만 스크랩할 수 있다
    const { rows } = await db.execute(sql`
      SELECT p.id, b.read_role FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      WHERE p.id = ${req.params.id}::uuid LIMIT 1
    `);
    if (!rows[0]) throw new BoardError(404, "글을 찾을 수 없습니다.");
    requireRole(user, String(rows[0].read_role), "이 게시판 열람");

    return db.transaction(async (tx) => {
      const { rows: existing } = await tx.execute(sql`
        DELETE FROM board_scraps
        WHERE user_id = ${user.id}::uuid AND post_id = ${req.params.id}::uuid
        RETURNING post_id
      `);
      const scrapped = existing.length === 0;
      if (scrapped) {
        await tx.execute(sql`
          INSERT INTO board_scraps (user_id, post_id) VALUES (${user.id}::uuid, ${req.params.id}::uuid)
          ON CONFLICT DO NOTHING
        `);
      }
      // 집계는 다시 센다 (증감 누적보다 정확하다)
      const { rows: agg } = await tx.execute(sql`
        UPDATE board_posts SET scrap_count =
          (SELECT count(*) FROM board_scraps s WHERE s.post_id = board_posts.id)
        WHERE id = ${req.params.id}::uuid RETURNING scrap_count
      `);
      return { scrapped, count: Number(agg[0]?.scrap_count ?? 0) };
    });
  });

  /** 내 스크랩 목록 */
  ctx.registerRoute("GET", "/my/scraps", async (req) => {
    const user = userOf(req);
    if (!user) throw new BoardError(401, "로그인이 필요합니다.");
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 20;
    const { rows } = await db.execute(sql`
      SELECT p.id, p.title, p.author_name, p.created_at, p.comment_count,
             b.slug AS board_slug, b.title AS board_title, s.created_at AS scrapped_at
      FROM board_scraps s
      JOIN board_posts p ON p.id = s.post_id
      JOIN board_boards b ON b.id = p.board_id
      WHERE s.user_id = ${user.id}::uuid
      ORDER BY s.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
    `);
    const { rows: cnt } = await db.execute(sql`
      SELECT count(*) AS n FROM board_scraps WHERE user_id = ${user.id}::uuid
    `);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: size };
  });

  // ── RSS ─────────────────────────────────────────────
  ctx.registerRoute("GET", "/boards/:slug/rss", async (req) => {
    const board = await loadBoard(db, req.params.slug);
    // 비공개 게시판은 RSS를 제공하지 않는다 (로그인 없이 접근되는 경로다)
    if (board.read_role !== "guest") throw new BoardError(403, "이 게시판은 RSS를 제공하지 않습니다.");
    const { rows } = await db.execute(sql`
      SELECT id, title, author_name, created_at, content
      FROM board_posts WHERE board_id = ${board.id}::uuid AND is_secret = false
      ORDER BY created_at DESC LIMIT 30
    `);
    const items = rows
      .map(
        (r) => `    <item>
      <title>${escapeHtml(r.title)}</title>
      <link>/board/${escapeHtml(board.slug)}/${escapeHtml(r.id)}</link>
      <guid isPermaLink="false">${escapeHtml(r.id)}</guid>
      <author>${escapeHtml(r.author_name ?? "")}</author>
      <pubDate>${new Date(String(r.created_at)).toUTCString()}</pubDate>
      <description>${escapeHtml(toPlainText(String(r.content ?? ""), 300))}</description>
    </item>`,
      )
      .join("\n");
    return rawResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(board.title)}</title>
    <description>${escapeHtml(board.description ?? "")}</description>
    <link>/board/${escapeHtml(board.slug)}</link>
${items}
  </channel>
</rss>`,
      "application/rss+xml; charset=utf-8",
    );
  });

  // ════════════════════════════════════════════════════
  //  관리자 API
  // ════════════════════════════════════════════════════
  ctx.registerRoute("GET", "/admin/boards", async (req) => {
    requireManager(req);
    const { rows } = await db.execute(sql`
      SELECT id, slug, title, description, read_role, write_role, comment_role, download_role,
             categories, page_size, allow_reply, allow_secret, allow_vote, allow_upload,
             max_files, write_interval, sort_order, is_visible,
             (SELECT count(*) FROM board_posts p WHERE p.board_id = b.id) AS post_count
      FROM board_boards b ORDER BY sort_order, title
    `);
    // 관리 화면의 배열 필드는 편집 편의를 위해 쉼표 문자열로 바꿔 보낸다
    return {
      items: rows.map((r) => ({
        ...r,
        categories: Array.isArray(r.categories) ? (r.categories as string[]).join(", ") : "",
      })),
      total: rows.length,
    };
  });

  const parseBoard = (b: Record<string, unknown>) => {
    const slug = String(b.slug ?? "").trim();
    if (!SLUG_RE.test(slug)) {
      throw new BoardError(400, "주소(slug)는 영문 소문자/숫자/하이픈 2~50자로 입력해주세요.");
    }
    if (!String(b.title ?? "").trim()) throw new BoardError(400, "게시판 이름을 입력해주세요.");

    const roles = ["guest", "member", "manager", "admin"];
    const role = (v: unknown, fallback: string) => {
      const s = String(v ?? fallback);
      if (!roles.includes(s)) throw new BoardError(400, `알 수 없는 권한입니다: ${s}`);
      return s;
    };
    const num = (v: unknown, fallback: number, min: number, max: number) => {
      const n = Math.floor(Number(v ?? fallback));
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new BoardError(400, `값이 허용 범위를 벗어났습니다 (${min}~${max}).`);
      }
      return n;
    };
    // 쉼표 문자열 → 배열
    const categories = String(b.categories ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30);

    return {
      slug,
      title: String(b.title).trim().slice(0, 200),
      description: String(b.description ?? "").trim() || null,
      readRole: role(b.read_role, "guest"),
      writeRole: role(b.write_role, "member"),
      commentRole: role(b.comment_role, "member"),
      downloadRole: role(b.download_role, "member"),
      categories,
      pageSize: num(b.page_size, 20, 5, 100),
      allowReply: b.allow_reply !== false,
      allowSecret: b.allow_secret !== false,
      allowVote: b.allow_vote !== false,
      allowUpload: b.allow_upload !== false,
      maxFiles: num(b.max_files, 3, 0, 10),
      writeInterval: num(b.write_interval, 5, 0, 3600),
      sortOrder: num(b.sort_order, 0, -9999, 9999),
      isVisible: b.is_visible !== false,
    };
  };

  ctx.registerRoute("POST", "/admin/boards", async (req) => {
    requireManager(req);
    const v = parseBoard(req.body as Record<string, unknown>);
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO board_boards (
          id, slug, title, description, read_role, write_role, comment_role, download_role,
          categories, page_size, allow_reply, allow_secret, allow_vote, allow_upload,
          max_files, write_interval, sort_order, is_visible
        ) VALUES (
          ${id}, ${v.slug}, ${v.title}, ${v.description}, ${v.readRole}, ${v.writeRole},
          ${v.commentRole}, ${v.downloadRole}, ${JSON.stringify(v.categories)}::jsonb, ${v.pageSize},
          ${v.allowReply}, ${v.allowSecret}, ${v.allowVote}, ${v.allowUpload},
          ${v.maxFiles}, ${v.writeInterval}, ${v.sortOrder}, ${v.isVisible}
        )
      `);
    } catch (err) {
      if (isUniqueViolation(err, "board_boards_slug")) {
        throw new BoardError(409, `이미 사용 중인 주소입니다: ${v.slug}`);
      }
      throw err;
    }
    await ctx.cache.invalidateTag("pages");
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/boards/:id", async (req) => {
    requireManager(req);
    const v = parseBoard(req.body as Record<string, unknown>);
    try {
      const { rows } = await db.execute(sql`
        UPDATE board_boards SET
          slug = ${v.slug}, title = ${v.title}, description = ${v.description},
          read_role = ${v.readRole}, write_role = ${v.writeRole},
          comment_role = ${v.commentRole}, download_role = ${v.downloadRole},
          categories = ${JSON.stringify(v.categories)}::jsonb, page_size = ${v.pageSize},
          allow_reply = ${v.allowReply}, allow_secret = ${v.allowSecret},
          allow_vote = ${v.allowVote}, allow_upload = ${v.allowUpload},
          max_files = ${v.maxFiles}, write_interval = ${v.writeInterval},
          sort_order = ${v.sortOrder}, is_visible = ${v.isVisible}
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new BoardError(404, "게시판을 찾을 수 없습니다.");
    } catch (err) {
      if (isUniqueViolation(err, "board_boards_slug")) {
        throw new BoardError(409, `이미 사용 중인 주소입니다: ${v.slug}`);
      }
      throw err;
    }
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/boards/:id", async (req) => {
    requireManager(req);
    // 게시판을 지우면 글·댓글은 CASCADE로 사라지지만 스토리지 파일은 남는다
    const { rows } = await db.execute(sql`
      SELECT a.storage_key FROM board_attachments a
      JOIN board_posts p ON p.id = a.post_id
      WHERE p.board_id = ${req.params.id}::uuid
    `);
    for (const row of rows) await ctx.storage.delete(String(row.storage_key)).catch(() => undefined);
    await db.execute(sql`DELETE FROM board_boards WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true, deletedFiles: rows.length };
  });

  /** 관리자 글 목록 (전 게시판 통합 — 스팸 정리용) */
  ctx.registerRoute("GET", "/admin/posts", async (req) => {
    requireManager(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT p.id, b.title AS board, p.title, p.author_name, p.created_at,
             p.view_count, p.comment_count, p.is_notice, p.is_secret
      FROM board_posts p JOIN board_boards b ON b.id = p.board_id
      ORDER BY p.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM board_posts`);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: 30 };
  });

  ctx.registerRoute("DELETE", "/admin/posts/:id", async (req) => {
    requireManager(req);
    await deleteAttachments(db, ctx.storage, req.params.id);
    await db.execute(sql`DELETE FROM board_posts WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ════════════════════════════════════════════════════
  ctx.registerAdminResource(BOARD_RESOURCE);
  ctx.registerAdminResource(POST_RESOURCE);
  /**
   * 회원 탈퇴 시 게시판 데이터 처리.
   *
   * 기본은 **남긴다.** 토론이 통째로 사라지면 남은 사람들의 글이 읽을 수 없게 된다.
   * 남길 때도 작성자는 익명화한다 — author_id 만 끊으면 목록에 실명이 계속 보이므로
   * 스냅샷으로 저장된 author_name 도 함께 바꿔야 한다.
   */
  ctx.registerDataEraser({
    label: "게시판",
    order: 20,
    async erase({ tx, userId, deletePosts }) {
      const done: string[] = [];

      if (deletePosts) {
        const { rows: posts } = await tx.execute(sql`
          DELETE FROM board_posts WHERE author_id = ${userId}::uuid RETURNING id
        `);
        if (posts.length) done.push(`게시글 ${posts.length}건 삭제`);
        const { rows: cmts } = await tx.execute(sql`
          DELETE FROM board_comments WHERE author_id = ${userId}::uuid RETURNING id
        `);
        if (cmts.length) done.push(`댓글 ${cmts.length}건 삭제`);
      } else {
        const { rows: posts } = await tx.execute(sql`
          UPDATE board_posts SET author_id = NULL, author_name = '탈퇴한 회원'
          WHERE author_id = ${userId}::uuid RETURNING id
        `);
        if (posts.length) done.push(`게시글 ${posts.length}건 작성자 익명화 (내용 유지)`);
        const { rows: cmts } = await tx.execute(sql`
          UPDATE board_comments SET author_id = NULL, author_name = '탈퇴한 회원'
          WHERE author_id = ${userId}::uuid RETURNING id
        `);
        if (cmts.length) done.push(`댓글 ${cmts.length}건 작성자 익명화`);
      }

      // 스크랩·추천은 개인의 행동 기록이다. 보존 의무가 없고 남길 이유도 없다.
      await tx.execute(sql`DELETE FROM board_scraps WHERE user_id = ${userId}::uuid`);
      await tx.execute(sql`DELETE FROM board_votes WHERE user_id = ${userId}::uuid`);
      done.push("스크랩·추천 기록 삭제");
      return done;
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT (SELECT count(*) FROM board_posts WHERE author_id = ${userId}::uuid) AS posts,
               (SELECT count(*) FROM board_comments WHERE author_id = ${userId}::uuid) AS comments
      `);
      const posts = Number(rows[0]?.posts ?? 0);
      const comments = Number(rows[0]?.comments ?? 0);
      if (!posts && !comments) return [];
      return [{
        label: "작성한 글",
        detail: `게시글 ${posts}건, 댓글 ${comments}건. 남기면 작성자가 "탈퇴한 회원"으로 ` +
                `바뀌고, 지우면 복구할 수 없습니다.`,
      }];
    },
  });

  /**
   * 사이트맵: 공개 게시판의 글 주소.
   *
   * 비밀글과 비공개 게시판은 제외한다 — 검색엔진에 노출되면 안 되는 것이
   * 사이트맵에 들어가면 그 자체가 유출이다.
   *
   * 주소는 `/board/<slug>` 관례를 쓴다. views.ts 의 링크 생성과 같은 규칙이므로
   * 어긋나면 목록 링크도 같이 깨진다(둘 중 하나만 틀릴 수는 없다).
   * 정렬은 created_at + id 로 고정한다. 페이지를 나눠 읽는 동안 순서가 바뀌면
   * 어떤 글은 두 번 나오고 어떤 글은 빠진다.
   */
  /**
   * 통합검색 — 게시글.
   *
   * **권한이 가장 중요하다.** 검색은 권한 검사를 우회하는 가장 흔한 경로다.
   * 제목만 목록에 나와도 내용이 새어 나가는 경우가 있다(비밀글 제목,
   * 비공개 게시판의 존재).
   *
   * 거르는 것:
   *   - 비밀글 — 작성자와 관리자만 본다. 검색 결과에서는 **전부 제외**한다.
   *     작성자에게만 보여주는 것도 가능하지만, 검색 결과에 자기 비밀글이
   *     섞이면 그것을 남에게 보여주며 화면을 공유할 때 새어 나간다.
   *   - 읽기 권한이 부족한 게시판 — 등급으로 판단한다.
   *
   * `count` 와 `search` 가 **같은 조건**을 쓰도록 조건을 한 곳에 둔다 —
   * 다르면 "37건" 이라 표시하고 20건만 보여주게 된다.
   */
  const postSearchWhere = (query: string, viewer: { role: string } | null) => {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rank = rankOf(viewer?.role ?? "guest");
    return sql`
      p.is_secret = false
      -- 읽기 권한을 등급으로 비교한다. 문자열 비교로는 순서를 알 수 없다.
      -- 모르는 값은 3(admin)으로 봐서 **막는 쪽으로** 실패한다 — 오타 하나로
      -- 비공개 게시판이 열리면 안 된다.
      AND CASE b.read_role
            WHEN 'guest' THEN 0 WHEN 'member' THEN 1
            WHEN 'manager' THEN 2 WHEN 'admin' THEN 3 ELSE 3
          END <= ${rank}
      AND (p.title ILIKE ${like} OR p.content ILIKE ${like})
    `;
  };

  ctx.registerSearchSource({
    label: "게시글",
    code: "posts",
    order: 10,
    async count({ query, viewer }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM board_posts p
        JOIN board_boards b ON b.id = p.board_id
        WHERE ${postSearchWhere(query, viewer)}
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async search({ query, viewer, offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT p.id, p.title, p.content, p.created_at, b.slug AS board_slug, b.title AS board_title
        FROM board_posts p
        JOIN board_boards b ON b.id = p.board_id
        WHERE ${postSearchWhere(query, viewer)}
        -- 정렬을 고정한다 — 안 하면 페이지를 넘길 때 같은 글이 두 번 나온다
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/board/${String(r.board_slug)}/${String(r.id)}`,
        title: String(r.title),
        excerpt: searchExcerpt(String(r.content ?? ""), query),
        date: r.created_at as Date,
        meta: String(r.board_title),
      }));
    },
  });

  ctx.registerSitemapSource({
    label: "게시글",
    async count() {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM board_posts p
        JOIN board_boards b ON b.id = p.board_id
        WHERE p.is_secret = false AND b.read_role = 'guest'
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async page({ offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT b.slug AS board, p.id, p.updated_at
        FROM board_posts p
        JOIN board_boards b ON b.id = p.board_id
        WHERE p.is_secret = false AND b.read_role = 'guest'
        ORDER BY p.created_at, p.id
        LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/board/${String(r.board)}/${String(r.id)}`,
        lastmod: r.updated_at as Date,
        changefreq: "weekly" as const,
        priority: 0.6,
      }));
    },
  });

  registerBoardBlocks(ctx, db);

  return {};
});
