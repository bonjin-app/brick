-- 읽기 전용 API 토큰 — 사람이 아닌 도구(MCP 서버·모니터링·에이전트)가 쓴다
--
-- 도구에게 로그인 세션을 주면 그 세션은 쓰기 권한까지 가진 전체 관리자 권한이다. 도구의 설정 파일이 새거나
-- 도구가 잘못 움직이면 사이트를 지울 수 있다. 이 토큰은 (1) 읽기(GET)만 되고 (2) 진단용으로 허용한 경로만 열리며
-- (3) 언제든 폐기되고 (4) 만료가 있다. 원문은 만들 때 한 번만 보여 주고 DB 에는 sha256 해시만 둔다.
CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL,
  token_hash text NOT NULL UNIQUE,
  -- 원문의 끝 네 글자 — 목록에서 "어느 토큰인지" 알아보는 용도
  hint varchar(8) NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_tokens_created_by_idx ON api_tokens (created_by);
