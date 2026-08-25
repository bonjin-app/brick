-- brick-board 플러그인 소유 테이블.
-- 플러그인 접두사(board_)로 코어 테이블과 충돌을 피한다.
CREATE TABLE IF NOT EXISTS board_boards (
  id          uuid PRIMARY KEY,
  slug        varchar(100) NOT NULL UNIQUE,   -- 그누보드의 bo_table
  title       varchar(200) NOT NULL,
  description text,
  settings    jsonb NOT NULL DEFAULT '{}',    -- 권한/페이지당 글 수/포인트 등
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_posts (
  id          uuid PRIMARY KEY,
  board_id    uuid NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  title       varchar(500) NOT NULL,
  content     text NOT NULL,
  category    varchar(100),
  is_notice   boolean NOT NULL DEFAULT false,
  is_secret   boolean NOT NULL DEFAULT false,
  view_count  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_posts_list_idx ON board_posts (board_id, is_notice DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS board_posts_fts_idx ON board_posts
  USING gin (to_tsvector('simple', title || ' ' || content));

CREATE TABLE IF NOT EXISTS board_comments (
  id         uuid PRIMARY KEY,
  post_id    uuid NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES board_comments(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_comments_post_idx ON board_comments (post_id, created_at);
