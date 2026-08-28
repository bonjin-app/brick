-- 관련 상품
--
-- 두 가지를 함께 쓴다:
--
--   수동 지정  — 운영자가 고른다. 이 테이블.
--   함께 구매  — 주문 이력에서 계산한다. 테이블이 없다.
--
-- 왜 둘 다인가: **새로 연 쇼핑몰에는 주문 이력이 없다.** 자동 추천만 두면
-- 오픈 직후 몇 달간 아무것도 안 보인다. 반대로 수동만 두면 상품이 천 개인
-- 사이트에서 운영자가 다 지정할 수 없다.
--
-- 그래서 수동 지정을 먼저 쓰고, 모자라는 자리를 함께 구매로 채운다.

CREATE TABLE IF NOT EXISTS shop_related_products (
  product_id  uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  related_id  uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, related_id),
  -- 자기 자신을 관련 상품으로 넣을 수 없다
  CONSTRAINT shop_related_not_self CHECK (product_id <> related_id)
);

-- 방향이 있다.
--
-- A → B 를 지정해도 B 상세에는 A 가 안 나온다. 본품에서 액세서리를 보여주고
-- 싶지만 그 반대는 원하지 않는 경우가 흔하다(액세서리 페이지에 본품이
-- 나오면 오히려 이탈한다). 양방향이 필요하면 두 줄을 넣으면 된다.
--
-- 상품 상세에서 매번 읽으므로 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS shop_related_product_idx
  ON shop_related_products (product_id, sort_order);

-- 함께 구매 계산에 쓰는 인덱스.
--
-- "이 상품이 든 주문들"을 찾고, 그 주문의 다른 항목을 세는 쿼리다.
-- product_id 로 주문을 찾는 경로가 없으면 주문 항목 전체를 훑는다.
CREATE INDEX IF NOT EXISTS shop_order_items_product_idx
  ON shop_order_items (product_id, order_id);
