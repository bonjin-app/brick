-- 세금 증빙 — 현금영수증 · 세금계산서 · 면세 구분
--
-- 이 영역은 틀리면 **세금을 잘못 낸다.** 부가가치세법 제32조의2·제46조:
-- 최종소비자가 요청하면 현금영수증을 발급해야 하고, 미발급은 미발급액의
-- 20% 가산세다.
--
-- 카드 결제는 PG 가 국세청에 자동 통보하므로 우리가 할 일이 없다.
-- 문제는 **무통장 입금**이다 — 그누보드 쇼핑몰의 상당수가 무통장 위주이고,
-- 그것은 우리가 발급해야 한다.

-- ── 면세 상품 ───────────────────────────────────────
--
-- 도서·농수산물·의료 등은 부가세가 없다(부가가치세법 제26조).
-- 서점이 부가세를 붙여 영수증을 발급하면 **잘못된 증빙**이고, 손님이
-- 부가세를 환급받을 수 없다.
--
-- 영카트의 it_notax 에 대응한다.
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS tax_free boolean NOT NULL DEFAULT false;

-- 주문 항목에도 스냅샷을 남긴다.
--
-- 상품의 면세 여부는 바뀔 수 있고(세법이 바뀌거나 운영자가 잘못 설정했다가
-- 고친다), 그때 **과거 주문의 증빙 금액이 달라지면 안 된다.** 이미 신고한
-- 숫자가 흔들리는 것은 사고다.
ALTER TABLE shop_order_items
  ADD COLUMN IF NOT EXISTS tax_free boolean NOT NULL DEFAULT false;

-- ── 현금영수증 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_cash_receipts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,

  /**
   * income_deduction(소득공제용) — 개인. 휴대폰 번호나 현금영수증카드 번호
   * expense_proof(지출증빙용)   — 사업자. 사업자등록번호
   *
   * 용도를 반드시 구분해야 한다. 사업자가 소득공제용으로 받으면 매입세액을
   * 공제받을 수 없고, 개인이 지출증빙용으로 받으면 연말정산에 안 잡힌다.
   */
  kind varchar(20) NOT NULL,

  /**
   * 식별번호 — 휴대폰 번호 또는 사업자등록번호.
   *
   * **개인정보다.** 목록·로그에는 가려서 보여준다(010-****-5678).
   * 그래도 저장은 해야 한다 — 취소·재발급에 필요하고 발급 사실의 증거다.
   */
  identifier varchar(40) NOT NULL,

  /**
   * requested — 발급 요청됨 (수동 발급 모드에서 운영자 처리 대기)
   * issued    — 발급 완료
   * cancelled — 취소됨 (반품·환불)
   * failed    — 발급 실패
   */
  status varchar(16) NOT NULL DEFAULT 'requested',

  /** 총액 = 공급가액 + 부가세 + 면세금액. 셋이 합쳐 총액이 되어야 한다 */
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  supply_amount integer NOT NULL DEFAULT 0 CHECK (supply_amount >= 0),
  vat_amount integer NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  tax_free_amount integer NOT NULL DEFAULT 0 CHECK (tax_free_amount >= 0),
  CONSTRAINT shop_cash_receipt_amount_chk
    CHECK (total_amount = supply_amount + vat_amount + tax_free_amount),

  /** 발급 수단 — "manual"(홈택스에서 직접) 또는 PG provider 이름 */
  gateway varchar(30) NOT NULL DEFAULT 'manual',
  /** 국세청 승인번호 */
  approval_no varchar(60),
  receipt_url text,
  error text,

  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text
);

CREATE INDEX IF NOT EXISTS shop_cash_receipts_order_idx
  ON shop_cash_receipts (order_id, status);
CREATE INDEX IF NOT EXISTS shop_cash_receipts_issued_idx
  ON shop_cash_receipts (issued_at DESC) WHERE status = 'issued';

-- 같은 주문에 두 번 발급하면 **세금을 두 번 신고한다.**
-- 취소된 것은 다시 발급할 수 있어야 하므로 부분 인덱스로 살아 있는 것만 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS shop_cash_receipts_once_idx
  ON shop_cash_receipts (order_id)
  WHERE status IN ('requested', 'issued');

-- ── 세금계산서 요청 ─────────────────────────────────
--
-- 국세청 전자세금계산서 연동은 사업자 인증서가 필요해서 이 단계에서는 하지
-- 않는다. 대신 **요청을 잃어버리지 않는 것**부터 한다 — 지금은 요청이
-- 1:1 문의로 들어와 묻히고, 사업자 손님은 매입세액을 공제받지 못한다.
CREATE TABLE IF NOT EXISTS shop_tax_invoices (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,

  /** 사업자등록번호 — 체크섬을 검증해서 받는다 (core 의 isValidBusinessNo) */
  business_no varchar(20) NOT NULL,
  company_name varchar(200) NOT NULL,
  ceo_name varchar(100) NOT NULL,
  address text,
  business_type varchar(100),
  business_item varchar(100),
  /** 계산서를 받을 담당자 */
  contact_name varchar(100),
  contact_email varchar(255) NOT NULL,
  contact_phone varchar(30),

  /** requested | issued | rejected */
  status varchar(16) NOT NULL DEFAULT 'requested',
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  supply_amount integer NOT NULL DEFAULT 0,
  vat_amount integer NOT NULL DEFAULT 0,
  tax_free_amount integer NOT NULL DEFAULT 0,

  /** 발급 후 기록 — 국세청 승인번호와 링크 */
  invoice_no varchar(60),
  invoice_url text,
  note text,

  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  rejected_at timestamptz,
  reject_reason text
);

CREATE INDEX IF NOT EXISTS shop_tax_invoices_status_idx
  ON shop_tax_invoices (status, requested_at DESC);
-- 한 주문에 세금계산서는 하나다 (거부된 것은 다시 요청할 수 있다)
CREATE UNIQUE INDEX IF NOT EXISTS shop_tax_invoices_once_idx
  ON shop_tax_invoices (order_id)
  WHERE status IN ('requested', 'issued');
