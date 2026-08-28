-- 쿠폰 고도화 — 조건과 발급형
--
-- 지금 쿠폰은 "코드를 아는 사람은 누구나, 전체 한도까지" 다. 실무에서 필요한
-- 것이 빠져 있다:
--
--   1인 제한      — 전체 한도만 있으면 한 사람이 다 쓴다
--   첫 구매 전용   — 신규 유치 쿠폰이 기존 회원에게 새면 비용만 나간다
--   등급 전용      — "골드 회원 전용 쿠폰"
--   발급형(쿠폰함) — 코드 공유가 안 되는 쿠폰. 코드가 커뮤니티에 퍼지면
--                    코드형으로는 대상을 통제할 수 없다

ALTER TABLE shop_coupons
  /**
   * 1인당 사용 한도. NULL 이면 무제한.
   *
   * 판정은 주문 이력(취소 제외)으로 한다 — 별도 카운터를 두면 주문 취소 때
   * 되돌리는 것을 잊는 순간부터 어긋난다. 비회원은 신원을 셀 수 없으므로
   * 이 조건이 있는 쿠폰은 로그인을 요구한다.
   */
  ADD COLUMN IF NOT EXISTS per_user_limit integer
    CHECK (per_user_limit IS NULL OR per_user_limit > 0),

  /** 첫 구매 전용 — 결제 완료 이력이 없는 회원만 */
  ADD COLUMN IF NOT EXISTS first_purchase_only boolean NOT NULL DEFAULT false,

  /**
   * 등급 전용. 등급이 삭제되면 제한이 풀리는 것이 아니라 **아무도 못 쓰게**
   * 되면 안 되므로 SET NULL — 제한 없는 쿠폰이 된다. 운영자가 등급을
   * 지웠다면 그 제한도 의미를 잃은 것이다.
   */
  ADD COLUMN IF NOT EXISTS grade_id uuid REFERENCES shop_grades(id) ON DELETE SET NULL,

  /**
   * 발급형 — 쿠폰함에 지급받은 회원만 쓸 수 있다.
   *
   * 코드형과 발급형을 한 테이블에 두는 이유: 할인 계산·기간·한도 로직이
   * 동일하고, 관리 화면도 하나여야 운영자가 헷갈리지 않는다.
   */
  ADD COLUMN IF NOT EXISTS requires_issue boolean NOT NULL DEFAULT false;

-- ── 쿠폰함 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_user_coupons (
  id uuid PRIMARY KEY,
  coupon_id uuid NOT NULL REFERENCES shop_coupons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  /** 사용되면 채워진다. 주문이 취소되면 NULL 로 되돌린다 */
  used_at timestamptz,
  used_order_no varchar(30)
);

-- 같은 쿠폰을 같은 회원에게 두 번 지급하지 않는다.
-- 다시 지급하고 싶으면(재구매 유도 등) 쿠폰을 새로 만드는 것이 맞다 —
-- 지급 이력이 섞이면 "이 쿠폰을 언제 받았나"에 답할 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS shop_user_coupons_once_idx
  ON shop_user_coupons (coupon_id, user_id);
CREATE INDEX IF NOT EXISTS shop_user_coupons_user_idx
  ON shop_user_coupons (user_id) WHERE used_at IS NULL;
