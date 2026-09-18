/**
 * 결제창으로 넘어가는 클라이언트 단계를 화면에 싣는 도우미.
 *
 * 주문서(checkout)와 주문 상세(orders) 두 화면이 같은 계약을 쓴다 —
 * `window.brickPay["<provider>"](order)` 로 넘기고, 돌아오면 주소의
 * `brickPay`·`orderNo` 를 보고 `/payments/confirm` 으로 마친다.
 * 계약은 payments.ts 의 `PaymentGateway.checkout` 에 적혀 있다.
 */
import { gateways } from "./gateway-registry.js";

/**
 * 준비된 게이트웨이가 낸 스크립트를 모은다.
 *
 * **준비된 것만** 싣는다. 키를 넣지 않은 PG 는 결제수단으로 나오지도 않으므로
 * 그 스크립트는 하는 일이 없고, 어떤 PG 플러그인을 깔아 두었는지만 알려 준다.
 */
export async function gatewayScripts(): Promise<string> {
  const parts = await Promise.all(
    [...gateways.values()].map(async (g) => {
      if (!g.checkout) return "";
      const ready = g.isReady ? await g.isReady().catch(() => false) : true;
      return ready ? g.checkout.script : "";
    }),
  );
  return parts.join("");
}
