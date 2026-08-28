-- 회원 등급 — 구매 실적에 따른 혜택
--
-- 역할(guest/member/manager/admin)과는 별개 개념이다 (ADR-25).
-- 역할은 **권한**이고 등급은 **혜택**이다 — 섞으면 "VIP 라서 글을 지울 수
-- 있다" 같은 사고가 난다.
--
-- ── 산정 기준: 판매 리포트와 같은 정의 ────────────────
--
-- 등급 산정 금액은 최근 N개월의 **순매출**이다: 결제 완료 금액 − 완료된
-- 반품 환불액 (ADR-51 과 동일). 반품을 빼지 않으면 사서 반품하기를 반복해
-- 등급을 올릴 수 있다.

CREATE TABLE IF NOT EXISTS shop_grades (
  id uuid PRIMARY KEY,
  name varchar(50) NOT NULL UNIQUE,

  /**
   * 이 등급이 되는 최소 금액 (최근 N개월 순매출).
   *
   * 0 인 등급이 기본 등급이다. 금액이 겹치면 안 되므로 UNIQUE.
   */
  min_amount integer NOT NULL UNIQUE CHECK (min_amount >= 0),

  /**
   * 상품 금액 할인율 (%).
   *
   * 50% 상한 — 그 이상은 입력 실수(5% 를 50% 로)일 가능성이 높고,
   * 반값 이상의 상시 할인은 등급이 아니라 가격 정책의 문제다.
   */
  discount_rate numeric(4,1) NOT NULL DEFAULT 0
    CHECK (discount_rate >= 0 AND discount_rate <= 50),

  /** 등급 안내 문구 (마이페이지에 보여준다) */
  description varchar(300),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 회원별 배정 ─────────────────────────────────────
--
-- 주문할 때마다 계산하지 않고 배정을 저장한다. 이유:
--   1. 등급은 "이번 달의 내 등급"으로 안내되는 값이다 — 주문 중에 실시간으로
--      바뀌면 장바구니와 결제 화면의 할인이 달라져 혼란스럽다.
--   2. 산정 쿼리(기간 순매출)가 주문마다 돌기엔 무겁다.
-- 재계산은 주기 스윕이 한다 (재입고 알림과 같은 방식 — ADR-63).
CREATE TABLE IF NOT EXISTS shop_user_grades (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  grade_id uuid NOT NULL REFERENCES shop_grades(id) ON DELETE CASCADE,
  /** 산정에 쓰인 금액 — "왜 이 등급인가"에 답할 수 있어야 한다 */
  base_amount integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_user_grades_grade_idx ON shop_user_grades (grade_id);

-- ── 주문 스냅샷 ─────────────────────────────────────
--
-- 등급 할인은 orders.discount 에 **합산**된다 (쿠폰과 함께) — 환불 안분과
-- 리포트가 discount 를 기준으로 계산하므로 그 흐름이 그대로 정합하다.
-- 다만 내역 화면에서 "무엇이 얼마였는지"를 보여줘야 하므로 스냅샷을 남긴다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS grade_discount integer NOT NULL DEFAULT 0
    CHECK (grade_discount >= 0),
  ADD COLUMN IF NOT EXISTS grade_name varchar(50);
