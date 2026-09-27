-- 댓글이 달린 글을 작성자가 지우거나 고칠 수 있는 한도 (그누보드 bo_count_delete · bo_count_modify)
--
-- 토론이 달린 글을 작성자가 통째로 지우거나 내용을 바꾸면 남은 사람들의 댓글이 무엇에 대한 것인지 사라진다.
-- 다른 사람의 댓글이 이 수 이상 달리면 작성자는 지우지(고치지) 못한다 — 운영진·그 게시판 관리자는 된다.
-- 0 이면 제한 없음(지금까지와 같다).
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS count_delete integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS count_modify integer NOT NULL DEFAULT 0;
