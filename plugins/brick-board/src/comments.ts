import { sql } from "drizzle-orm";
import { pgArray, type Db } from "./types.js";

/**
 * 댓글 지우기 — 모든 삭제 경로(작성자·운영진·탈퇴)가 이것 하나를 쓴다.
 *
 * 답글이 달린 댓글은 **자리만 남긴다**(내용·작성자·비회원 비밀번호를 지우고 `deleted_at`) — 남이 단 답글은
 * 그 사람의 것이다. 전에는 parent_id 의 CASCADE 가 답글까지 지웠고, 댓글 수는 하나만 줄었다.
 * 답글이 없는 자리는 실제로 지우고, 그러면 위의 빈 자리가 다시 답글 없는 자리가 될 수 있어 없어질 때까지
 * 되풀이한다(대댓글은 3단에서 멈추지만 그 아래로도 계속 달리므로 사슬 길이에 한계가 없다).
 * 댓글 수는 증감하지 않고 **다시 센다** — 어긋날 틈을 두지 않는다.
 */
export async function removeComments(
  db: Pick<Db, "execute">,
  ids: readonly string[],
): Promise<Array<{ id: string; authorId: string | null }>> {
  if (!ids.length) return [];
  const idArr = pgArray(ids);
  // 지우기 전 작성자를 함께 돌려준다 — 부르는 쪽이 "댓글이 지워졌다" 훅(포인트 회수)을 낸다
  const { rows: gone } = await db.execute(sql`
    UPDATE board_comments c SET deleted_at = now(), content = '', is_secret = false,
      author_id = NULL, author_name = '', guest_name = NULL, guest_password = NULL
    FROM (SELECT id, author_id FROM board_comments WHERE id = ANY(${idArr}::uuid[]) AND deleted_at IS NULL) old
    WHERE c.id = old.id
    RETURNING c.post_id, old.id, old.author_id
  `);
  if (!gone.length) return [];
  const postArr = pgArray([...new Set(gone.map((r) => String(r.post_id)))]);
  for (;;) {
    const { rows } = await db.execute(sql`
      DELETE FROM board_comments c
      WHERE c.post_id = ANY(${postArr}::uuid[]) AND c.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM board_comments k WHERE k.parent_id = c.id)
      RETURNING c.id
    `);
    if (!rows.length) break;
  }
  await recountComments(db, [...new Set(gone.map((r) => String(r.post_id)))]);
  return gone.map((r) => ({ id: String(r.id), authorId: r.author_id ? String(r.author_id) : null }));
}

/**
 * 글의 댓글 수를 다시 센다 — 지운 자리(deleted_at)는 세지 않는다. 지우는 쪽은 증감하지 않고 **다시 센다**(어긋날 틈을
 * 두지 않는다). 등록은 `comment_count + 1` 로 올린다: 댓글이 수천 개인 글에서 등록마다 세면 O(n) 이고, 올리기는
 * 동시 등록에도 정확하다.
 */
export async function recountComments(db: Pick<Db, "execute">, postIds: readonly string[]): Promise<void> {
  if (!postIds.length) return;
  await db.execute(sql`
    UPDATE board_posts p SET comment_count =
      (SELECT count(*) FROM board_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL)
    WHERE p.id = ANY(${pgArray(postIds)}::uuid[])
  `);
}

/** 훅을 부를 수 있는 것 (ctx.hooks) */
export interface BoardHooks {
  doAction<T>(hook: string, payload: T): Promise<void>;
}

/**
 * 지워진 댓글을 알린다 — 포인트가 그 적립을 거둬들인다(그누보드 delete_point 와 같다). 전에는 알리지 않아 글을 쓰고
 * (+적립) 지우기를 되풀이하면 포인트가 끝없이 쌓였다. 비회원 것은 적립이 없으므로 알리지 않는다.
 * 순서대로 부른다 — 같은 회원의 회수가 동시에 돌면 원장 잠금이 서로 얽힌다.
 */
export async function announceCommentsDeleted(
  hooks: BoardHooks,
  list: ReadonlyArray<{ id: string; authorId: string | null }>,
): Promise<void> {
  for (const c of list) {
    if (c.authorId) await hooks.doAction("board.comment.deleted", { commentId: c.id, authorId: c.authorId });
  }
}
