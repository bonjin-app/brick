-- 분류 필수 (그누보드의 "분류 선택 필수"). 분류가 있는 게시판에서 글쓴이가 분류를
-- 고르지 않으면 목록 필터가 무의미해진다 — 게시판이 원하면 강제할 수 있어야 한다.
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS category_required boolean NOT NULL DEFAULT false;
