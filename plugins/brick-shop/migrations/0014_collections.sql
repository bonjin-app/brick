-- 기획전 — 상품을 묶어 보여주는 페이지
--
-- 분류(category)와 다르다. 분류는 상품의 **소속**이고 하나뿐이지만, 기획전은
-- **진열**이다 — "여름 세일"에 우산과 선풍기가 함께 있고, 같은 상품이 여러
-- 기획전에 들어간다. 기간이 있고, 끝나면 내려간다.

CREATE TABLE IF NOT EXISTS shop_collections (
  id uuid PRIMARY KEY,
  slug varchar(100) NOT NULL UNIQUE,
  title varchar(200) NOT NULL,
  /** 기획전 상단에 보여줄 소개 문구 */
  description text,

  /**
   * 기간. NULL 이면 상시.
   *
   * 끝난 기획전은 목록에서 빠지고 **직접 열면 "종료" 안내**를 보여준다 —
   * 404 를 주면 공유된 링크를 타고 온 손님이 사이트가 고장난 줄 안다.
   */
  starts_at timestamptz,
  ends_at timestamptz,

  is_visible boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_collection_items (
  collection_id uuid NOT NULL REFERENCES shop_collections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  /** 운영자가 정한 진열 순서 — 기획전은 순서가 곧 편집 의도다 */
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id)
);

CREATE INDEX IF NOT EXISTS shop_collection_items_product_idx
  ON shop_collection_items (product_id);
