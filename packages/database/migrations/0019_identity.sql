-- 본인인증 — 성인 확인과 한 사람 한 계정
--
-- identity_verifications: 서버가 발급한 인증 요청. 인증 ID 를 **회원에게 묶어 두는** 곳이다 —
--   브라우저가 정한 ID 를 받으면 남이 끝낸 인증을 내 계정에 붙일 수 있다. 한 번 쓰면 끝이다.
-- user_certifications: 회원의 확인 결과. 이름·생년월일·전화번호를 두지 않는다 — 성인 판정에는
--   출생 연도만, 한 사람 한 계정에는 CI 의 HMAC 만 있으면 된다(원문 CI 는 평생 바뀌지 않는
--   식별자라 새면 되돌릴 수 없다).
CREATE TABLE IF NOT EXISTS identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  -- 공급자에게 넘기는 ID. KCP 가 영문·숫자 40자까지만 받는다
  request_id varchar(40) NOT NULL UNIQUE CHECK (request_id ~ '^[A-Za-z0-9]{1,40}$'),
  status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS identity_verifications_user_idx ON identity_verifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_certifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  -- HMAC(CI 또는 DI) — 같은 사람이면 같다. 원문은 두지 않는다
  person_hash varchar(64) NOT NULL,
  birth_year smallint NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
-- 한 사람 한 계정 검사 (설정이 켜졌을 때만 막는다 — 인덱스는 유일하지 않다)
CREATE INDEX IF NOT EXISTS user_certifications_person_idx ON user_certifications (person_hash);
