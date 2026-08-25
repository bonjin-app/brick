-- brick-board 강화: 그누보드 게시판 수준으로.
--
-- 추가하는 것: 첨부파일 · 권한 레벨 · 분류 · 답변형(계층) · 추천/비추천 ·
--              비회원 글쓰기 · 도배 방지 · 수정 이력

-- ── 게시판 설정을 컬럼으로 ─────────────────────────────
-- settings jsonb에 다 넣으면 인덱스도 제약도 걸 수 없다.
-- 권한처럼 매 요청에서 검사하는 값은 컬럼이어야 한다.
ALTER TABLE board_boards
  -- 권한: guest < member < manager < admin
  ADD COLUMN IF NOT EXISTS read_role      varchar(20) NOT NULL DEFAULT 'guest',
  ADD COLUMN IF NOT EXISTS write_role     varchar(20) NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS comment_role   varchar(20) NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS download_role  varchar(20) NOT NULL DEFAULT 'member',
  -- 게시판별 분류 목록 (예: ["공지","질문","자유"])
  ADD COLUMN IF NOT EXISTS categories     jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS page_size      integer NOT NULL DEFAULT 20,
  -- 기능 토글
  ADD COLUMN IF NOT EXISTS allow_reply    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_secret   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_vote     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_upload   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_files      integer NOT NULL DEFAULT 3,
  -- 도배 방지: 같은 사용자가 다음 글을 쓸 수 있게 되기까지의 초
  ADD COLUMN IF NOT EXISTS write_interval integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sort_order     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_visible     boolean NOT NULL DEFAULT true;

ALTER TABLE board_boards
  ADD CONSTRAINT board_boards_page_size_chk CHECK (page_size BETWEEN 5 AND 100) NOT VALID;
ALTER TABLE board_boards
  ADD CONSTRAINT board_boards_max_files_chk CHECK (max_files BETWEEN 0 AND 10) NOT VALID;

-- ── 게시글: 답변형 · 비회원 · 추천 ──────────────────────
ALTER TABLE board_posts
  -- 답변형(계층) 구조.
  -- 그누보드는 wr_num/wr_reply 문자열로 정렬한다. 여기서는 materialized path를 쓴다:
  --   원글      thread_id = 자기 id,  depth = 0, thread_path = ''
  --   1단 답변  thread_id = 원글 id,  depth = 1, thread_path = '0001'
  --   2단 답변  thread_id = 원글 id,  depth = 2, thread_path = '0001.0001'
  -- 정렬: ORDER BY thread_created_at DESC, thread_path ASC → 스레드 단위로 묶인다
  ADD COLUMN IF NOT EXISTS thread_id          uuid,
  ADD COLUMN IF NOT EXISTS thread_created_at  timestamptz,
  ADD COLUMN IF NOT EXISTS thread_path        varchar(200) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS depth              integer NOT NULL DEFAULT 0,
  -- 비회원 글쓰기 (게시판 write_role이 guest일 때)
  ADD COLUMN IF NOT EXISTS guest_name         varchar(50),
  ADD COLUMN IF NOT EXISTS guest_password     text,
  ADD COLUMN IF NOT EXISTS author_ip          varchar(64),
  ADD COLUMN IF NOT EXISTS up_count           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS down_count         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS file_count         integer NOT NULL DEFAULT 0,
  -- 작성자 표시명 스냅샷 (회원이 탈퇴해도 목록이 깨지지 않는다)
  ADD COLUMN IF NOT EXISTS author_name        varchar(100);

-- 기존 글을 원글로 초기화
UPDATE board_posts
   SET thread_id = id, thread_created_at = created_at
 WHERE thread_id IS NULL;

CREATE INDEX IF NOT EXISTS board_posts_thread_idx
  ON board_posts (board_id, is_notice DESC, thread_created_at DESC, thread_path);
CREATE INDEX IF NOT EXISTS board_posts_author_idx ON board_posts (author_id, created_at DESC);

-- 한국어 검색은 pg_trgm이 실질적으로 유효하다 (ADR의 알려진 제약)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS board_posts_title_trgm ON board_posts USING gin (title gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm을 만들 수 없어 검색 가속 인덱스를 건너뜁니다';
END $$;

-- ── 댓글: 비회원 · 비밀댓글 ────────────────────────────
ALTER TABLE board_comments
  ADD COLUMN IF NOT EXISTS guest_name     varchar(50),
  ADD COLUMN IF NOT EXISTS guest_password text,
  ADD COLUMN IF NOT EXISTS author_name    varchar(100),
  ADD COLUMN IF NOT EXISTS author_ip      varchar(64),
  ADD COLUMN IF NOT EXISTS is_secret      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS depth          integer NOT NULL DEFAULT 0;

-- ── 첨부파일 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_attachments (
  id             uuid PRIMARY KEY,
  post_id        uuid NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  -- StorageProvider의 키. 실제 경로는 스토리지 구현이 정한다
  storage_key    text NOT NULL,
  file_name      varchar(500) NOT NULL,
  content_type   varchar(200) NOT NULL,
  size           bigint NOT NULL CHECK (size >= 0),
  download_count integer NOT NULL DEFAULT 0,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_attachments_post_idx ON board_attachments (post_id, sort_order);

-- ── 추천/비추천 (1인 1표) ──────────────────────────────
CREATE TABLE IF NOT EXISTS board_votes (
  post_id    uuid NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value      smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- 기존 댓글 수를 집계 컬럼에 반영 (목록에서 매번 count하지 않기 위함)
UPDATE board_posts p
   SET comment_count = (SELECT count(*) FROM board_comments c WHERE c.post_id = p.id)
 WHERE comment_count = 0;
