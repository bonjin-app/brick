-- 주문 취소 · 반품 · 교환
--
-- 이건 편의 기능이 아니라 **법적 요건**이다.
-- 전자상거래법 제17조는 소비자가 상품을 받은 날부터 7일 안에 청약철회를 할 수
-- 있다고 정한다. 사업자는 이를 거부할 수 없고, 절차를 제공해야 한다.
-- 반품이 안 되는 쇼핑몰은 실제로 운영할 수 없다.
--
-- 왜 주문 상태만으로 안 되는가:
--   지금은 주문 전체를 cancelled/refunded 로 바꾸는 것뿐이다. 실제 반품은
--   **상품 단위**로 일어난다 — 세 개 중 하나만 반품하고, 색상만 교환한다.
--   주문 상태를 통째로 바꾸면 나머지 두 개의 배송 정보가 사라진다.

-- ── 주문 항목별 취소·반품 수량 ──────────────────────
--
-- 항목에 누적 수량을 둔다. 반품 요청 테이블을 매번 합산하는 것보다
-- "지금 몇 개가 살아 있는가"를 한 번에 읽을 수 있다.
ALTER TABLE shop_order_items
  -- 취소·반품으로 빠진 수량 (누적)
  ADD COLUMN IF NOT EXISTS cancelled_qty integer NOT NULL DEFAULT 0
    CHECK (cancelled_qty >= 0),
  -- 환불된 금액 (누적). 부분 환불에서 배송비 정산이 섞이므로 항목별로 따로 센다
  ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0
    CHECK (refunded_amount >= 0);

-- 취소 수량이 주문 수량을 넘을 수 없다
ALTER TABLE shop_order_items
  DROP CONSTRAINT IF EXISTS shop_order_items_cancel_chk;
ALTER TABLE shop_order_items
  ADD CONSTRAINT shop_order_items_cancel_chk CHECK (cancelled_qty <= quantity);

-- ── 반품 · 교환 요청 ────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_returns (
  id uuid PRIMARY KEY,
  /** 요청 번호 — 고객이 전화로 말할 수 있는 짧은 식별자 */
  return_no varchar(30) NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  /** 회원 주문이면 회원, 비회원 주문이면 NULL */
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  /** cancel(취소) | return(반품·환불) | exchange(교환) */
  kind varchar(16) NOT NULL,
  /**
   * requested(접수) | approved(승인) | rejected(거부) |
   * collecting(수거중) | received(입고) | completed(완료) | cancelled(요청취소)
   */
  status varchar(16) NOT NULL DEFAULT 'requested',

  /**
   * 사유 구분. 이게 **누가 배송비를 내는지**를 결정한다.
   *   change_of_mind(단순변심) → 고객 부담 (전자상거래법 제18조 제9항)
   *   defect(불량) · wrong_item(오배송) · damaged(파손) → 사업자 부담
   * 자유 입력이 아니라 목록인 이유: 배송비 계산이 여기에 걸려 있어
   * 문자열을 자유롭게 받으면 정산이 불가능해진다.
   */
  reason_code varchar(24) NOT NULL,
  reason text,

  /** 고객이 올린 사진 (불량·파손 증빙) */
  images jsonb NOT NULL DEFAULT '[]',

  /** 반품 배송비. 고객 부담이면 환불액에서 차감한다 */
  return_shipping_fee integer NOT NULL DEFAULT 0 CHECK (return_shipping_fee >= 0),
  /** 누가 내는가: customer | seller */
  shipping_payer varchar(16) NOT NULL DEFAULT 'customer',

  /** 환불 예정·완료 금액 */
  refund_amount integer NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  refunded_at timestamptz,

  /** 교환일 때 보낼 새 상품의 운송장 */
  exchange_tracking_no varchar(100),
  /** 수거 운송장 */
  pickup_tracking_no varchar(100),

  admin_note text,
  /** 거부 사유 — 거부는 반드시 이유를 남겨야 한다 */
  reject_reason text,

  handled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_returns_order_idx ON shop_returns (order_id);
CREATE INDEX IF NOT EXISTS shop_returns_user_idx ON shop_returns (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_returns_status_idx ON shop_returns (status, created_at DESC);

-- 요청 번호 시퀀스 (주문번호와 같은 이유 — count(*)+1 은 동시 요청에서 중복이 난다)
CREATE SEQUENCE IF NOT EXISTS shop_return_no_seq START 1;

-- ── 반품 대상 항목 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_return_items (
  id uuid PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES shop_returns(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES shop_order_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  /** 이 항목에서 환불되는 금액 (단가 × 수량, 할인 안분 적용) */
  refund_amount integer NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  /** 교환일 때 바꿀 옵션 (같은 상품의 다른 옵션) */
  exchange_option_id uuid REFERENCES shop_product_options(id) ON DELETE SET NULL,
  exchange_option_name varchar(200)
);

CREATE INDEX IF NOT EXISTS shop_return_items_return_idx ON shop_return_items (return_id);
-- 같은 요청에 같은 항목을 두 번 넣을 수 없다
CREATE UNIQUE INDEX IF NOT EXISTS shop_return_items_once_idx
  ON shop_return_items (return_id, order_item_id);

-- ── 주문에 배송 완료 시점 추가 ──────────────────────
--
-- 청약철회 기간(7일)의 기산점이다. 없으면 "언제까지 반품할 수 있는가"를
-- 계산할 수 없다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  -- 부분 취소·반품이 있는 주문임을 표시. 목록에서 눈에 보여야 한다
  ADD COLUMN IF NOT EXISTS has_returns boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS shop_orders_delivered_idx ON shop_orders (delivered_at)
  WHERE delivered_at IS NOT NULL;
