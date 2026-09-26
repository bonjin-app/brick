-- 첫 결제를 확인하지 못한 가입 — 스윕이 매번 찾는다(settleFirstCharges). 대부분의 시간에 0건이므로
-- 부분 인덱스로 두면 구독이 많아도 한 번의 인덱스 조회로 끝난다.
CREATE INDEX IF NOT EXISTS shop_subscriptions_first_charge_idx
  ON shop_subscriptions (created_at) WHERE status = 'active' AND next_charge_at IS NULL;
