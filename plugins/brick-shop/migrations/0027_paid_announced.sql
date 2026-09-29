-- 결제 완료 알림(구매 적립 등)을 끝냈는지 기록한다.
--
-- 알림은 결제완료 전이가 커밋된 뒤 따로 돈다. 그 사이 서버가 멈추거나 구독자가 실패하면 알림이 영영 빠지고,
-- 적립이 없는 결제 주문을 찾을 방법이 없었다. 끝난 시각을 남기면 "결제완료인데 알림이 안 끝난 주문" 을
-- 주기 작업이 다시 알릴 수 있다(구독자는 주문번호로 멱등이다).
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS paid_announced_at timestamptz;

-- 이미 결제된 주문은 알린 것으로 본다 — 지난 주문에 소급해 적립을 붙이지 않는다
UPDATE shop_orders SET paid_announced_at = COALESCE(paid_at, now())
 WHERE paid_at IS NOT NULL AND paid_announced_at IS NULL;

CREATE INDEX IF NOT EXISTS shop_orders_paid_unannounced_idx
  ON shop_orders (paid_at) WHERE paid_at IS NOT NULL AND paid_announced_at IS NULL;
