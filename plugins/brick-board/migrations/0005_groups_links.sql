-- 게시판 그룹 · 링크 필드 (그누보드 동등성, M25)
--
-- 그룹: 게시판을 묶고(목록 화면에서 소제목), 그룹 단위로 읽기 권한을 건다.
--   실제 읽기 권한 = 그룹과 게시판 중 더 엄격한 쪽 — 그룹을 "회원"으로 두면 안의
--   게시판이 "누구나"여도 회원만 읽는다(그누보드의 그룹 접근 권한).
CREATE TABLE IF NOT EXISTS board_groups (
  id          uuid PRIMARY KEY,
  slug        varchar(100) NOT NULL UNIQUE,
  title       varchar(200) NOT NULL,
  description text,
  read_role   varchar(20)  NOT NULL DEFAULT 'guest',
  sort_order  integer      NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES board_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS board_boards_group_idx ON board_boards (group_id, sort_order);

-- 링크 필드: 글에 관련 주소 최대 2개 (그누보드의 wr_link1/2). http(s) 만 저장한다.
ALTER TABLE board_posts
  ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
