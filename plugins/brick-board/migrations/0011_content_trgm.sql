-- 게시글 본문 검색 인덱스
--
-- 제목에는 trgm 인덱스가 있었는데(0002) **본문에는 없었다.** 그런데 기본
-- 검색은 제목·본문·글쓴이를 함께 훑는다 — OR 로 묶인 조각 중 하나라도
-- 인덱스를 못 쓰면 전체가 순차 스캔이 된다. 제목만 걸어 둔 인덱스는 기본
-- 검색에서 한 번도 쓰이지 않았다.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS board_posts_content_trgm
    ON board_posts USING gin (content gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS board_posts_author_name_trgm
    ON board_posts USING gin (author_name gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm 을 만들 수 없어 게시글 본문 검색 가속 인덱스를 건너뜁니다';
END $$;
