-- 생일 쿠폰 — 발급형 쿠폰의 자동 지급 조건
--
-- 생일 쿠폰 = 발급형 쿠폰 + birthday_auto. 스윕이 오늘이 생일인 회원의
-- 쿠폰함에 지급한다. 같은 쿠폰은 평생 1회다(shop_user_coupons unique) —
-- 매년 주고 싶으면 해마다 쿠폰을 새로 만든다. ADR-69 의 재지급 규칙과
-- 같은 이유다: 지급 이력이 섞이면 "언제 받았나"에 답할 수 없다.
ALTER TABLE shop_coupons
  ADD COLUMN IF NOT EXISTS birthday_auto boolean NOT NULL DEFAULT false;
