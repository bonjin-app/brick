-- 비밀번호 재설정 + 감사 로그
--
-- 재설정 토큰은 세션과 같은 원칙으로 다룬다: 원문은 메일 링크에만,
-- DB에는 sha256 해시만. used_at으로 단회성을 보장한다.

CREATE TABLE IF NOT EXISTS password_resets (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip varchar(64),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
-- 만료 토큰 정리용
CREATE INDEX IF NOT EXISTS password_resets_expires_idx ON password_resets (expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid PRIMARY KEY,
  actor_id    uuid,
  actor_email varchar(255),
  action      varchar(80) NOT NULL,
  target_type varchar(40),
  target_id   varchar(100),
  summary     varchar(500),
  ip          varchar(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_type, target_id);

-- 상품/페이지 한국어 검색 가속 (ADR의 "알려진 제약" 대응).
-- pg_trgm 은 ILIKE '%검색어%' 를 GIN 인덱스로 가속한다 — 코드 변경 없이 효과가 있다.
-- 확장을 만들 권한이 없는 환경(관리형 DB 일부)에서도 실패하지 않도록 예외를 삼킨다.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS pages_text_trgm_idx  ON pages USING gin (plain_text gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm 확장을 만들 수 없어 검색 가속 인덱스를 건너뜁니다 (검색은 정상 동작합니다)';
END $$;
