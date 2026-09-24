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
export async function gatewayScripts(opts: { billing?: boolean } = {}): Promise<string> {
  const parts = await Promise.all(
    [...gateways.values()].map(async (g) => {
      if (!g.checkout) return "";
      /*
       * 카드 등록 화면은 **정기결제 준비**로 판정한다 — 일반 결제는 다른 PG 로 받고 정기결제만 이 PG 로
       * 하는 사이트에서, 결제 준비로 판정하면 정기결제 수단 목록(listBillingProviders)에는 뜨는데
       * 카드 등록 창을 여는 스크립트가 없어 눌러도 아무 일이 없었다.
       */
      if (opts.billing && !(g.issueBillingKey && g.chargeBillingKey)) return "";
      const check = opts.billing ? (g.isBillingReady ?? g.isReady) : g.isReady;
      const ready = check ? await check.call(g).catch(() => false) : true;
      return ready ? g.checkout.script : "";
    }),
  );
  return parts.join("");
}
