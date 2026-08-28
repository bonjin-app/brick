-- 정기결제 — 카드는 PG 에, 해지는 한 클릭에
--
-- 카드 정보는 이 시스템에 존재하지 않는다. PG 가 카드 등록을 받고 우리는
-- **빌링키(토큰)** 만 저장한다 — 유출되어도 카드번호가 아니고, 우리 PG
-- 계정으로만 쓸 수 있다.
--
-- 청구액은 가입 시점에 합의된 금액(agreed_total)으로 고정한다. 상품 가격이나
-- 배송비가 바뀌어 청구액이 달라지면 **결제하지 않고 멈춘 뒤 알린다** —
-- 동의 없이 인상된 금액을 청구하는 것은 법 이전에 신뢰의 문제다.

/** 상품의 정기배송 주기. NULL 이면 일반 상품 (정기결제 불가) */
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS sub_interval varchar(10)
    CHECK (sub_interval IS NULL OR sub_interval IN ('week', 'month'));

CREATE TABLE IF NOT EXISTS shop_billing_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(30) NOT NULL,
  /** PG 가 발급한 토큰. 카드번호가 아니다 — 우리 PG 계정으로만 유효하다 */
  billing_key text NOT NULL,
  /** PG 에 우리가 알려준 고객 식별자 (청구 때 함께 보낸다) */
  customer_key varchar(100) NOT NULL,
  /** "신한 ****1234" — 회원이 어느 카드인지 알아볼 표시용 */
  card_label varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  /**
   * 삭제하지 않고 해지 표시만 한다 — 과거 청구가 어느 키로 됐는지가
   * CS·분쟁의 근거다. 해지된 키를 쓰는 구독은 즉시 멈춘다.
   */
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS shop_billing_keys_user_idx
  ON shop_billing_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /**
   * 상품이 삭제되면 NULL — 구독을 지우지 않는다(청구 이력의 주체다).
   * 스윕이 NULL 을 만나면 "판매 종료"로 멈추고 알린다.
   */
  product_id uuid REFERENCES shop_products(id) ON DELETE SET NULL,
  /** 표시·알림용 스냅샷 — 상품이 삭제돼도 "무엇의 구독"인지 남는다 */
  product_name varchar(200) NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  interval_unit varchar(10) NOT NULL CHECK (interval_unit IN ('week', 'month')),

  /**
   * 합의된 회당 청구액 = 첫 주문의 총액(배송비 포함).
   * 이후 회차의 주문 총액이 이것과 다르면 결제하지 않고 멈춘다.
   */
  agreed_total integer NOT NULL CHECK (agreed_total >= 0),

  billing_key_id uuid NOT NULL REFERENCES shop_billing_keys(id),

  /** active | paused | cancelled */
  status varchar(20) NOT NULL DEFAULT 'active',
  pause_reason text,

  /** 마지막으로 결제된 회차. 첫 결제(가입)가 1 이다 */
  cycle_no integer NOT NULL DEFAULT 1,
  next_charge_at timestamptz,
  /** 연속 실패 횟수 — 3회면 멈추고 알린다. 성공하면 0 으로 */
  fail_count integer NOT NULL DEFAULT 0,

  /** 배송지 스냅샷 — 매 회차 주문에 그대로 쓴다 */
  orderer jsonb NOT NULL,

  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_subscriptions_due_idx
  ON shop_subscriptions (next_charge_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS shop_subscriptions_user_idx
  ON shop_subscriptions (user_id);

/**
 * 회차별 청구 이력. "언제 얼마가 왜 실패했나"가 CS 의 절반이다.
 *
 * 같은 회차의 성공 결제는 한 번뿐 — unique 인덱스가 못박는다.
 * (주문 멱등키 · PG 멱등키와 삼중 방어)
 */
CREATE TABLE IF NOT EXISTS shop_subscription_events (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES shop_subscriptions(id) ON DELETE CASCADE,
  cycle_no integer NOT NULL,
  /** charged | failed | paused | resumed | cancelled */
  kind varchar(20) NOT NULL,
  order_no varchar(30),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_subscription_events_charged_once
  ON shop_subscription_events (subscription_id, cycle_no) WHERE kind = 'charged';
CREATE INDEX IF NOT EXISTS shop_subscription_events_sub_idx
  ON shop_subscription_events (subscription_id, created_at DESC);
