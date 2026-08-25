-- brick-shop 스키마.
--
-- 설계 원칙:
--  1. 금액은 모두 integer (원 단위). 부동소수점을 쓰지 않는다 — 돈 계산에서 오차는 버그다.
--  2. 주문 항목은 주문 시점의 상품명/가격을 복사(스냅샷)한다.
--     상품 가격이 나중에 바뀌어도 과거 주문 내역이 변해서는 안 된다.
--  3. 재고는 원자적 UPDATE로만 차감한다 (아래 주문 로직 참고) — 초과판매 방지.

-- ── 카테고리 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_categories (
  id          uuid PRIMARY KEY,
  slug        varchar(100) NOT NULL UNIQUE,
  name        varchar(200) NOT NULL,
  parent_id   uuid REFERENCES shop_categories(id) ON DELETE SET NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_visible  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 상품 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_products (
  id             uuid PRIMARY KEY,
  slug           varchar(150) NOT NULL UNIQUE,
  name           varchar(300) NOT NULL,
  category_id    uuid REFERENCES shop_categories(id) ON DELETE SET NULL,
  summary        varchar(500),
  description    text NOT NULL DEFAULT '',
  image_url      text,
  -- 판매가 / 정가(할인 표시용). 원 단위 integer
  price          integer NOT NULL CHECK (price >= 0),
  list_price     integer CHECK (list_price IS NULL OR list_price >= 0),
  -- 재고. NULL이면 무한(디지털 상품 등)
  stock          integer CHECK (stock IS NULL OR stock >= 0),
  -- draft | selling | soldout | hidden
  status         varchar(20) NOT NULL DEFAULT 'draft',
  -- 배송비 정책: 개별 상품이 무료배송인 경우
  free_shipping  boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  view_count     integer NOT NULL DEFAULT 0,
  sold_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_products_list_idx ON shop_products (status, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_products_category_idx ON shop_products (category_id, status);
CREATE INDEX IF NOT EXISTS shop_products_search_idx ON shop_products
  USING gin (to_tsvector('simple', name || ' ' || coalesce(summary, '')));

-- ── 상품 옵션 (예: 색상/사이즈). 옵션별 재고와 추가금 ──
CREATE TABLE IF NOT EXISTS shop_product_options (
  id          uuid PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  name        varchar(200) NOT NULL,
  extra_price integer NOT NULL DEFAULT 0,
  stock       integer CHECK (stock IS NULL OR stock >= 0),
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS shop_options_product_idx ON shop_product_options (product_id, sort_order);

-- ── 장바구니 ──────────────────────────────────────────
-- 회원은 user_id로, 비회원은 세션 토큰(guest_token)으로 식별한다.
CREATE TABLE IF NOT EXISTS shop_carts (
  id          uuid PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_token varchar(64),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_carts_owner_chk CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_carts_user_idx ON shop_carts (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_carts_guest_idx ON shop_carts (guest_token) WHERE guest_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS shop_cart_items (
  id         uuid PRIMARY KEY,
  cart_id    uuid NOT NULL REFERENCES shop_carts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  option_id  uuid REFERENCES shop_product_options(id) ON DELETE SET NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 같은 상품+옵션은 한 줄로 합친다 (수량만 증가)
CREATE UNIQUE INDEX IF NOT EXISTS shop_cart_items_uniq
  ON shop_cart_items (cart_id, product_id, coalesce(option_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── 쿠폰 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_coupons (
  id             uuid PRIMARY KEY,
  code           varchar(50) NOT NULL UNIQUE,
  name           varchar(200) NOT NULL,
  -- percent | fixed
  discount_type  varchar(10) NOT NULL DEFAULT 'fixed',
  discount_value integer NOT NULL CHECK (discount_value > 0),
  min_amount     integer NOT NULL DEFAULT 0,
  max_discount   integer,
  usage_limit    integer,
  used_count     integer NOT NULL DEFAULT 0,
  starts_at      timestamptz,
  ends_at        timestamptz,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 주문 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_orders (
  id                uuid PRIMARY KEY,
  -- 사람이 읽는 주문번호 (예: 20260825-0001)
  order_no          varchar(30) NOT NULL UNIQUE,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 상태: pending(입금대기) → paid → preparing → shipped → delivered
  --       / cancelled / refunded
  status            varchar(20) NOT NULL DEFAULT 'pending',
  -- 금액 스냅샷 (원). subtotal - discount + shipping_fee = total
  subtotal          integer NOT NULL,
  discount          integer NOT NULL DEFAULT 0,
  shipping_fee      integer NOT NULL DEFAULT 0,
  total             integer NOT NULL,
  coupon_code       varchar(50),
  -- 결제
  payment_method    varchar(30) NOT NULL DEFAULT 'bank_transfer',
  payment_status    varchar(20) NOT NULL DEFAULT 'unpaid',
  paid_at           timestamptz,
  -- 주문자 / 배송지 (회원 정보가 바뀌어도 주문 내역은 유지)
  orderer_name      varchar(100) NOT NULL,
  orderer_phone     varchar(30) NOT NULL,
  orderer_email     varchar(255),
  receiver_name     varchar(100) NOT NULL,
  receiver_phone    varchar(30) NOT NULL,
  postcode          varchar(20) NOT NULL,
  address1          varchar(300) NOT NULL,
  address2          varchar(300),
  delivery_memo     varchar(500),
  tracking_no       varchar(100),
  -- 비회원 주문 조회용 (주문번호 + 이 토큰)
  guest_token       varchar(64),
  cancelled_reason  varchar(500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_user_idx ON shop_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON shop_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS shop_order_items (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES shop_products(id) ON DELETE SET NULL,
  option_id    uuid REFERENCES shop_product_options(id) ON DELETE SET NULL,
  -- 주문 시점 스냅샷: 상품이 삭제/변경되어도 내역이 남는다
  product_name varchar(300) NOT NULL,
  option_name  varchar(200),
  unit_price   integer NOT NULL,
  quantity     integer NOT NULL CHECK (quantity > 0),
  line_total   integer NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON shop_order_items (order_id);

-- ── 주문 상태 변경 이력 (감사/추적) ────────────────────
CREATE TABLE IF NOT EXISTS shop_order_events (
  id         uuid PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  from_status varchar(20),
  to_status  varchar(20) NOT NULL,
  note       varchar(500),
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_order_events_order_idx ON shop_order_events (order_id, created_at);
