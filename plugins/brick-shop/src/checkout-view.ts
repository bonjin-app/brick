import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";

/**
 * 주문서(체크아웃) 화면 — <상점 페이지>/checkout 으로 라우팅된다.
 *
 * 장바구니의 "주문하기"가 여기로 오는데 이 화면이 없었다 — **UI 로는
 * 주문을 완료할 수 없는 쇼핑몰**이었다 (주문 API 는 처음부터 있었다).
 *
 * 서버는 골격(폼)만 그린다. 카트 내용·합계는 클라이언트가 guestToken
 * (localStorage)과 함께 불러온다 — 비회원 카트는 서버 렌더가 알 수 없고,
 * 로그인 카트도 사용자별 내용이라 캐시에 실으면 안 된다 (ADR-30 과
 * 같은 패턴: 골격은 렌더, 사적 내용은 인증 API).
 *
 * 결제 수단은 무통장 입금이다 — 설치 직후 PG 계약 없이도 팔 수 있는
 * 기본 경로. 주문이 생기면 응답의 입금 계좌를 완료 화면에 보여준다.
 */
export function registerCheckoutView(ctx: PluginContext, t: (k: string, p?: Record<string, string | number>) => string) {
  const field = (label: string, inner: string) =>
    `<label class="brick-field">${escapeHtml(label)}${inner}</label>`;

  const checkoutBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "checkout",
    displayName: "주문서",
    render: async (_props, blockCtx) => {
      const path = String(blockCtx?.path ?? "").replace(/^\/+|\/+$/g, "");
      const tail = String(blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      const base = tail && path.endsWith(tail)
        ? `/${path.slice(0, path.length - tail.length).replace(/\/+$/g, "")}`
        : `/${path || "shop"}`;

      return `
<div class="brick-checkout" id="brick-checkout" data-shop-base="${escapeHtml(base)}">
  <section class="brick-co-summary">
    <h2>${escapeHtml(t("checkout.summary"))}</h2>
    <div id="brick-co-items"><p class="brick-shop-empty">${escapeHtml(t("checkout.loading"))}</p></div>
  </section>

  <form class="brick-co-form" id="brick-co-form" hidden>
    <h2>${escapeHtml(t("checkout.orderer"))}</h2>
    ${field(t("checkout.name"), '<input name="ordererName" required maxlength="50" autocomplete="name" />')}
    ${field(t("checkout.phone"), '<input name="ordererPhone" required maxlength="20" autocomplete="tel" placeholder="010-0000-0000" />')}
    ${field(t("checkout.email"), '<input name="ordererEmail" type="email" maxlength="255" autocomplete="email" />')}

    <h2>${escapeHtml(t("checkout.shippingTo"))}</h2>
    <div class="brick-co-addr">
      ${field(t("checkout.postcode"), '<input name="postcode" required maxlength="10" autocomplete="postal-code" />')}
      ${field(t("checkout.address1"), '<input name="address1" required maxlength="200" autocomplete="street-address" />')}
    </div>
    ${field(t("checkout.address2"), '<input name="address2" maxlength="200" />')}
    ${field(t("checkout.memo"), '<input name="deliveryMemo" maxlength="200" />')}
    ${field(t("checkout.coupon"), '<input name="couponCode" maxlength="40" autocomplete="off" />')}

    <h2>${escapeHtml(t("checkout.payment"))}</h2>
    <p class="brick-co-pay">
      <strong>${escapeHtml(t("checkout.bank"))}</strong><br />
      <small>${escapeHtml(t("checkout.bankHint"))}</small>
    </p>

    <button type="submit" class="brick-primary brick-co-submit">${escapeHtml(t("checkout.submit"))}</button>
    <p class="brick-buy-msg" role="status"></p>
  </form>

  <section class="brick-co-done" id="brick-co-done" hidden>
    <h2>${escapeHtml(t("checkout.doneTitle"))}</h2>
    <dl>
      <dt>${escapeHtml(t("checkout.orderNo"))}</dt><dd id="brick-co-no"></dd>
      <dt>${escapeHtml(t("checkout.total"))}</dt><dd id="brick-co-total"></dd>
      <dt id="brick-co-bank-label" hidden>${escapeHtml(t("checkout.bankAccount"))}</dt><dd id="brick-co-bank" hidden></dd>
    </dl>
    <p class="brick-co-guest" id="brick-co-guest" hidden>${escapeHtml(t("checkout.guestHint"))}</p>
    <p><a class="brick-primary brick-co-back" href="${escapeHtml(base)}">${escapeHtml(t("checkout.goShop"))}</a></p>
  </section>
</div>
${checkoutScript(t)}
<style>
.brick-checkout { max-width: 640px; }
.brick-checkout h2 { font-size: 17px; margin: 26px 0 10px; }
.brick-co-summary table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.brick-co-summary td { padding: 8px 4px; border-bottom: 1px solid var(--color-line, #e7e7ec); }
.brick-co-summary td:last-child { text-align: right; white-space: nowrap; }
.brick-co-totals { margin: 10px 0 0; font-size: 14.5px; }
.brick-co-totals div { display: flex; justify-content: space-between; padding: 3px 0; }
.brick-co-totals .brick-grand { font-weight: 700; font-size: 16px; border-top: 1px solid var(--color-line, #e7e7ec); padding-top: 8px; margin-top: 6px; }
.brick-co-form .brick-field { display: block; margin-top: 12px; font-size: 13.5px; color: #4b4b55; }
.brick-co-form .brick-field input { display: block; width: 100%; margin-top: 5px; }
.brick-co-addr { display: grid; grid-template-columns: 130px 1fr; gap: 10px; }
.brick-co-pay { background: var(--color-bg-soft, #f7f7f9); border: 1px solid var(--color-line, #e7e7ec); border-radius: 10px; padding: 12px 14px; }
.brick-co-submit { width: 100%; padding: 14px; margin-top: 18px; font-size: 15px; }
.brick-co-done dl { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; }
.brick-co-done dt { color: var(--color-muted, #71717d); }
.brick-co-done dd { margin: 0; font-weight: 600; }
.brick-co-back { display: inline-block; padding: 10px 18px; border-radius: 8px; text-decoration: none; }
@media (max-width: 560px) { .brick-co-addr { grid-template-columns: 1fr; } }
</style>`;
    },
  };
  ctx.registerBlock(checkoutBlock);
  return checkoutBlock;
}

/** 주문서 클라이언트 — 카트 로드·합계·주문 제출·완료 표시 */
const checkoutScript = (t: (k: string) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-checkout');
  if (!root) return;
  var guest = localStorage.getItem('brick_shop_guest');
  var qs = guest ? ('?guest=' + encodeURIComponent(guest)) : '';
  var itemsBox = document.getElementById('brick-co-items');
  var form = document.getElementById('brick-co-form');
  var msg = form.querySelector('.brick-buy-msg');
  function fmt(n){ return Number(n).toLocaleString('ko-KR') + '원'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  fetch('/api/plugins/brick-shop/cart' + qs)
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.items || !d.items.length) {
        itemsBox.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("checkout.emptyCart"))} +
          ' <a href="' + root.dataset.shopBase + '">' + ${JSON.stringify(t("checkout.goShop"))} + '</a></p>';
        return;
      }
      var rows = d.items.map(function(it){
        return '<tr><td>' + esc(it.productName) + (it.optionName ? ' — ' + esc(it.optionName) : '') +
               ' × ' + it.quantity + '</td><td>' + fmt(it.lineTotal) + '</td></tr>';
      }).join('');
      itemsBox.innerHTML = '<table><tbody>' + rows + '</tbody></table>' +
        '<div class="brick-co-totals">' +
        '<div><span>' + ${JSON.stringify(t("checkout.subtotal"))} + '</span><span>' + fmt(d.subtotal) + '</span></div>' +
        (d.discount ? '<div><span>' + ${JSON.stringify(t("checkout.discount"))} + '</span><span>-' + fmt(d.discount) + '</span></div>' : '') +
        '<div><span>' + ${JSON.stringify(t("checkout.shippingFee"))} + '</span><span>' + (d.shippingFee ? fmt(d.shippingFee) : ${JSON.stringify(t("checkout.free"))}) + '</span></div>' +
        '<div class="brick-grand"><span>' + ${JSON.stringify(t("checkout.total"))} + '</span><span>' + fmt(d.total) + '</span></div>' +
        '</div>';
      form.hidden = false;
    })
    .catch(function(){ itemsBox.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("checkout.fail"))} + '</p>'; });

  // 재시도(더블클릭·네트워크 재전송)로 같은 주문이 두 번 생기지 않게 키를 고정한다
  var idem = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var btn = form.querySelector('.brick-co-submit');
    btn.disabled = true;
    msg.textContent = ${JSON.stringify(t("checkout.submitting"))};
    var f = new FormData(form);
    var orderer = {};
    ['ordererName','ordererPhone','ordererEmail','postcode','address1','address2','deliveryMemo'].forEach(function(k){
      var v = String(f.get(k) || '').trim();
      if (v) orderer[k] = v;
    });
    var body = { orderer: orderer, idempotencyKey: idem };
    var coupon = String(f.get('couponCode') || '').trim();
    if (coupon) body.couponCode = coupon;
    if (guest) body.guestToken = guest;

    fetch('/api/plugins/brick-shop/orders', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
    }).then(function(r){ return r.json().then(function(d){ return {ok: r.ok, d: d}; }); })
      .then(function(res){
        if (!res.ok) {
          msg.textContent = res.d.message || ${JSON.stringify(t("checkout.fail"))};
          btn.disabled = false;
          return;
        }
        var d = res.d;
        form.hidden = true;
        document.querySelector('.brick-co-summary').hidden = true;
        document.getElementById('brick-co-no').textContent = d.orderNo;
        document.getElementById('brick-co-total').textContent = fmt(d.total);
        if (d.bankAccount) {
          document.getElementById('brick-co-bank-label').hidden = false;
          var bank = document.getElementById('brick-co-bank');
          bank.hidden = false;
          bank.textContent = d.bankAccount;
        }
        if (guest) document.getElementById('brick-co-guest').hidden = false;
        document.getElementById('brick-co-done').hidden = false;
        window.scrollTo(0, 0);
      })
      .catch(function(){
        msg.textContent = ${JSON.stringify(t("checkout.fail"))};
        btn.disabled = false;
      });
  });
})();
</script>`;
