/**
 * 등록된 결제 게이트웨이의 보관소.
 *
 * payments.ts 가 아니라 **따로** 둔 이유: 주문 생성(orders.ts)이 "이 결제수단이
 * 실제로 등록돼 있는가"를 물어야 하는데, payments.ts 는 orders.ts 를 부른다.
 * 같은 파일에 두면 순환 참조가 된다.
 *
 * 왜 물어야 하나: 예전에는 orders.ts 가 `["bank_transfer"]` 라는 배열로 검사했다.
 * 주석에는 "PG 연동은 별도 플러그인이 추가한다" 고 적혀 있었는데 **더하는 곳이
 * 없었다** — PG 플러그인을 깔고 키를 넣어도 카드로 주문하면
 * "지원하지 않는 결제수단입니다: toss" 로 거절됐다.
 */
import type { PaymentGateway } from "./payments.js";

/** 등록된 게이트웨이 (PG 플러그인이 registerGateway로 채운다) */
export const gateways = new Map<string, PaymentGateway>();

export function registerGateway(gateway: PaymentGateway): void {
  gateways.set(gateway.provider, gateway);
}

/** 주문에 실어도 되는 결제수단인가 — 등록된 게이트웨이만 받는다 */
export function isKnownPaymentMethod(provider: string): boolean {
  return gateways.has(provider);
}
