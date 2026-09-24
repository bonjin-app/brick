/**
 * 회원별 PG 고객 식별자 — 카드 등록을 **이 회원에게** 묶는다.
 *
 * 고객 식별자를 발급만 하고 기억하지 않았다. 카드 등록 요청이 들고 온 값을 그대로 믿었으므로,
 * 남의 빌링키와 그 고객 식별자(둘 다 카드 등록 뒤 돌아오는 주소에 실린다 — 방문 기록·공유 링크에
 * 남는다)를 가진 사람이 그 카드를 **자기 계정에 등록해 청구**할 수 있었다. 토스의 authKey 는 한 번
 * 쓰면 끝이라 드러나지 않았지만, 포트원의 빌링키는 계속 쓰는 값이다.
 *
 * 회원마다 하나를 만들어 두고 다시 쓴다(PG 의 "고객" 이 한 사람이어야 콘솔에서도 읽힌다).
 */
CREATE TABLE IF NOT EXISTS shop_billing_customers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_key varchar(100) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
