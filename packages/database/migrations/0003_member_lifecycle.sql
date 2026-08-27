-- 회원 생애주기: 약관 동의 · 이메일 인증 · 탈퇴 · 휴면
--
-- 이 마이그레이션이 다루는 것은 기능이 아니라 **법적 전제**다.
-- 정보통신망법은 이용자의 동의 철회(탈퇴)를 보장해야 한다고 정하고,
-- 개인정보보호법 제21조는 목적 달성 후 지체 없는 파기를 요구한다.
-- 동의를 받았다는 사실을 증명할 책임은 사업자에게 있으므로 이력을 남긴다.

-- ── 약관 ────────────────────────────────────────────
--
-- 본문을 버전으로 관리한다. 개정하면 새 행을 만들고 이전 행은 남긴다 —
-- "그 사람이 동의한 시점의 문서"를 나중에 보여줄 수 있어야 분쟁에서 쓸 수 있다.
CREATE TABLE IF NOT EXISTS agreements (
  id uuid PRIMARY KEY,
  -- terms(이용약관) | privacy(개인정보 수집·이용) | marketing(광고 수신) | third_party(제3자 제공)
  kind varchar(24) NOT NULL,
  version integer NOT NULL,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  /**
   * 필수 동의인가.
   * 필수는 동의하지 않으면 가입이 안 되고, 선택은 거부해도 가입된다.
   * 선택 항목을 필수로 강제하는 것은 위법이다 — 그래서 컬럼으로 구분한다.
   */
  is_required boolean NOT NULL DEFAULT true,
  /** 발효 시점. 미래로 두면 예약 게시가 된다 */
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 같은 종류의 같은 버전은 하나만
CREATE UNIQUE INDEX IF NOT EXISTS agreements_kind_version_idx ON agreements (kind, version);
CREATE INDEX IF NOT EXISTS agreements_kind_effective_idx ON agreements (kind, effective_at DESC);

-- ── 동의 이력 ───────────────────────────────────────
--
-- 회원이 탈퇴해도 이 기록은 남긴다(user_id 는 SET NULL).
-- "동의 없이 개인정보를 처리했다"는 주장에 답하려면 탈퇴 후에도 근거가 필요하다.
-- 다만 남는 것은 동의 사실뿐이고, 개인정보는 users 에서 파기된다.
CREATE TABLE IF NOT EXISTS user_agreements (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  agreement_id uuid NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  kind varchar(24) NOT NULL,
  version integer NOT NULL,
  agreed boolean NOT NULL,
  /** 동의 시점의 IP 해시 — 원문을 남기지 않는다 (ADR-35 와 같은 원칙) */
  ip_hash varchar(64),
  agreed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_agreements_user_idx ON user_agreements (user_id, kind);
CREATE INDEX IF NOT EXISTS user_agreements_agreement_idx ON user_agreements (agreement_id);

-- ── 회원 컬럼 추가 ──────────────────────────────────
ALTER TABLE users
  -- 만 14세 미만은 법정대리인 동의 절차 없이 가입시킬 수 없다.
  -- 생년월일 전체를 받지 않는다 — 나이 확인에 필요한 최소가 "14세 이상인가" 뿐이다.
  ADD COLUMN IF NOT EXISTS age_confirmed boolean NOT NULL DEFAULT true,
  -- 광고 수신 동의 (선택). 단체 메일 발송이 이 값을 존중해야 한다
  ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false,
  -- 마지막 로그인 — 휴면 판정의 기준
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  -- 휴면 전환 시점. NULL 이면 정상 계정
  ADD COLUMN IF NOT EXISTS dormant_at timestamptz,
  -- 탈퇴 시점. NULL 이면 탈퇴하지 않은 계정
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdraw_reason varchar(300);

CREATE INDEX IF NOT EXISTS users_last_login_idx ON users (last_login_at)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS users_withdrawn_idx ON users (withdrawn_at)
  WHERE withdrawn_at IS NOT NULL;

-- ── 이메일 인증 토큰 ────────────────────────────────
--
-- 비밀번호 재설정과 같은 원칙: 원문은 메일 링크에만 있고 DB에는 sha256 해시만.
-- used_at 으로 단회성을 보장한다.
CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** 인증하려는 주소. 이메일 변경 시에도 쓰므로 users.email 과 다를 수 있다 */
  email varchar(255) NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications (user_id);
CREATE INDEX IF NOT EXISTS email_verifications_expires_idx ON email_verifications (expires_at);

-- ── 기본 약관 심기 ──────────────────────────────────
--
-- 빈 약관으로 두면 관리자가 채우기 전까지 가입이 막힌다.
-- 그래서 "고쳐 쓰라"는 안내가 담긴 초안을 넣어둔다 — 법률 자문을 대신하지 않는다는
-- 것을 본문에 명시한다.
INSERT INTO agreements (id, kind, version, title, body, is_required)
SELECT
  gen_random_uuid(), 'terms', 1, '이용약관',
  E'※ 이 문서는 초안입니다. 서비스에 맞게 반드시 고쳐 쓰세요. 법률 자문을 대신하지 않습니다.\n\n'
  '제1조 (목적)\n이 약관은 회사가 제공하는 서비스의 이용조건과 절차, 회사와 회원의 권리·의무를 정합니다.\n\n'
  '제2조 (회원가입)\n회원가입은 이용자가 약관에 동의하고 가입을 신청한 뒤 회사가 승낙함으로써 완료됩니다.\n\n'
  '제3조 (탈퇴 및 이용 제한)\n회원은 언제든지 탈퇴를 요청할 수 있고, 회사는 지체 없이 처리합니다.\n\n'
  '제4조 (게시물의 관리)\n회원이 작성한 게시물에 대한 권리와 책임은 작성자에게 있습니다.',
  true
WHERE NOT EXISTS (SELECT 1 FROM agreements WHERE kind = 'terms');

INSERT INTO agreements (id, kind, version, title, body, is_required)
SELECT
  gen_random_uuid(), 'privacy', 1, '개인정보 수집 및 이용 동의',
  E'※ 이 문서는 초안입니다. 실제로 수집하는 항목에 맞게 반드시 고쳐 쓰세요. 법률 자문을 대신하지 않습니다.\n\n'
  '1. 수집 항목\n필수: 이메일, 비밀번호, 닉네임\n선택: 연락처\n자동 수집: 접속 기록(IP는 해시로만 저장)\n\n'
  '2. 수집 목적\n회원 식별, 서비스 제공, 문의 응대, 부정 이용 방지\n\n'
  '3. 보유 기간\n회원 탈퇴 시 지체 없이 파기합니다. 단, 관계 법령에 따라 보존해야 하는 '
  '거래 기록은 해당 기간(전자상거래법 5년 등) 동안 보관한 뒤 파기합니다.\n\n'
  '4. 동의 거부 권리\n동의를 거부할 수 있으나, 필수 항목에 동의하지 않으면 회원가입이 제한됩니다.',
  true
WHERE NOT EXISTS (SELECT 1 FROM agreements WHERE kind = 'privacy');

INSERT INTO agreements (id, kind, version, title, body, is_required)
SELECT
  gen_random_uuid(), 'marketing', 1, '광고성 정보 수신 동의 (선택)',
  E'신규 소식, 이벤트, 혜택 정보를 이메일로 받습니다.\n\n'
  '동의하지 않아도 회원가입과 서비스 이용에 제한이 없습니다.\n'
  '수신 동의는 내 정보 화면에서 언제든 철회할 수 있습니다.',
  false
WHERE NOT EXISTS (SELECT 1 FROM agreements WHERE kind = 'marketing');
