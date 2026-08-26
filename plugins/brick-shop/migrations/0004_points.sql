-- 주문에 포인트 사용액을 기록한다.
--
-- 왜 컬럼인가: 주문 금액 계산식(subtotal - discount - point_used + shipping = total)에
-- 들어가므로 조회마다 다른 테이블을 참조하면 안 된다. 감사 추적은 포인트 원장이 담당한다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS point_used integer NOT NULL DEFAULT 0 CHECK (point_used >= 0),
  ADD COLUMN IF NOT EXISTS point_earned integer NOT NULL DEFAULT 0 CHECK (point_earned >= 0);
