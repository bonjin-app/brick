-- 배송지 — 회원이 주문할 때마다 주소를 다시 적지 않게
--
-- 주문서는 이름·연락처·우편번호·주소·상세주소를 **매번 처음부터** 받았다.
-- 회원으로 열 번을 사도 열 번을 적는다. 한국 쇼핑몰이 전부 "배송지 목록"을
-- 두는 이유이고, 주소를 다시 적는 자리가 장바구니 다음으로 이탈이 잦은 곳이다.
--
-- 주문에는 **주소를 복사해 둔다**(shop_orders 가 이미 그렇게 저장한다). 배송지를
-- 나중에 고치거나 지워도 **지난 주문의 배송지는 그대로**여야 하기 때문이다 —
-- 참조로 이어 두면 "그때 어디로 보냈는지"가 사라진다.

CREATE TABLE IF NOT EXISTS shop_addresses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** 회원이 붙이는 이름 (집·회사). 비워도 된다 */
  label varchar(30) NOT NULL DEFAULT '',
  receiver_name varchar(50) NOT NULL,
  receiver_phone varchar(20) NOT NULL,
  postcode varchar(10) NOT NULL,
  address1 varchar(200) NOT NULL,
  address2 varchar(200) NOT NULL DEFAULT '',
  /** 기본 배송지. 회원당 하나만 참(부분 유니크 인덱스가 지킨다) */
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 회원의 목록을 최근 것부터 — 화면이 그 순서로 읽는다
CREATE INDEX IF NOT EXISTS shop_addresses_user_idx
  ON shop_addresses (user_id, created_at DESC);

/*
 * 기본 배송지는 회원당 **하나뿐**이다.
 *
 * 코드로만 지키면 두 요청이 동시에 "기본으로" 를 누를 때 둘 다 참이 된다
 * (그 다음부터 주문서는 어느 쪽을 고를지 알 수 없다). DB 가 지킨다.
 */
CREATE UNIQUE INDEX IF NOT EXISTS shop_addresses_default_idx
  ON shop_addresses (user_id) WHERE is_default;
