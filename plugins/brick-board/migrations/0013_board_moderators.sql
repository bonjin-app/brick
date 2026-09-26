-- 게시판 관리자 — 운영자가 게시판마다 지정한 회원 (그누보드의 bo_admin · gr_admin)
--
-- 운영진(manager)은 모든 게시판을 관리한다. 동호회·학교·지역 커뮤니티는 흔히 "이 게시판은 이 회원이" 로 나눠
-- 맡기는데, 그러려면 그 회원을 사이트 전체의 운영자로 올려야 했다(다른 게시판·관리 화면까지 닿는다).
-- 여기 지정된 회원은 **그 게시판 안에서만** 운영진처럼 다른 사람의 글·댓글을 고치고 지우며, 비밀글을 보고,
-- 공지를 올리고, 그 게시판의 본인인증 요구를 통과한다. 관리 화면(게시판 설정)에는 닿지 않는다.
CREATE TABLE IF NOT EXISTS board_moderators (
  board_id uuid NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS board_moderators_user_idx ON board_moderators (user_id);
