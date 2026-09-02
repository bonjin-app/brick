-- 회원별 관리자 메모 (M26)
--
-- admin_memo: 운영자만 보는 메모 — 문의 이력, 제재 사유, 특별 고객 표시 등.
--   회원 본인에게는 어떤 API 로도 나가지 않는다 (me/profile 은 이 열을 고르지 않는다).
--   그누보드 mb_memo 에 해당. 탈퇴 익명화 때 함께 지운다.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_memo text;
