-- 스크랩 (그누보드의 스크랩).
-- 회원이 글을 북마크해 두고 나중에 찾아본다.
CREATE TABLE IF NOT EXISTS board_scraps (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
-- 내 스크랩 목록은 최신순으로 본다
CREATE INDEX IF NOT EXISTS board_scraps_user_idx ON board_scraps (user_id, created_at DESC);

-- 글마다 스크랩 수를 표시하려면 집계가 필요하다.
-- 매번 count하지 않도록 컬럼으로 둔다 (추천 수와 같은 방식).
ALTER TABLE board_posts
  ADD COLUMN IF NOT EXISTS scrap_count integer NOT NULL DEFAULT 0 CHECK (scrap_count >= 0);
