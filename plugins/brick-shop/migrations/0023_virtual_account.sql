-- 가상계좌 — 발급된 계좌로 입금을 기다리는 결제
--
-- 카드는 결제창에서 끝나지만 가상계좌는 **계좌가 발급될 뿐** 돈은 나중에 들어온다. 그 사이
-- 결제는 waiting 이고, 손님은 주문 조회에서 계좌·기한을 다시 볼 수 있어야 한다(무통장입금과
-- 같은 이유). 입금은 PG 의 통지(웹훅)로 알게 되고, 통지를 믿지 않고 PG 에 다시 물어 확정한다.
ALTER TABLE shop_payments
  ADD COLUMN IF NOT EXISTS va_bank varchar(40),
  ADD COLUMN IF NOT EXISTS va_account varchar(60),
  ADD COLUMN IF NOT EXISTS va_holder varchar(60),
  ADD COLUMN IF NOT EXISTS va_expires_at timestamptz;
-- 입금 대기 결제를 주문으로 찾는다 (자동 취소 · 주문 조회)
CREATE INDEX IF NOT EXISTS shop_payments_waiting_idx ON shop_payments (order_id) WHERE status = 'waiting';
