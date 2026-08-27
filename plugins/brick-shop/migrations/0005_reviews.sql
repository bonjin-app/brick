-- 상품 후기 · 문의 · 다중 이미지 · 옵션 (영카트 격차 해소).

-- ── 다중 이미지 ────────────────────────────────────────
-- 갤러리는 상품당 몇 장이므로 별도 테이블보다 jsonb가 단순하다.
-- image_url(대표)은 목록·위젯이 이미 쓰고 있으므로 유지한다.
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]',
  -- 후기 집계. 매번 AVG를 계산하지 않도록 컬럼으로 둔다 (추천 수와 같은 방식)
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  ADD COLUMN IF NOT EXISTS rating_sum   integer NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  ADD COLUMN IF NOT EXISTS inquiry_count integer NOT NULL DEFAULT 0 CHECK (inquiry_count >= 0);

-- ── 후기 ──────────────────────────────────────────────
-- 구매 검증이 핵심이다: order_id가 있어야 "구매자 후기"임을 증명할 수 있다.
CREATE TABLE IF NOT EXISTS shop_reviews (
  id               uuid PRIMARY KEY,
  product_id       uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 탈퇴해도 목록이 깨지지 않게 스냅샷
  author_name      varchar(100) NOT NULL,
  -- 구매 근거. 주문이 삭제되어도 후기는 남으므로 FK를 걸지 않고 번호만 남긴다
  order_no         varchar(30),
  rating           smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content          text NOT NULL,
  images           jsonb NOT NULL DEFAULT '[]',
  -- 판매자 답변
  admin_reply      text,
  admin_replied_at timestamptz,
  -- 관리자가 부적절한 후기를 숨길 수 있다 (삭제보다 되돌리기 쉽다)
  is_visible       boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- 상품당 1인 1회. 여러 번 사도 후기는 하나다(영카트와 같은 관례)
CREATE UNIQUE INDEX IF NOT EXISTS shop_reviews_once_idx
  ON shop_reviews (product_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_reviews_product_idx
  ON shop_reviews (product_id, created_at DESC) WHERE is_visible = true;
CREATE INDEX IF NOT EXISTS shop_reviews_user_idx ON shop_reviews (user_id, created_at DESC);

-- ── 문의 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_inquiries (
  id               uuid PRIMARY KEY,
  product_id       uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name      varchar(100) NOT NULL,
  title            varchar(300) NOT NULL,
  content          text NOT NULL,
  -- 비밀 문의: 작성자와 판매자만 내용을 본다 (배송지·연락처를 쓰는 경우가 많다)
  is_secret        boolean NOT NULL DEFAULT false,
  -- open | answered
  status           varchar(16) NOT NULL DEFAULT 'open',
  admin_reply      text,
  admin_replied_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_inquiries_product_idx ON shop_inquiries (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_inquiries_status_idx ON shop_inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_inquiries_user_idx ON shop_inquiries (user_id, created_at DESC);
