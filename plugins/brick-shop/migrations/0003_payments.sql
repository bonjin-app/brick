-- 결제 시도 기록.
--
-- 왜 별도 테이블인가:
--  1. 한 주문에 여러 결제 시도가 있을 수 있다 (실패 후 재시도, 부분 환불 등)
--  2. PG 응답 원문을 남겨야 분쟁 시 근거가 된다
--  3. **멱등성** — 같은 PG 거래를 두 번 승인 처리하면 재고와 매출이 이중 계상된다.
--     provider + provider_tid 에 unique를 걸어 DB가 이를 막는다.
CREATE TABLE IF NOT EXISTS shop_payments (
  id             uuid PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  -- 결제 대행사 식별자. 예: "toss", "inicis", "bank_transfer"
  provider       varchar(40) NOT NULL,
  -- PG가 발급한 거래 고유번호 (paymentKey, tid 등)
  provider_tid   varchar(200),
  -- requested | paid | failed | cancelled | partial_refunded | refunded
  status         varchar(20) NOT NULL DEFAULT 'requested',
  -- 결제 요청 금액(원). 주문 총액과 반드시 일치해야 승인한다
  amount         integer NOT NULL CHECK (amount >= 0),
  -- 환불 누적액
  refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  method         varchar(40),
  -- PG 응답 원문 (분쟁 대응 근거). 카드번호 등 민감정보는 저장하지 않는다
  raw            jsonb,
  failure_reason varchar(500),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_payments_refund_chk CHECK (refunded_amount <= amount)
);
CREATE INDEX IF NOT EXISTS shop_payments_order_idx ON shop_payments (order_id, created_at DESC);
-- 같은 PG 거래를 두 번 처리하지 못하게 한다 (멱등성의 최후 방어선)
CREATE UNIQUE INDEX IF NOT EXISTS shop_payments_tid_uniq
  ON shop_payments (provider, provider_tid) WHERE provider_tid IS NOT NULL;

-- 주문에 결제 idempotency key 추가: 클라이언트 재시도로 중복 주문이 생기는 것을 막는다
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS idempotency_key varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_idem_uniq
  ON shop_orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
