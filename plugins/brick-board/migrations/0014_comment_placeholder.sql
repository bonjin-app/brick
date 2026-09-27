-- 지운 댓글의 자리 — 답글이 달린 댓글을 지우면 내용과 작성자만 지우고 자리를 남긴다
--
-- 전에는 parent_id 의 ON DELETE CASCADE 가 답글을 함께 지웠다: 내 댓글을 지우면 **남이 단 답글까지**
-- 사라졌고(운영진의 경고 답글도 지울 수 있었다), 글의 댓글 수는 하나만 줄어 실제보다 많게 남았다.
-- 탈퇴하며 글을 지우는 경로는 댓글 수를 아예 줄이지 않았다.
ALTER TABLE board_comments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 그렇게 어긋난 댓글 수를 한 번 바로잡는다
UPDATE board_posts p SET comment_count = c.n
FROM (
  SELECT p2.id, (SELECT count(*) FROM board_comments k WHERE k.post_id = p2.id AND k.deleted_at IS NULL) AS n
  FROM board_posts p2
) c
WHERE c.id = p.id AND p.comment_count <> c.n;
