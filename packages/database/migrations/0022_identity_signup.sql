-- 가입 전 본인인증 — 계정이 생기기 전에 사람을 확인한다
--
-- 본인인증은 로그인한 회원에게만 열려 있었다(인증 요청을 회원에게 묶어 두는 방식이다). 그래서
-- "가입할 때 본인인증" 을 요구할 길이 없었고, 한 사람 한 계정 사이트도 일단 계정을 만든 뒤에야
-- 두 번째 계정을 거절할 수 있었다.
--
-- 가입 전 인증은 회원 대신 **브라우저**에 묶는다: 서버가 만든 비밀값을 httpOnly 쿠키로 주고,
-- 그 HMAC(guest_hash)을 요청에 적는다. 인증이 끝나면 결과(사람 해시·출생 연도·만 14세 이상인지)를
-- 가입이 가져갈 때까지 여기 잠깐 두고, 가입이 가져가면(consumed_at) 결과 칸을 지운다 — 결과는
-- 회원의 user_certifications 로 옮겨 간다.
ALTER TABLE identity_verifications ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS guest_hash varchar(64);
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS person_hash varchar(64);
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS birth_year smallint;
-- 만 14세 이상인가 — 생년월일은 두지 않고 판정만 남긴다(개인정보보호법 제22조의2)
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS over14 boolean;
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE identity_verifications
    ADD CONSTRAINT identity_verifications_owner CHECK (user_id IS NOT NULL OR guest_hash IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS identity_verifications_guest_idx
  ON identity_verifications (guest_hash, completed_at DESC) WHERE guest_hash IS NOT NULL;
