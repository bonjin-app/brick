import { sql } from "drizzle-orm";
import type { BoardRow, Db, SessionUser } from "./types.js";
import { BoardError, effectiveReadRole, hasRole } from "./types.js";
/**
 * 비회원 비밀번호 확인 — 호출하는 쪽이 대입 방어(checkGuestSecret)를 씌워 넘긴다.
 * 이 파일은 요청(IP)을 모르므로 확인 방법을 받아 쓴다.
 */
export type GuestCheck = (password: string, stored: string | null) => Promise<boolean>;
import { t } from "./i18n.js";

/** slug로 게시판을 읽고, 없으면 404 */
/**
 * 게시판 한 줄 — 없으면 null.
 *
 * **loadBoard 와 같은 질의를 두 벌 두지 않는다.** 예전에는 블록 쪽에 복사본이
 * 있었고, 새 칸(여분 필드)을 더했을 때 한쪽만 고쳐져서 저장은 되는데 손님
 * 화면에는 나오지 않았다 — 이 저장소가 몇 번이나 겪은 함정이다.
 */
export async function selectBoard(db: Db, slug: string): Promise<BoardRow | null> {
  if (!slug) return null;
  const { rows } = await db.execute(sql`
    SELECT b.id, b.slug, b.title, b.description, b.read_role, b.write_role, b.comment_role, b.download_role,
           b.categories, b.page_size, b.allow_reply, b.allow_secret, b.allow_vote, b.allow_upload,
           b.max_files, b.write_interval, b.list_style, b.notify_email, b.notify_comment, b.category_required,
           b.extra_fields, b.cert_required, b.count_delete, b.count_modify,
           ARRAY(SELECT m.user_id::text FROM board_moderators m WHERE m.board_id = b.id) AS moderator_ids,
           b.group_id, g.title AS group_title, g.read_role AS group_read_role
    FROM board_boards b LEFT JOIN board_groups g ON g.id = b.group_id
    WHERE b.slug = ${slug} AND b.is_visible = true LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row as unknown as BoardRow),
    categories: Array.isArray(row.categories) ? (row.categories as string[]) : [],
    // 그룹 권한과 합친 실효 읽기 권한 — 이후의 모든 검사가 이 값을 쓴다
    read_role: effectiveReadRole(row.read_role, row.group_read_role),
  };
}

/** 게시판 한 줄 — 없으면 404 로 끝낸다 (라우트가 쓴다) */
export async function loadBoard(db: Db, slug: string): Promise<BoardRow> {
  const row = await selectBoard(db, slug);
  if (!row) throw new BoardError(404, "게시판을 찾을 수 없습니다.");
  return row;
}


/**
 * 이 게시판 안의 권한 검사에 쓸 사용자 — **게시판 관리자**(운영자가 이 게시판에 지정한 회원)면 운영진으로 본다.
 *
 * 게시판 안의 검사(다른 사람 글 고치기·지우기, 비밀글, 공지, 도배 제한, 본인인증 요구)는 전부 "운영진인가" 를 묻는다.
 * 검사마다 게시판 관리자 조건을 덧붙이면 새 검사가 생길 때마다 빠뜨린다 — 그래서 게시판을 읽은 자리에서 한 번
 * 바꿔 넘긴다. **게시판 밖(관리 API·다른 게시판)에는 이 값을 넘기지 않는다** — 원래 사용자로 검사한다.
 */
export function boardActor(user: SessionUser | null, board: { moderator_ids?: string[] | null }): SessionUser | null {
  if (!user || hasRole(user, "manager")) return user;
  return (board.moderator_ids ?? []).includes(user.id) ? { ...user, role: "manager" } : user;
}

/** 권한 검사 — 부족하면 401(비로그인) 또는 403(권한 부족)으로 구분해 던진다 */
export function requireRole(
  user: SessionUser | null,
  required: string,
  what: string,
): void {
  if (hasRole(user, required)) return;
  // 로그인만 하면 되는 경우와 등급이 부족한 경우를 구분해야 사용자가 조치할 수 있다
  /*
   * `what` 은 **카탈로그 키**다("act.write"). 예전에는 한국어 문구를 그대로
   * 받아 문장에 끼웠는데, 그러면 영어 사이트에서 "Signing in is required for
   * 글쓰기" 처럼 반쪽이 된다 — 문장과 그 안의 낱말이 같은 카탈로그를 타야 한다.
   */
  const act = t(what);
  if (!user) throw new BoardError(401, t("err.loginFor", { act }));
  throw new BoardError(403, t("err.noPermFor", { act }));
}

/** 본인인증 상태를 묻는 방법 — 라우트·블록이 `ctx.identity.status` 를 넘긴다 */
export type IdentityOf = (userId: string) => Promise<{ verified: boolean; adult: boolean }>;

/**
 * 게시판의 본인인증 요구(그누보드 bo_use_cert) — 목록·글·댓글·첨부·쓰기 모두 이것을 먼저 통과한다.
 *
 * 운영진(manager 이상)은 통과한다 — 게시판을 관리할 사람이 자기 인증 때문에 신고 글을 못 보면 안 된다.
 * 거절은 `field: "identity"` 를 실어 화면이 본인인증으로 가는 길을 붙이게 한다.
 */
export async function requireCert(
  board: { cert_required?: string | null },
  user: SessionUser | null,
  identityOf: IdentityOf,
): Promise<void> {
  const need = String(board.cert_required ?? "");
  if (!need || hasRole(user, "manager")) return;
  if (!user) throw new BoardError(401, t("err.certLogin"));
  const s = await identityOf(user.id);
  if (need === "adult" && !s.adult) {
    throw new BoardError(403, s.verified ? t("err.certMinor") : t("err.certAdult"), "identity");
  }
  if (!s.verified) throw new BoardError(403, t("err.certVerified"), "identity");
}

/** 서버 렌더용 — 막혔으면 안내할 말(카탈로그 키), 통과면 null */
export async function certBlock(
  board: { cert_required?: string | null },
  user: SessionUser | null,
  identityOf: IdentityOf,
): Promise<{ key: string; login: boolean; verify: boolean } | null> {
  try {
    await requireCert(board, user, identityOf);
    return null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const need = String(board.cert_required ?? "");
    if (status === 401) return { key: "err.certLogin", login: true, verify: false };
    const msg = (err as Error).message;
    if (msg === t("err.certMinor")) return { key: "err.certMinor", login: false, verify: false };
    return { key: need === "adult" ? "err.certAdult" : "err.certVerified", login: false, verify: true };
  }
}

/**
 * 도배 방지.
 * 게시판별 write_interval 초 안에 다시 쓰지 못하게 한다.
 * 비회원은 IP로, 회원은 계정으로 판단한다.
 */
export async function checkWriteInterval(
  db: Db,
  board: BoardRow,
  user: SessionUser | null,
  ip: string | null,
): Promise<void> {
  if (board.write_interval <= 0) return;
  // 관리자는 제한하지 않는다 (공지 연속 등록 등)
  if (hasRole(user, "manager")) return;

  const who = user
    ? sql`author_id = ${user.id}::uuid`
    : sql`author_id IS NULL AND author_ip = ${ip ?? ""}`;
  // 게시판별로 검사한다. board_id를 빼면 다른 게시판에 쓴 것 때문에 막혀
  // "왜 못 쓰는지 알 수 없는" 상태가 된다 (그누보드도 게시판별 설정이다).
  const { rows } = await db.execute(sql`
    SELECT created_at FROM board_posts
    WHERE board_id = ${board.id}::uuid
      AND ${who}
      AND created_at > now() - (${board.write_interval} || ' seconds')::interval
    ORDER BY created_at DESC LIMIT 1
  `);
  if (rows.length) {
    throw new BoardError(429, t("err.tooFast", { seconds: board.write_interval }));
  }
}

/**
 * 글 수정/삭제 권한.
 *
 * 회원 글  → 작성자 본인 또는 manager 이상
 * 비회원 글 → 비밀번호 일치 또는 manager 이상
 */
/**
 * 수정·삭제 버튼을 보여줄 것인가.
 *
 * **집행(assertCanModify)과 같은 규칙을 한 곳에 둔다.** 전에는 세 곳에 따로
 * 적혀 있었고 그중 하나가 달랐다 — API 응답의 `canModify` 는 비회원 글에
 * false 라고 말했는데(집행은 비밀번호로 허용한다), 그 필드를 읽는 화면이
 * 없어서 아무도 몰랐다. 누가 그것을 믿고 화면을 만들면 비회원이 자기 글을
 * 고칠 버튼을 잃는다.
 *
 * 비회원 글은 버튼을 보여주고 **누른 뒤 비밀번호를 묻는다** — 그것이 집행의
 * 모양이고, 화면도 그래야 한다.
 */
export function canModifyPost(
  post: { author_id: string | null },
  user: SessionUser | null,
): boolean {
  if (hasRole(user, "manager")) return true;
  if (!post.author_id) return true; // 비회원 글 — 비밀번호로 확인한다
  return Boolean(user && user.id === post.author_id);
}

export async function assertCanModify(
  post: { author_id: string | null; guest_password: string | null },
  user: SessionUser | null,
  guestPassword: string | undefined,
  check: GuestCheck,
): Promise<void> {
  if (hasRole(user, "manager")) return;

  if (post.author_id) {
    if (user && user.id === post.author_id) return;
    throw new BoardError(403, "본인이 작성한 글만 수정·삭제할 수 있습니다.");
  }
  // 비회원 글
  if (!guestPassword) throw new BoardError(401, "비밀번호를 입력해주세요.");
  if (!(await check(guestPassword, post.guest_password))) {
    throw new BoardError(403, "비밀번호가 일치하지 않습니다.");
  }
}

/**
 * 작성자가 지금 이 글을 지우거나 고쳐도 되는가 — 권한(assertCanModify)을 통과한 **뒤에** 본다.
 * 운영진(그 게시판 관리자 포함)은 해당하지 않는다. 그누보드 bbs/delete.php 와 같은 두 가지:
 *
 *  - 답변글이 달린 글은 지우지 못한다 — 답변글이 원글 없이 남는다("답변글부터 지워 주세요").
 *  - 다른 사람의 댓글이 게시판의 한도(count_delete · count_modify) 이상 달린 글은 지우지·고치지 못한다 —
 *    토론이 달린 글을 작성자가 통째로 없애거나 바꾸면 남은 댓글이 무엇에 대한 것인지 사라진다. 0 은 제한 없음.
 */
export async function assertAuthorMayChange(
  db: Pick<Db, "execute">,
  post: Record<string, unknown>, // id · thread_id · thread_path · author_id · count_delete · count_modify
  user: SessionUser | null,
  action: "delete" | "modify",
): Promise<void> {
  if (hasRole(user, "manager")) return;
  if (action === "delete") {
    const path = String(post.thread_path ?? "");
    const { rows } = await db.execute(sql`
      SELECT 1 FROM board_posts
      WHERE thread_id = ${String(post.thread_id ?? post.id)}::uuid AND id <> ${String(post.id)}::uuid
        AND (${path} = '' OR thread_path LIKE ${`${path}.%`})
      LIMIT 1
    `);
    if (rows.length) throw new BoardError(409, "답변글이 달린 글은 지울 수 없습니다. 답변글부터 지워 주세요.");
  }
  const limit = Number(action === "delete" ? post.count_delete : post.count_modify) || 0;
  if (limit <= 0) return;
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS n FROM board_comments
    WHERE post_id = ${String(post.id)}::uuid AND deleted_at IS NULL
      AND (${post.author_id ? String(post.author_id) : null}::uuid IS NULL OR author_id IS DISTINCT FROM ${post.author_id ? String(post.author_id) : null}::uuid)
  `);
  if (Number(rows[0]?.n ?? 0) >= limit) {
    throw new BoardError(409, t(action === "delete" ? "err.countDelete" : "err.countModify", { n: limit }));
  }
}

/**
 * 비밀댓글을 읽을 수 있는 사람 — 댓글 작성자, **원글 작성자**(비밀댓글은 대개 글쓴이에게 하는 말이다:
 * 연락처·주문 문의), 답글이면 **부모 댓글 작성자**(비밀 답글을 받는 사람), 운영진(그 게시판 관리자 포함 —
 * 호출하는 쪽이 게시판이 보는 사용자를 넘긴다). 전에는 댓글 작성자와 운영진만 읽어, 글쓴이가 자기 글에
 * 달린 비밀댓글을 읽지 못하고 질문자도 비밀 답글을 읽지 못했다. API 와 화면이 이 함수 하나를 쓴다.
 */
export function canSeeSecretComment(
  comment: Record<string, unknown>, // is_secret · author_id · parent_id
  post: Record<string, unknown>, // author_id
  user: SessionUser | null,
  authorOf: (commentId: string) => unknown,
): boolean {
  if (!comment.is_secret) return true;
  if (hasRole(user, "manager")) return true;
  if (!user) return false;
  if (user.id === comment.author_id || user.id === post.author_id) return true;
  return Boolean(comment.parent_id) && user.id === authorOf(String(comment.parent_id));
}

/**
 * 비밀글 열람 권한.
 * 작성자·manager 이상만 볼 수 있다. 비회원 비밀글은 비밀번호로 확인한다.
 *
 * **답변글이면 그 스레드의 원글 작성자도** 읽는다(비회원 원글이면 원글의 비밀번호로). 비밀글로 문의하고
 * 운영자가 비밀 답변글을 달면, 전에는 질문한 사람이 그 답을 읽지 못했다 — 그누보드가 같은 이유로 고친
 * 자리다(bbs/board.php "회원이 비밀글을 올리고 관리자가 답변글을 올렸을 경우"). 원글은 `db` 를 넘길 때만 찾는다.
 */
export async function canReadSecret(
  post: { id?: unknown; thread_id?: unknown; author_id: string | null; guest_password: string | null; is_secret: boolean },
  user: SessionUser | null,
  guestPassword: string | undefined,
  check: GuestCheck,
  db?: Pick<Db, "execute">,
): Promise<boolean> {
  if (!post.is_secret) return true;
  if (hasRole(user, "manager")) return true;
  if (post.author_id && user && user.id === post.author_id) return true;
  if (!post.author_id && guestPassword && (await check(guestPassword, post.guest_password))) return true;
  if (!db || !post.thread_id || String(post.thread_id) === String(post.id)) return false;
  const { rows } = await db.execute(sql`
    SELECT author_id, guest_password FROM board_posts WHERE id = ${String(post.thread_id)}::uuid LIMIT 1
  `);
  const root = rows[0];
  if (!root) return false;
  if (root.author_id) return Boolean(user && user.id === String(root.author_id));
  return Boolean(guestPassword) && (await check(String(guestPassword), (root.guest_password as string | null) ?? null));
}
