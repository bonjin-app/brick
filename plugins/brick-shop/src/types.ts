/** brick-shop 공통 타입 */

import type { PluginDb } from "@brick/plugin-sdk";

/**
 * 재고·금액을 다루므로 반드시 트랜잭션을 지원하는 핸들을 쓴다.
 * (커넥션 풀에서 execute("BEGIN")은 트랜잭션을 보장하지 못한다)
 */
export type Db = PluginDb;

/** 플러그인 라우트에서 HTTP 상태코드를 지정해 던지는 에러 */
export class ShopError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const ORDER_STATUS = [
  "pending",    // 입금/결제 대기
  "paid",       // 결제 완료
  "preparing",  // 상품 준비중
  "shipped",    // 배송중
  "delivered",  // 배송 완료
  "cancelled",  // 취소
  "refunded",   // 환불
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/**
 * 주문 상태 전이 규칙.
 * 임의 전이를 허용하면 "배송완료 → 입금대기" 같은 데이터 오염이 생긴다.
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["preparing", "cancelled", "refunded"],
  preparing: ["shipped", "cancelled", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

/** 재고를 되돌려야 하는 상태 (취소/환불) */
export const STOCK_RESTORING: OrderStatus[] = ["cancelled", "refunded"];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "입금대기",
  paid: "결제완료",
  preparing: "상품준비중",
  shipped: "배송중",
  delivered: "배송완료",
  cancelled: "취소",
  refunded: "환불",
};

export const PRODUCT_STATUS_LABEL: Record<string, string> = {
  draft: "작성중",
  selling: "판매중",
  soldout: "품절",
  hidden: "숨김",
};

/** 쇼핑몰 설정 (관리자 → 설정에서 변경, ctx.settings에 저장) */
export interface ShopSettings {
  /** 기본 배송비 (원) */
  shippingFee: number;
  /** 이 금액 이상이면 무료배송. 0이면 무료배송 없음 */
  freeShippingOver: number;
  /** 무통장입금 안내 계좌 */
  bankAccount: string;
  /** 상품 목록 페이지당 개수 */
  pageSize: number;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  shippingFee: 3000,
  freeShippingOver: 50000,
  bankAccount: "",
  pageSize: 20,
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function won(amount: number): string {
  return `${Number(amount).toLocaleString("ko-KR")}원`;
}
