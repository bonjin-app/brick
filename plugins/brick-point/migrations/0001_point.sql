-- brick-point 스키마.
--
-- 설계: **원장(ledger) + 잔여량 추적**
--
-- 왜 단순 잔액 컬럼이 아닌가:
--  1. 감사 추적이 필요하다 — 포인트는 돈에 준하므로 "왜 늘었나/줄었나"가 남아야 한다
--  2. 만료를 정확히 처리해야 한다 — 적립마다 유효기간이 다를 수 있다
--  3. 오래된 것부터 소비(FIFO)해야 사용자에게 유리하고 만료 손실이 적다
--
-- 그래서 적립 행에 remaining(남은 양)을 두고 오래된 것부터 깎는다.
-- 잔액 = 만료되지 않은 적립 행의 remaining 합. 별도 잔액 컬럼을 두지 않아
-- 원장과 잔액이 어긋날 여지가 없다.
CREATE TABLE IF NOT EXISTS point_ledger (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 감사용 증감. 적립은 양수, 사용/만료/차감은 음수
  amount      integer NOT NULL,
  -- 적립 행에서만 의미가 있다: 아직 쓰지 않은 양. 사용/만료 행은 0
  remaining   integer NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  -- earn(적립) | spend(사용) | expire(만료) | adjust(관리자 조정) | refund(사용 취소)
  kind        varchar(16) NOT NULL,
  reason      varchar(200) NOT NULL,
  -- 무엇 때문인지. 예: ("board.post", "<글id>"), ("shop.order", "<주문번호>")
  ref_type    varchar(40),
  ref_id      varchar(100),
  expires_at  timestamptz,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT point_ledger_remaining_chk CHECK (remaining <= greatest(amount, 0))
);

-- 잔액 계산과 FIFO 소비에 쓰는 인덱스
CREATE INDEX IF NOT EXISTS point_ledger_balance_idx
  ON point_ledger (user_id, expires_at) WHERE amount > 0 AND remaining > 0;
CREATE INDEX IF NOT EXISTS point_ledger_history_idx ON point_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS point_ledger_ref_idx ON point_ledger (ref_type, ref_id);

-- 같은 원인으로 두 번 적립/사용하지 않게 한다 (훅 재실행·웹훅 재전송 대비).
-- 예: 같은 글에 대한 글쓰기 적립은 한 번만.
CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_once_idx
  ON point_ledger (user_id, kind, ref_type, ref_id)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
