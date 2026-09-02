-- 회원 프로필 (M25): 프로필 이미지 · 닉네임 변경 주기
--
-- avatar_url: 스토리지 공개 URL. 글·댓글·헤더에 함께 보인다. NULL 이면 이니셜 원.
-- display_name_changed_at: 마지막으로 이름을 바꾼 시각. 사이트 설정(member.nick_change_days)
--   만큼 지나지 않으면 다시 바꿀 수 없다 — 그누보드의 닉네임 변경 제한. 가입 시 NULL 이라
--   첫 변경은 언제나 허용된다.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS display_name_changed_at timestamptz;
