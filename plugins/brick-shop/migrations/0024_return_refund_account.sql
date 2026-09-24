-- 반품·취소 신청의 환불 계좌 — 가상계좌로 결제한 주문만
--
-- 가상계좌로 받은 돈은 손님 계좌로 보내야 돌려줄 수 있다(카드처럼 승인을 취소하는 것이 아니다).
-- 그 계좌를 손님이 신청서에 적는다. 환불이 끝나면 지운다 — 금융 정보를 필요 이상 두지 않는다.
ALTER TABLE shop_returns
  ADD COLUMN IF NOT EXISTS refund_bank varchar(20),
  ADD COLUMN IF NOT EXISTS refund_account varchar(30),
  ADD COLUMN IF NOT EXISTS refund_holder varchar(30);
