-- 위시리스트 (보관함) · 최근 본 상품
--
-- 영카트의 "보관함"에 대응한다. 장바구니와 다른 이유:
--   장바구니는 "살 것"이고 위시리스트는 "볼 것"이다. 장바구니에 넣어두면
--   결제 화면에서 매번 지워야 하고, 재고가 없으면 주문 자체가 막힌다.

CREATE TABLE IF NOT EXISTS shop_wishlist (
  id uuid PRIMARY KEY,
  /**
   * 회원 또는 비회원 토큰.
   *
   * 비회원도 되게 하는 이유: 위시리스트는 **로그인하기 전에** 쓰는 기능이다.
   * "마음에 드는 걸 담아두다가 나중에 가입"하는 흐름이 실제이고,
   * 로그인을 요구하면 아무도 쓰지 않는다. 장바구니와 같은 판단이다.
   */
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_token varchar(64),
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_wishlist_owner_chk CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)
);

-- 같은 상품을 두 번 담지 않는다. 회원과 비회원을 따로 잡는다 —
-- 부분 인덱스로 NULL 을 제외해야 유니크가 실제로 동작한다.
CREATE UNIQUE INDEX IF NOT EXISTS shop_wishlist_user_once_idx
  ON shop_wishlist (user_id, product_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_wishlist_guest_once_idx
  ON shop_wishlist (guest_token, product_id) WHERE guest_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS shop_wishlist_user_idx
  ON shop_wishlist (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_wishlist_guest_idx
  ON shop_wishlist (guest_token, created_at DESC) WHERE guest_token IS NOT NULL;
-- "이 상품을 몇 명이 담았는가" — 인기 상품 판단에 쓴다
CREATE INDEX IF NOT EXISTS shop_wishlist_product_idx ON shop_wishlist (product_id);

-- ── 최근 본 상품 ────────────────────────────────────
--
-- 왜 서버에 저장하는가: 브라우저 저장만으로 하면 기기를 바꾸면 사라지고,
-- 회원의 관심사를 추천에 쓸 수 없다. 다만 개인정보 성격이 강하므로
-- **보관 기간을 짧게** 두고 정기적으로 지운다.
CREATE TABLE IF NOT EXISTS shop_recent_views (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_token varchar(64),
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_recent_owner_chk CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)
);

-- 같은 상품을 다시 보면 시각만 갱신한다 (행이 쌓이지 않는다)
CREATE UNIQUE INDEX IF NOT EXISTS shop_recent_user_once_idx
  ON shop_recent_views (user_id, product_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_recent_guest_once_idx
  ON shop_recent_views (guest_token, product_id) WHERE guest_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS shop_recent_user_idx
  ON shop_recent_views (user_id, viewed_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_recent_guest_idx
  ON shop_recent_views (guest_token, viewed_at DESC) WHERE guest_token IS NOT NULL;
-- 오래된 기록 정리에 쓴다
CREATE INDEX IF NOT EXISTS shop_recent_viewed_idx ON shop_recent_views (viewed_at);

-- ── 지역별 추가 배송비 ──────────────────────────────
--
-- 제주·도서산간은 추가 배송비가 붙는다. 우편번호 구간으로 판단한다 —
-- 주소 문자열로 판단하면 "제주도청"과 "제주식당"을 구분할 수 없다.
CREATE TABLE IF NOT EXISTS shop_shipping_zones (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL,
  /** 우편번호 시작 (5자리). 구간으로 판단한다 */
  postcode_from varchar(5) NOT NULL,
  postcode_to varchar(5) NOT NULL,
  extra_fee integer NOT NULL DEFAULT 0 CHECK (extra_fee >= 0),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_zones_range_chk CHECK (postcode_from <= postcode_to)
);

CREATE INDEX IF NOT EXISTS shop_zones_range_idx
  ON shop_shipping_zones (postcode_from, postcode_to) WHERE is_active = true;

-- 기본 구간을 심는다.
-- 비어 있으면 "지역별 배송비 기능이 없다"고 오해하고, 직접 만들려면
-- 우편번호 구간을 찾아야 한다. 값은 관리자가 고쳐 쓴다.
INSERT INTO shop_shipping_zones (id, name, postcode_from, postcode_to, extra_fee, sort_order)
SELECT gen_random_uuid(), '제주', '63000', '63644', 3000, 0
WHERE NOT EXISTS (SELECT 1 FROM shop_shipping_zones);

INSERT INTO shop_shipping_zones (id, name, postcode_from, postcode_to, extra_fee, sort_order)
SELECT gen_random_uuid(), '울릉도·독도', '40200', '40240', 5000, 1
WHERE NOT EXISTS (SELECT 1 FROM shop_shipping_zones WHERE name = '울릉도·독도');

-- 주문에 지역 추가비를 기록한다. 금액 내역이 맞아야 정산이 된다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS zone_fee integer NOT NULL DEFAULT 0 CHECK (zone_fee >= 0),
  ADD COLUMN IF NOT EXISTS zone_name varchar(100);
