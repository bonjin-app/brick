-- 회원 생일 (선택 · 최소수집)
--
-- 연도를 받지 않는다. 생일 혜택에 필요한 것은 "몇 월 며칠"뿐이고,
-- 연도까지 받으면 나이라는 별개의 개인정보를 함께 수집하는 것이 된다 —
-- 목적에 필요한 최소만 받는다(개인정보보호법 제16조).
--
-- 가입할 때 받지 않는다. 회원이 혜택을 원할 때 마이페이지에서 스스로
-- 입력하고, 언제든 지울 수 있다. 탈퇴하면 함께 파기된다.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birth_month smallint
    CHECK (birth_month IS NULL OR (birth_month BETWEEN 1 AND 12)),
  ADD COLUMN IF NOT EXISTS birth_day smallint
    CHECK (birth_day IS NULL OR (birth_day BETWEEN 1 AND 31));
