import type { AdminResource } from "@brick/plugin-sdk";
import { ORDER_STATUS, STATUS_LABEL, PRODUCT_STATUS_LABEL } from "./types.js";

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
    { name: "summary", label: "짧은 설명", type: "textarea", help: "목록과 검색 결과에 노출됩니다." },
    { name: "description", label: "상세 설명", type: "richtext", help: "HTML을 사용할 수 있습니다." },
    { name: "free_shipping", label: "무료배송", type: "boolean" },
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
    { name: "usage_limit", label: "사용 한도", type: "number", help: "비우면 무제한." },
    { name: "used_count", label: "사용됨", type: "number", readOnly: true, inList: true },
    { name: "is_active", label: "활성", type: "boolean", inList: true },
  ],
};
