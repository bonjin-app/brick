-- 상품 검색 인덱스
--
-- 손님이 가장 자주 쓰는 검색인데 인덱스가 없었다. 운영 문서는 "pg_trgm 을
-- 만들고 인덱스를 거세요" 라고 **운영자에게 시키면서** 정작 그 목록에 상품은
-- 빠져 있었다 — 게시판 플러그인은 같은 인덱스를 스스로 만들고 있는데도.
--
-- 12만 건에서 재어 보니 순차 스캔 24.5ms → 인덱스 0.14ms 였다. 인덱스 두 개의
-- 크기는 합쳐 2MB 로, 45MB 짜리 테이블에 견주면 싸다.
--
-- 권한이 없는 환경(관리형 PostgreSQL 중 확장 설치를 막는 곳)에서는 건너뛴다 —
-- 검색은 인덱스 없이도 **동작은 한다**. 설치가 거기서 멈추는 쪽이 나쁘다.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS shop_products_name_trgm
    ON shop_products USING gin (name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS shop_products_summary_trgm
    ON shop_products USING gin (summary gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm 을 만들 수 없어 상품 검색 가속 인덱스를 건너뜁니다';
END $$;
