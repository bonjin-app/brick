-- 관리 목록과 스토어프론트 첫 화면이 순차 스캔을 하고 있었다.
--
-- 상품 5,000 · 주문 20,000 · 후기 10,000 을 넣고 EXPLAIN ANALYZE 로 재서 **실제로 개선된
-- 것만** 남긴다. 인덱스는 쓰기 비용이므로 "있으면 좋겠지"로 넣지 않는다. 후보였던
-- `shop_reviews (created_at) WHERE admin_reply IS NULL` 은 아래 표현식 인덱스가 그 일을
-- 대신해 차이가 없어서(0.09 vs 0.10ms) 넣지 않았다.

-- 관리 주문 목록의 **첫 화면**(필터 없음)은 status 를 안 걸므로 shop_orders_status_idx 를
-- 못 탄다. 운영자가 하루에 가장 많이 여는 화면이다.  1.77ms → 0.01ms
CREATE INDEX IF NOT EXISTS shop_orders_recent_idx ON shop_orders (created_at DESC);

-- 후기 관리는 "답변을 기다리는 것"을 먼저 보여준다. 표현식 정렬이라 평범한 인덱스로는
-- 안 되고, 표현식 인덱스라야 정렬까지 인덱스가 해결한다.  1.49ms → 0.02ms
CREATE INDEX IF NOT EXISTS shop_reviews_admin_idx
  ON shop_reviews (((admin_reply IS NULL)) DESC, created_at DESC);

-- 손님이 여는 상품 목록. status IN (두 값) 이라 shop_products_list_idx 를 못 타고 전체를
-- 훑고 있었다. 부분 인덱스로 "파는 것"만 담고, price 를 INCLUDE 해서 가격대 눈금(min/max)도
-- 힙을 읽지 않게 한다.  목록 0.49ms → 0.01ms, 눈금 0.35ms → 0.18ms
CREATE INDEX IF NOT EXISTS shop_products_public_idx
  ON shop_products (sort_order, created_at DESC) INCLUDE (price)
  WHERE status IN ('selling', 'soldout');
