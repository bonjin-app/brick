import type { AdminResource } from "@brick/plugin-sdk";
import { ORDER_STATUS, STATUS_LABEL, PRODUCT_STATUS_LABEL } from "./types.js";
import { REASON_CODES, RETURN_STATUS, RETURN_STATUS_LABEL } from "./returns.js";

/**
 * 관리자 리소스 선언.
 *
 * 코어 관리자가 이 스키마를 읽어 목록/폼 화면을 런타임에 생성한다.
 * 플러그인은 React 코드를 배포하지 않는다 — 이것이 ZIP 설치로 완전한
 * 관리 화면을 얻는 방법이다.
 */
export const PRODUCT_RESOURCE: AdminResource = {
  name: "products",
  title: "상품",
  itemLabel: "상품",
  basePath: "/admin/products",
  order: 10,
  description: "상품을 등록하고 가격·재고·진열 상태를 관리합니다. 금액은 원 단위입니다.",
  fields: [
    { name: "name", label: "상품명", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true,
      help: "영문 소문자/숫자/하이픈. 상품 페이지 주소가 됩니다: /shop/<slug>" },
    // 선택지가 테이블 행이므로 라우트에서 가져온다.
    // 이 필드가 없어서 **분류를 만들어도 상품에 지정할 방법이 없었다** —
    // 이전 도구로 옮긴 상품에는 분류가 있는데 새로 등록한 상품에는 없어서
    // 분류별 리포트가 반쪽이 되었다.
    { name: "category_id", label: "분류", type: "select", inList: true,
      optionsFrom: "/admin/options/categories",
      help: "분류를 먼저 등록해야 선택할 수 있습니다." },
    { name: "price", label: "판매가", type: "money", required: true, inList: true },
    { name: "list_price", label: "정가", type: "money", help: "비워두면 할인 표시를 하지 않습니다." },
    { name: "stock", label: "재고", type: "number", inList: true,
      help: "비워두면 무한 재고로 취급합니다 (디지털 상품 등)." },
    { name: "status", label: "판매 상태", type: "select", inList: true,
      options: Object.entries(PRODUCT_STATUS_LABEL).map(([value, label]) => ({ value, label })) },
    { name: "image_url", label: "대표 이미지", type: "image" },
    { name: "images_text", label: "추가 이미지", type: "textarea",
      help: "한 줄에 이미지 주소 하나. 최대 20장. 상세 화면에서 갤러리로 보여집니다. 대표 이미지를 비우면 첫 줄이 대표가 됩니다." },
    { name: "options_text", label: "옵션", type: "textarea",
      help: "한 줄에 하나: 이름|추가금|재고 (예: 색상: 빨강|1000|10). 추가금·재고는 생략 가능하고, 재고를 비우면 무한입니다. 이름을 그대로 두면 장바구니에 담긴 옵션이 유지됩니다." },
    // slug 로 지정한다 — uuid 는 운영자가 쓸 수 없고, 상품명은 중복될 수 있다
    { name: "related_text", label: "관련 상품", type: "textarea",
      help: "상품 주소(slug)를 한 줄에 하나씩. 비우면 함께 구매한 상품이 자동으로 표시됩니다." },
    { name: "summary", label: "짧은 설명", type: "textarea", help: "목록과 검색 결과에 노출됩니다." },
    { name: "description", label: "상세 설명", type: "richtext", help: "HTML을 사용할 수 있습니다." },
    { name: "free_shipping", label: "무료배송", type: "boolean" },
    // 도서·농수산물 등. 서점이 부가세를 붙여 증빙을 발급하면 잘못된 증빙이다
    { name: "tax_free", label: "면세 상품", type: "boolean",
      help: "도서·농수산물 등 부가세가 없는 상품. 현금영수증·세금계산서 금액 계산에 반영됩니다." },
    { name: "sort_order", label: "진열 순서", type: "number", help: "작을수록 먼저 표시됩니다." },
    { name: "sold_count", label: "판매수량", type: "number", readOnly: true, inList: true },
    { name: "rating_avg", label: "평점", type: "number", readOnly: true, inList: true },
    { name: "review_count", label: "후기", type: "number", readOnly: true, inList: true },
  ],
};

export const REVIEW_RESOURCE: AdminResource = {
  name: "reviews",
  title: "상품 후기",
  itemLabel: "후기",
  basePath: "/admin/reviews",
  order: 40,
  description:
    "구매 확인된 후기에는 '구매확인' 표시가 붙습니다. 부적절한 후기는 삭제 대신 표시를 끄면 되돌릴 수 있습니다.",
  can: { create: false },
  fields: [
    { name: "created_at", label: "작성일", type: "date", readOnly: true, inList: true },
    { name: "product_name", label: "상품", type: "text", readOnly: true, inList: true },
    { name: "author_name", label: "작성자", type: "text", readOnly: true, inList: true },
    { name: "rating", label: "별점", type: "number", readOnly: true, inList: true },
    { name: "verified", label: "구매확인", type: "boolean", readOnly: true, inList: true },
    { name: "content", label: "내용", type: "textarea", readOnly: true },
    { name: "admin_reply", label: "판매자 답변", type: "textarea",
      help: "고객에게 후기 아래에 함께 표시됩니다. 비우면 답변을 지웁니다." },
    { name: "is_visible", label: "표시", type: "boolean", inList: true,
      help: "끄면 고객에게 보이지 않고 평점에서도 제외됩니다." },
  ],
};

export const INQUIRY_RESOURCE: AdminResource = {
  name: "inquiries",
  title: "상품 문의",
  itemLabel: "문의",
  basePath: "/admin/inquiries",
  order: 41,
  description: "답변을 저장하면 상태가 '답변완료'로 바뀝니다. 비밀 문의는 작성자와 관리자만 볼 수 있습니다.",
  can: { create: false },
  fields: [
    { name: "created_at", label: "문의일", type: "date", readOnly: true, inList: true },
    { name: "product_name", label: "상품", type: "text", readOnly: true, inList: true },
    { name: "author_name", label: "작성자", type: "text", readOnly: true, inList: true },
    { name: "status_label", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "is_secret", label: "비밀", type: "boolean", readOnly: true, inList: true },
    { name: "title", label: "제목", type: "text", readOnly: true, inList: true },
    { name: "content", label: "문의 내용", type: "textarea", readOnly: true },
    { name: "admin_reply", label: "답변", type: "textarea",
      help: "저장하면 상태가 답변완료로 바뀝니다." },
  ],
};

export const CATEGORY_RESOURCE: AdminResource = {
  name: "categories",
  title: "상품 분류",
  itemLabel: "분류",
  basePath: "/admin/categories",
  order: 20,
  fields: [
    { name: "name", label: "분류명", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true },
    // 계층이 스키마에는 있는데 화면에 없어서 **운영자가 2단 분류를 만들 수
    // 없었다.** 이전 도구로 옮긴 사이트에만 계층이 있는 상태였다.
    { name: "parent_id", label: "상위 분류", type: "select", inList: true,
      optionsFrom: "/admin/options/categories",
      help: "비우면 최상위 분류가 됩니다." },
    { name: "sort_order", label: "순서", type: "number", inList: true },
    { name: "is_visible", label: "표시", type: "boolean", inList: true },
  ],
};

export const ORDER_RESOURCE: AdminResource = {
  name: "orders",
  title: "주문",
  itemLabel: "주문",
  basePath: "/admin/orders",
  order: 5,
  description:
    "주문 상태를 변경하면 이력이 기록됩니다. 취소·환불로 바꾸면 재고가 자동으로 복원됩니다.",
  can: { create: false, delete: false },
  fields: [
    { name: "order_no", label: "주문번호", type: "text", readOnly: true, inList: true },
    { name: "created_at", label: "주문일시", type: "date", readOnly: true, inList: true },
    { name: "orderer_name", label: "주문자", type: "text", readOnly: true, inList: true },
    { name: "total", label: "결제금액", type: "money", readOnly: true, inList: true },
    { name: "status", label: "주문 상태", type: "select", inList: true,
      options: ORDER_STATUS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      help: "허용된 전이만 가능합니다 (예: 배송중 → 배송완료)." },
    { name: "tracking_no", label: "운송장 번호", type: "text" },
    { name: "note", label: "변경 메모", type: "text", help: "상태 이력에 함께 기록됩니다." },
    { name: "items_summary", label: "주문 상품", type: "text", readOnly: true, inList: true },
    { name: "receiver_name", label: "받는 사람", type: "text", readOnly: true },
    { name: "receiver_phone", label: "받는 분 연락처", type: "text", readOnly: true },
    { name: "address_full", label: "배송지", type: "text", readOnly: true },
    { name: "delivery_memo", label: "배송 요청사항", type: "text", readOnly: true },
    { name: "payment_method", label: "결제수단", type: "text", readOnly: true },
  ],
};

export const COUPON_RESOURCE: AdminResource = {
  name: "coupons",
  title: "쿠폰",
  itemLabel: "쿠폰",
  basePath: "/admin/coupons",
  order: 30,
  fields: [
    { name: "code", label: "쿠폰 코드", type: "text", required: true, inList: true,
      help: "고객이 입력하는 코드입니다. 대소문자를 구분하지 않습니다." },
    { name: "name", label: "쿠폰 이름", type: "text", required: true, inList: true },
    { name: "discount_type", label: "할인 방식", type: "select", inList: true,
      options: [{ value: "fixed", label: "정액(원)" }, { value: "percent", label: "정률(%)" }] },
    { name: "discount_value", label: "할인 값", type: "number", required: true, inList: true,
      help: "정액이면 원, 정률이면 퍼센트." },
    { name: "min_amount", label: "최소 주문금액", type: "money" },
    { name: "max_discount", label: "최대 할인액", type: "money", help: "정률 할인의 상한. 비우면 무제한." },
    { name: "usage_limit", label: "전체 사용 한도", type: "number", help: "비우면 무제한." },
    // 전체 한도만 있으면 한 사람이 다 쓴다
    { name: "per_user_limit", label: "1인당 한도", type: "number",
      help: "비우면 무제한. 설정하면 로그인한 회원만 쓸 수 있습니다." },
    { name: "first_purchase_only", label: "첫 구매 전용", type: "boolean",
      help: "결제 이력이 없는 회원만. 신규 유치 쿠폰이 기존 회원에게 새는 것을 막습니다." },
    { name: "grade_id", label: "등급 전용", type: "select",
      optionsFrom: "/admin/options/grades",
      help: "비우면 전체. 지정하면 그 등급 회원만 쓸 수 있습니다." },
    { name: "requires_issue", label: "발급형", type: "boolean",
      help: "켜면 쿠폰함에 지급받은 회원만 씁니다 — 코드가 커뮤니티에 퍼져도 대상이 통제됩니다. " +
        "지급은 쿠폰 저장 후 발급 API(/admin/coupons/:id/issue)로 합니다." },
    { name: "used_count", label: "사용됨", type: "number", readOnly: true, inList: true },
    { name: "is_active", label: "활성", type: "boolean", inList: true },
  ],
};

export const RETURN_RESOURCE: AdminResource = {
  name: "returns",
  title: "취소·반품·교환",
  itemLabel: "요청",
  basePath: "/admin/returns",
  order: 6,
  description:
    "상태를 '처리완료'로 바꾸는 순간 재고가 복원되고 환불이 실행됩니다. " +
    "반품·교환은 물건을 받은 뒤(입고완료) 완료로 바꾸세요 — 그 전에 완료하면 돈만 나갑니다. " +
    "거부할 때는 사유를 반드시 입력해야 합니다.",
  can: { create: false, delete: false },
  fields: [
    { name: "return_no", label: "요청번호", type: "text", readOnly: true, inList: true },
    { name: "created_at", label: "신청일", type: "date", readOnly: true, inList: true },
    { name: "order_no", label: "주문번호", type: "text", readOnly: true, inList: true },
    { name: "orderer_name", label: "주문자", type: "text", readOnly: true, inList: true },
    { name: "kind_label", label: "종류", type: "text", readOnly: true, inList: true },
    { name: "status_label", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "reason_label", label: "사유", type: "text", readOnly: true, inList: true },
    { name: "reason", label: "상세 사유", type: "textarea", readOnly: true },
    { name: "refund_amount", label: "환불 예정액", type: "money", readOnly: true, inList: true },
    { name: "return_shipping_fee", label: "반품 배송비", type: "money", readOnly: true },
    { name: "shipping_payer", label: "배송비 부담", type: "text", readOnly: true,
      help: "단순 변심은 고객(customer), 불량·오배송은 사업자(seller) 부담입니다." },
    { name: "status", label: "상태 변경", type: "select",
      options: RETURN_STATUS.map((s) => ({ value: s, label: RETURN_STATUS_LABEL[s] })),
      help: "허용된 전이만 가능합니다. '처리완료'에서 재고 복원과 환불이 실행됩니다." },
    { name: "reject_reason", label: "거부 사유", type: "textarea",
      help: "거부하려면 반드시 입력해야 합니다. 고객에게 그대로 전달됩니다." },
    { name: "pickup_tracking_no", label: "수거 운송장", type: "text" },
    { name: "exchange_tracking_no", label: "교환품 운송장", type: "text" },
    { name: "admin_note", label: "내부 메모", type: "textarea" },
  ],
};

export const SHIPPING_ZONE_RESOURCE: AdminResource = {
  name: "shipping-zones",
  title: "지역별 배송비",
  itemLabel: "지역",
  basePath: "/admin/shipping-zones",
  order: 35,
  description:
    "제주·도서산간 추가 배송비를 우편번호 구간으로 정합니다. " +
    "주소 문자열이 아니라 우편번호로 판단합니다 — 서울에도 '제주도로'가 있습니다. " +
    "구간이 겹치면 가장 비싼 값이 적용됩니다.",
  fields: [
    { name: "name", label: "지역명", type: "text", required: true, inList: true },
    { name: "postcode_from", label: "우편번호 시작", type: "text", required: true, inList: true,
      help: "5자리 숫자. 예: 63000" },
    { name: "postcode_to", label: "우편번호 끝", type: "text", required: true, inList: true,
      help: "5자리 숫자. 예: 63644" },
    { name: "extra_fee", label: "추가 배송비", type: "money", required: true, inList: true },
    { name: "is_active", label: "적용", type: "boolean", inList: true },
    { name: "sort_order", label: "순서", type: "number", inList: true },
  ],
};

/**
 * 현금영수증.
 *
 * 기본은 수동 발급이다 — 운영자가 홈택스에서 발급하고 승인번호를 적는다.
 * 승인번호 없이 "발급됨"으로 바꿀 수 없게 막았다(tax.ts): 없으면 나중에
 * 국세청 자료와 대조할 수 없다.
 */
export const CASH_RECEIPT_RESOURCE: AdminResource = {
  name: "cash-receipts",
  title: "현금영수증",
  itemLabel: "발급",
  basePath: "/admin/cash-receipts",
  order: 7,
  description:
    "부가가치세법 제32조의2 — 손님이 요청하면 발급해야 하고, 미발급은 미발급액의 20% 가산세입니다. " +
    "카드 결제는 카드사가 국세청에 자동 통보하므로 발급 대상이 아닙니다(이중 신고가 됩니다). " +
    "'발급대기'는 아직 국세청에 신고되지 않았다는 뜻입니다 — 홈택스에서 발급한 뒤 승인번호를 입력하세요.",
  can: { create: false, delete: false },
  fields: [
    { name: "requested_at", label: "신청일", type: "date", readOnly: true, inList: true },
    { name: "order_no", label: "주문번호", type: "text", readOnly: true, inList: true },
    { name: "orderer_name", label: "주문자", type: "text", readOnly: true, inList: true },
    { name: "kind_label", label: "용도", type: "text", readOnly: true, inList: true },
    // 개인정보라 서버가 가려서 보낸다 (tax.ts maskIdentifier)
    { name: "identifier", label: "식별번호", type: "text", readOnly: true, inList: true,
      help: "개인정보이므로 뒤 4자리만 표시됩니다." },
    { name: "status", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "total_amount", label: "총액", type: "money", readOnly: true, inList: true },
    { name: "supply_amount", label: "공급가액", type: "money", readOnly: true },
    { name: "vat_amount", label: "부가세", type: "money", readOnly: true },
    { name: "tax_free_amount", label: "면세금액", type: "money", readOnly: true },
    { name: "gateway", label: "발급 수단", type: "text", readOnly: true },
    { name: "approval_no", label: "국세청 승인번호", type: "text",
      help: "홈택스에서 발급한 뒤 승인번호를 입력하고 상태를 '발급완료'로 바꾸세요." },
    { name: "receipt_url", label: "영수증 링크", type: "text" },
    { name: "error", label: "오류", type: "textarea", readOnly: true },
    { name: "cancel_reason", label: "취소 사유", type: "textarea", readOnly: true },
    { name: "status", label: "상태 변경", type: "select",
      options: [
        { value: "issued", label: "발급완료 (승인번호 필수)" },
        { value: "cancelled", label: "취소" },
      ] },
    { name: "reason", label: "취소 사유 입력", type: "textarea",
      help: "취소할 때 사유를 남기세요." },
  ],
};

/**
 * 세금계산서 요청.
 *
 * 국세청 전자세금계산서 연동은 사업자 인증서가 필요해서 아직 하지 않는다.
 * 이 화면의 목적은 **요청을 잃어버리지 않는 것**이다 — 지금까지는 요청이
 * 1:1 문의로 들어와 묻히고, 사업자 손님은 매입세액을 공제받지 못했다.
 */
export const TAX_INVOICE_RESOURCE: AdminResource = {
  name: "tax-invoices",
  title: "세금계산서 요청",
  itemLabel: "요청",
  basePath: "/admin/tax-invoices",
  order: 8,
  description:
    "사업자 손님의 세금계산서 요청입니다. 홈택스에서 발급한 뒤 승인번호를 입력하세요. " +
    "발급하지 않으면 손님이 매입세액을 공제받지 못합니다. 거부할 때는 사유가 필수입니다.",
  can: { create: false, delete: false },
  fields: [
    { name: "requested_at", label: "요청일", type: "date", readOnly: true, inList: true },
    { name: "order_no", label: "주문번호", type: "text", readOnly: true, inList: true },
    { name: "company_name", label: "상호", type: "text", readOnly: true, inList: true },
    { name: "business_no", label: "사업자등록번호", type: "text", readOnly: true, inList: true },
    { name: "ceo_name", label: "대표자", type: "text", readOnly: true },
    { name: "address", label: "사업장 주소", type: "textarea", readOnly: true },
    { name: "business_type", label: "업태", type: "text", readOnly: true },
    { name: "business_item", label: "종목", type: "text", readOnly: true },
    { name: "contact_name", label: "담당자", type: "text", readOnly: true },
    { name: "contact_email", label: "계산서 받을 이메일", type: "text", readOnly: true, inList: true },
    { name: "contact_phone", label: "연락처", type: "text", readOnly: true },
    { name: "status", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "total_amount", label: "총액", type: "money", readOnly: true, inList: true },
    { name: "supply_amount", label: "공급가액", type: "money", readOnly: true },
    { name: "vat_amount", label: "부가세", type: "money", readOnly: true },
    { name: "tax_free_amount", label: "면세금액", type: "money", readOnly: true },
    { name: "invoice_no", label: "국세청 승인번호", type: "text",
      help: "발급 처리할 때 반드시 입력하세요 — 없으면 국세청 자료와 대조할 수 없습니다." },
    { name: "invoice_url", label: "계산서 링크", type: "text" },
    { name: "reject_reason", label: "거부 사유", type: "textarea", readOnly: true },
    { name: "status", label: "상태 변경", type: "select",
      options: [
        { value: "issued", label: "발급완료 (승인번호 필수)" },
        { value: "rejected", label: "거부 (사유 필수)" },
      ] },
    { name: "reason", label: "거부 사유 입력", type: "textarea" },
  ],
};

/**
 * 개인결제 청구.
 *
 * 금액을 고치는 수정은 두지 않았다 — 링크를 이미 보낸 뒤 금액이 바뀌면
 * 손님이 어느 금액을 본 것인지 알 수 없다. 취소하고 새로 청구해야 한다.
 */
export const PAYMENT_REQUEST_RESOURCE: AdminResource = {
  name: "payment-requests",
  title: "개인결제 청구",
  itemLabel: "청구",
  basePath: "/admin/payment-requests",
  order: 9,
  description:
    "전화·상담으로 받은 주문의 금액만 청구합니다. 만들면 결제 링크가 나오니 손님에게 보내세요. " +
    "결제되면 주문이 자동으로 만들어져 매출과 세금 자료에 포함됩니다. " +
    "금액을 바꾸려면 취소하고 새로 청구하세요 — 손님이 이미 본 금액이 달라지면 분쟁이 됩니다.",
  can: { update: false, delete: false },
  fields: [
    { name: "request_no", label: "청구번호", type: "text", readOnly: true, inList: true },
    { name: "created_at", label: "생성일", type: "date", readOnly: true, inList: true },
    { name: "title", label: "청구 제목", type: "text", required: true, inList: true,
      help: "손님에게 보이고, 매출 리포트의 상품명이 됩니다." },
    { name: "amount", label: "청구 금액", type: "money", required: true, inList: true },
    { name: "description", label: "설명", type: "textarea",
      help: "손님이 청구서에서 봅니다. 무엇에 대한 청구인지 적으세요." },
    { name: "expireDays", label: "유효 기간(일)", type: "number",
      help: "비우면 7일. 기한이 지난 링크로는 결제할 수 없습니다." },
    { name: "customer_name", label: "받는 분", type: "text", inList: true },
    { name: "customer_phone", label: "연락처", type: "text" },
    { name: "customer_email", label: "이메일", type: "text" },
    { name: "status_label", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "pay_path", label: "결제 링크", type: "text", readOnly: true,
      help: "이 주소를 손님에게 보내세요. 로그인 없이 결제할 수 있습니다." },
    { name: "order_no", label: "생성된 주문", type: "text", readOnly: true, inList: true },
    { name: "paid_at", label: "결제일", type: "date", readOnly: true },
    { name: "memo", label: "메모", type: "textarea" },
  ],
};

/**
 * 회원 등급.
 *
 * 역할(권한)과 별개다 — 등급은 할인 같은 혜택만 준다 (ADR-25).
 */
export const GRADE_RESOURCE: AdminResource = {
  name: "grades",
  title: "회원 등급",
  itemLabel: "등급",
  basePath: "/admin/grades",
  order: 10,
  description:
    "최근 3개월 구매 실적(반품 제외)으로 등급이 자동 배정됩니다. 6시간마다 재계산되고, " +
    "만들거나 바꾼 직후에는 '지금 재계산'을 부르세요. 기준 금액 0원인 등급이 기본 등급입니다.",
  can: { delete: true },
  fields: [
    { name: "name", label: "등급 이름", type: "text", required: true, inList: true },
    { name: "min_amount", label: "기준 금액 (최근 3개월 순구매액)", type: "money", required: true, inList: true,
      help: "이 금액 이상 구매한 회원이 이 등급이 됩니다. 0원이 기본 등급입니다." },
    { name: "discount_rate", label: "상품 할인율 (%)", type: "number", inList: true,
      help: "0~50%. 쿠폰과 함께 쓸 수 있고, 합쳐서 상품 금액을 넘지 않습니다." },
    { name: "description", label: "안내 문구", type: "textarea",
      help: "마이페이지의 등급 안내에 보입니다." },
    { name: "members", label: "인원", type: "number", readOnly: true, inList: true },
  ],
};

/**
 * 기획전.
 *
 * 상품 지정은 관련 상품과 같은 줄바꿈 slug 방식이다 — 없는 slug 는 저장할 때
 * 오류로 알려준다.
 */
export const COLLECTION_RESOURCE: AdminResource = {
  name: "collections",
  title: "기획전",
  itemLabel: "기획전",
  basePath: "/admin/collections",
  order: 11,
  description:
    "상품을 묶어 보여주는 진열입니다. 주소는 /shop/event/<slug> 이고, 메뉴의 '연결 대상 선택'에도 나옵니다. " +
    "기간을 지정하면 끝난 뒤 목록에서 빠지고, 직접 열면 '종료' 안내가 보입니다.",
  fields: [
    { name: "title", label: "제목", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true },
    { name: "state_label", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "description", label: "소개 문구", type: "textarea",
      help: "기획전 상단에 보입니다." },
    { name: "products_text", label: "상품", type: "textarea", required: true,
      help: "상품 주소(slug)를 한 줄에 하나씩, 진열 순서대로. 최대 200개." },
    { name: "product_count", label: "상품 수", type: "number", readOnly: true, inList: true },
    { name: "starts_at", label: "시작", type: "date", help: "비우면 즉시" },
    { name: "ends_at", label: "종료", type: "date", help: "비우면 상시" },
    { name: "is_visible", label: "노출", type: "boolean", inList: true },
    { name: "sort_order", label: "순서", type: "number" },
  ],
};
