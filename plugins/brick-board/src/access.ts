import { sql } from "drizzle-orm";
import type { BoardRow, Db, SessionUser } from "./types.js";
import { BoardError, effectiveReadRole, hasRole } from "./types.js";
import { verifyGuestPassword } from "./guest.js";

/** slug로 게시판을 읽고, 없으면 404 */
export async function loadBoard(db: Db, slug: string): Promise<BoardRow> {
  const { rows } = await db.execute(sql`
    SELECT b.id, b.slug, b.title, b.description, b.read_role, b.write_role, b.comment_role, b.download_role,
           b.categories, b.page_size, b.allow_reply, b.allow_secret, b.allow_vote, b.allow_upload,
           b.max_files, b.write_interval, b.list_style, b.notify_email, b.notify_comment,
           b.group_id, g.title AS group_title, g.read_role AS group_read_role
    FROM board_boards b LEFT JOIN board_groups g ON g.id = b.group_id
    WHERE b.slug = ${slug} AND b.is_visible = true LIMIT 1
  `);
  const row = rows[0];
  if (!row) throw new BoardError(404, "게시판을 찾을 수 없습니다.");
  return {
    ...(row as unknown as BoardRow),
    categories: Array.isArray(row.categories) ? (row.categories as string[]) : [],
    // 그룹 권한과 합친 실효 읽기 권한 — 이후의 모든 검사가 이 값을 쓴다
    read_role: effectiveReadRole(row.read_role, row.group_read_role),
    };
}

/** 권한 검사 — 부족하면 401(비로그인) 또는 403(권한 부족)으로 구분해 던진다 */
export function requireRole(
  user: SessionUser | null,
  required: string,
  what: string,
): void {
  if (hasRole(user, required)) return;
  // 로그인만 하면 되는 경우와 등급이 부족한 경우를 구분해야 사용자가 조치할 수 있다
  if (!user) throw new BoardError(401, `${what}에는 로그인이 필요합니다.`);
  throw new BoardError(403, `${what} 권한이 없습니다.`);
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
    throw new BoardError(429, `너무 빠르게 작성했습니다. ${board.write_interval}초 후 다시 시도해주세요.`);
  }
}

/**
 * 글 수정/삭제 권한.
 *
 * 회원 글  → 작성자 본인 또는 manager 이상
 * 비회원 글 → 비밀번호 일치 또는 manager 이상
 */
export function assertCanModify(
  post: { author_id: string | null; guest_password: string | null },
  user: SessionUser | null,
  guestPassword: string | undefined,
): void {
  if (hasRole(user, "manager")) return;

  if (post.author_id) {
    if (user && user.id === post.author_id) return;
    throw new BoardError(403, "본인이 작성한 글만 수정·삭제할 수 있습니다.");
  }
  // 비회원 글
  if (!guestPassword) throw new BoardError(401, "비밀번호를 입력해주세요.");
  if (!verifyGuestPassword(guestPassword, post.guest_password)) {
    throw new BoardError(403, "비밀번호가 일치하지 않습니다.");
  }
}

/**
 * 비밀글 열람 권한.
 * 작성자·manager 이상만 볼 수 있다. 비회원 비밀글은 비밀번호로 확인한다.
 */
export function canReadSecret(
  post: { author_id: string | null; guest_password: string | null; is_secret: boolean },
  user: SessionUser | null,
  guestPassword: string | undefined,
): boolean {
  if (!post.is_secret) return true;
  if (hasRole(user, "manager")) return true;
  if (post.author_id && user && user.id === post.author_id) return true;
  if (!post.author_id && guestPassword) return verifyGuestPassword(guestPassword, post.guest_password);
  return false;
}
