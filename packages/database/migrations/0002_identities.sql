-- 소셜 로그인 (외부 신원 연결)
--
-- 회원 하나에 여러 신원을 붙일 수 있다. 구글로 가입한 사람이 나중에 카카오도
-- 연결해 두면 어느 쪽으로 들어와도 같은 계정이 된다.
--
-- password_hash 를 NULL 허용으로 바꾸지 않는다 — 소셜 전용 계정에도 쓸 수 없는
-- 무작위 해시를 넣는다. NULL을 허용하면 "비밀번호가 없는 계정"이라는 상태가
-- 인증 코드 전체에 퍼지고, 한 곳만 검사를 빠뜨려도 비밀번호 없이 로그인된다.

CREATE TABLE IF NOT EXISTS user_identities (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- google | kakao | naver | github
  provider      varchar(30) NOT NULL,
  -- 공급자가 발급한 고유 id. 이메일이 아니다 —
  -- 이메일은 바뀔 수 있고, 바뀌면 다른 사람의 계정에 붙을 수 있다.
  provider_uid  varchar(255) NOT NULL,
  -- 연결 시점의 이메일·이름 (감사·표시용 스냅샷)
  email         varchar(255),
  display_name  varchar(200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- 한 공급자의 한 계정은 한 회원에게만 붙는다
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_provider_uid_idx
  ON user_identities (provider, provider_uid);
-- 한 회원이 같은 공급자를 두 번 연결할 수는 없다
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_user_provider_idx
  ON user_identities (user_id, provider);

-- 소셜 전용 계정 표시.
-- 이 계정은 비밀번호 로그인을 시도할 수 없고, 비밀번호 재설정 메일도 받지 않는다
-- (재설정으로 비밀번호를 만들어 소셜 연결을 우회하는 경로를 막는다).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_login_enabled boolean NOT NULL DEFAULT true;
