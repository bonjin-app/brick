-- 개인결제 (주문서 없는 청구)
--
-- 전화·상담·SNS 로 주문을 받고 **금액만 청구**하는 방식이다. 그누보드
-- 쇼핑몰이 실제로 많이 쓴다 — 맞춤 제작, 견적 후 결제, 추가 배송비 청구,
-- 오프라인 주문의 온라인 수납.
--
-- ── 왜 그림자 주문을 만드는가 ─────────────────────────
--
-- 결제만 따로 만들면 **매출 집계가 샌다.** 판매 리포트(ADR-51)와 부가세
-- 신고 자료(ADR-54)는 `shop_orders` 를 기준으로 세는데, 주문 없는 결제는
-- 거기에 안 잡힌다. 세금 신고에서 빠지는 매출이 생긴다.
--
-- 그래서 청구를 결제하면 **주문을 만든다.** 상품이 없는 주문이므로
-- `shop_order_items` 에 청구 제목을 상품명으로 한 항목 하나를 넣는다 —
-- 그러면 상품별 리포트와 현금영수증 금액 분해가 그대로 동작한다.
--
-- ── 재고를 건드리지 않는다 ───────────────────────────
--
-- 개인결제에는 상품이 없다(있다면 정상 주문으로 받아야 한다). `product_id`
-- 가 NULL 인 항목을 만들어 재고 로직이 지나가게 한다.

CREATE TABLE IF NOT EXISTS shop_payment_requests (
  id uuid PRIMARY KEY,

  /**
   * 청구 번호 — 손님에게 알려주는 값.
   *
   * 주문번호와 형식을 다르게 한다(`PR-` 접두). 손님이 주문번호로 착각해
   * 주문 조회에 넣으면 "없다"고 나오는데, 그때 사업자에게 문의가 온다.
   */
  request_no varchar(30) NOT NULL UNIQUE,

  title varchar(200) NOT NULL,
  description text,
  amount integer NOT NULL CHECK (amount > 0),

  /**
   * 결제 링크 토큰.
   *
   * 링크만 있으면 결제할 수 있다 — 비회원도 결제해야 하기 때문이다
   * (전화 주문 손님이 회원일 이유가 없다).
   *
   * 그래서 **추측 불가능해야 한다.** 32바이트 난수를 쓴다. 청구번호를
   * 링크에 쓰면 순차적이라 남의 청구서를 열어볼 수 있다.
   */
  token varchar(64) NOT NULL UNIQUE,

  /**
   * pending   — 결제 대기
   * paid      — 결제 완료
   * cancelled — 사업자가 취소
   * expired   — 기한 지남
   */
  status varchar(16) NOT NULL DEFAULT 'pending',

  /**
   * 만료 시각.
   *
   * 기한을 두는 이유: 금액을 바꿔 다시 청구하는 일이 흔한데, 옛 링크가
   * 살아 있으면 손님이 그것으로 결제해 **금액이 틀린 결제**가 생긴다.
   */
  expires_at timestamptz,

  /** 받는 사람 (연락용. 없어도 된다 — 링크만 보내는 경우가 있다) */
  customer_name varchar(100),
  customer_phone varchar(30),
  customer_email varchar(255),

  /** 결제되면 만들어지는 주문 (매출 집계가 이 주문을 본다) */
  order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  cancelled_at timestamptz,
  memo text
);

CREATE INDEX IF NOT EXISTS shop_payment_requests_status_idx
  ON shop_payment_requests (status, created_at DESC);

-- 청구 번호 시퀀스 — 주문번호와 같은 방식(0002_order_seq.sql)
CREATE SEQUENCE IF NOT EXISTS shop_payment_request_seq START 1;

-- 개인결제로 만들어진 주문임을 표시한다.
--
-- 필요한 이유: 주문 목록에서 "이 주문에는 배송할 상품이 없다"를 운영자가
-- 알아야 한다. 배송 준비 상태로 넘기려다 혼란이 생긴다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS is_direct_payment boolean NOT NULL DEFAULT false;
