-- 페이지 검색 인덱스
--
-- 코어 검색은 `pages.title` · `pages.plain_text` 를 ILIKE 로 훑는다. 운영
-- 문서는 이 인덱스를 **운영자가 손으로** 만들라고 안내했는데, 게시판
-- 플러그인은 같은 것을 마이그레이션에서 스스로 만들고 있었다. 한쪽은 자동이고
-- 한쪽은 숙제인 이유가 없다 — 문서를 읽지 않은 사이트만 느려진다.
--
-- 권한이 없으면 건너뛴다 (검색은 인덱스 없이도 동작한다).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS pages_title_trgm ON pages USING gin (title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS pages_plain_text_trgm ON pages USING gin (plain_text gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm 을 만들 수 없어 페이지 검색 가속 인덱스를 건너뜁니다';
END $$;
