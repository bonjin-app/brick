-- 관리자 계정 보호 — 2단계 인증 · 세션 관리
--
-- **관리자 계정이 뚫리면 사이트 전체를 잃는다.** 회원 개인정보, 주문 내역,
-- 결제 정보 접근 권한이 한 계정에 몰려 있고, 유출되면 개인정보보호법상
-- 신고 의무가 생긴다.
--
-- 비밀번호 하나로는 부족하다. 재사용된 비밀번호는 다른 사이트 유출로
-- 뚫리고, 그 사실을 우리는 알 수 없다.

-- ── 2단계 인증 (TOTP) ───────────────────────────────
--
-- RFC 6238. 인증 앱(Google Authenticator, Authy, 1Password 등)이 30초마다
-- 6자리 코드를 만든다.
--
-- 외부 패키지를 쓰지 않고 직접 구현한다 — HMAC-SHA1 뿐이라 node:crypto 로
-- 충분하고, 자체 호스팅 CMS 에서 의존성 하나는 공급망 위험 하나다.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  /**
   * base32 로 인코딩된 공유 비밀.
   *
   * 암호화하지 않는다. 암호화하려면 키가 필요하고 그 키는 같은 서버의
   * 환경변수에 있으므로, DB 를 읽을 수 있는 공격자는 키도 읽는다 —
   * 방어가 되지 않는데 복잡도만 늘고 키 분실 시 전원이 잠긴다.
   *
   * 실질적 방어는 **DB 접근 자체를 막는 것**이다.
   */
  secret varchar(64) NOT NULL,

  /**
   * 활성화 여부.
   *
   * 등록(secret 생성)과 활성화를 분리한다. **코드를 한 번 검증하기 전에는
   * 켜지 않는다** — 잘못된 비밀이 저장되면 본인이 영구히 잠긴다.
   */
  is_enabled boolean NOT NULL DEFAULT false,

  /**
   * 마지막으로 사용한 타임스텝.
   *
   * 같은 코드를 두 번 쓰지 못하게 한다. 30초 안에 코드를 가로챈 공격자가
   * 그것을 재사용하는 것을 막는다(어깨 너머로 보는 경우도 포함).
   */
  last_step bigint,

  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 복구 코드 ───────────────────────────────────────
--
-- 휴대폰을 잃으면 관리자가 자기 사이트에 들어갈 수 없다. 복구 경로가
-- 없으면 2FA 는 **되돌릴 수 없는 함정**이 된다(휴면 계정과 같은 문제).
--
-- 코드는 해시로 저장한다. 한 번 쓰면 소진된다.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /**
   * sha256 해시.
   *
   * 비밀번호가 아니라 **우리가 만든 고엔트로피 난수**(80비트 이상)라
   * 사전 공격이 불가능하다. argon2 를 쓰면 로그인 한 번에 최대 10회
   * 검증이 필요해 수 초가 걸리고, 그 느림이 오히려 서비스 거부 수단이 된다.
   */
  code_hash varchar(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_recovery_codes_user_idx
  ON user_recovery_codes (user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_recovery_codes_hash_idx
  ON user_recovery_codes (user_id, code_hash);

-- ── 2단계 인증 대기 (로그인 중간 단계) ──────────────
--
-- 비밀번호가 맞아도 코드를 확인하기 전에는 **세션을 발급하지 않는다.**
-- 대신 짧게 사는 도전 토큰을 준다. 이것으로는 아무것도 할 수 없고
-- 코드 검증에만 쓴다.
CREATE TABLE IF NOT EXISTS totp_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  /** 시도 횟수 — 6자리는 100만분의 1이므로 무한 시도를 막아야 한다 */
  attempts integer NOT NULL DEFAULT 0,
  /** 5분. 길게 두면 비밀번호만 아는 공격자가 코드를 맞출 시간이 늘어난다 */
  expires_at timestamptz NOT NULL,
  ip_hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS totp_challenges_expires_idx ON totp_challenges (expires_at);

-- ── 세션에 접속 정보 ────────────────────────────────
--
-- "내 계정에 지금 누가 접속해 있나"를 보여주려면 필요하다. 지금은
-- 토큰 해시와 만료 시각뿐이라 목록을 만들 수 없다.
--
-- IP 는 **해시로만** 저장한다 (ADR-35 와 같은 원칙) — 원본을 남기면
-- 접속 위치 이력이 되고, 그것은 우리가 보관할 이유가 없는 개인정보다.
-- 같은 IP 인지 비교하는 데는 해시로 충분하다.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ip_hash varchar(64),
  ADD COLUMN IF NOT EXISTS user_agent varchar(400),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (user_id, last_seen_at DESC);
