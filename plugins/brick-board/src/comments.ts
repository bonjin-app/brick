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
export async function removeComments(db: Pick<Db, "execute">, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const idArr = pgArray(ids);
  const { rows: gone } = await db.execute(sql`
    UPDATE board_comments SET deleted_at = now(), content = '', is_secret = false,
      author_id = NULL, author_name = '', guest_name = NULL, guest_password = NULL
    WHERE id = ANY(${idArr}::uuid[]) AND deleted_at IS NULL
    RETURNING post_id
  `);
  if (!gone.length) return 0;
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
  await db.execute(sql`
    UPDATE board_posts p SET comment_count =
      (SELECT count(*) FROM board_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL)
    WHERE p.id = ANY(${postArr}::uuid[])
  `);
  return gone.length;
}
