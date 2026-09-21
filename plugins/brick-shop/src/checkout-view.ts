import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { moneyFnScript } from "./i18n.js";
import { gatewayScripts } from "./pay-client.js";
import { addressSearchField, addressSearchScript, ADDRESS_SEARCH_CSS } from "./address-search.js";
import type { ShopSettings } from "./types.js";

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
export function registerCheckoutView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
  settings: () => Promise<ShopSettings>,
) {
  const field = (label: string, inner: string) =>
    `<label class="brick-field">${escapeHtml(label)}${inner}</label>`;

  const checkoutBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "checkout",
    displayName: "주문서",
    render: async (_props, blockCtx) => {
      // 주소 검색은 운영자가 끌 수 있다 (제3자 스크립트를 두지 않으려는 가게)
      const addrSearch = (await settings()).addressSearch !== false;
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
    ${field(t("checkout.name"), '<input type="text" name="ordererName" autocomplete="name" required maxlength="50" />')}
    ${field(t("checkout.phone"), '<input type="tel" name="ordererPhone" autocomplete="tel" inputmode="tel" required maxlength="20" placeholder="010-0000-0000" />')}
    ${field(t("checkout.email"), '<input name="ordererEmail" type="email" maxlength="255" autocomplete="email" />')}

    <h2>${escapeHtml(t("checkout.shippingTo"))}</h2>
    <div class="brick-co-addr">
      ${field(t("checkout.postcode"), '<input type="text" name="postcode" autocomplete="postal-code" inputmode="numeric" required maxlength="10" />')}
      ${addrSearch ? addressSearchField() : ""}
      ${field(t("checkout.address1"), '<input type="text" name="address1" autocomplete="street-address" required maxlength="200" />')}
    </div>
    ${field(t("checkout.address2"), '<input type="text" name="address2" autocomplete="address-line2" maxlength="200" />')}
    ${field(t("checkout.memo"), '<input name="deliveryMemo" maxlength="200" />')}
    ${field(t("checkout.coupon"), '<input type="text" name="couponCode" maxlength="40" autocomplete="off" />')}
    ${/*
       포인트 사용 — 쓸 수 있을 때만 보인다(로그인·플러그인 활성·잔액 > 0).
       서버는 처음부터 받을 수 있었는데 화면이 없어서 회원이 한 점도 못 썼다.
     */ ""}
    <label class="brick-field" id="brick-co-points-row" hidden>${escapeHtml(t("checkout.points"))}
      <span class="brick-co-points">
        <input type="number" name="pointUsed" min="0" step="1" value="0" inputmode="numeric" />
        <button type="button" id="brick-co-points-all">${escapeHtml(t("checkout.pointsUseAll"))}</button>
      </span>
      <small id="brick-co-points-hint"></small>
    </label>

    <h2>${escapeHtml(t("checkout.payment"))}</h2>
    ${/*
       결제수단은 **서버가 등록된 게이트웨이로 정한다.** 예전에는 이 자리에
       "무통장입금" 이 글자로 박혀 있었다 — PG 플러그인을 깔고 키를 넣어도
       손님은 카드를 고를 수 없었고, /payment-methods 는 아무도 부르지 않는
       라우트로 남아 있었다.
     */ ""}
    <fieldset class="brick-co-pay" id="brick-co-methods">
      <legend class="brick-co-pay-legend">${escapeHtml(t("checkout.payment"))}</legend>
      <p class="brick-co-pay-loading">${escapeHtml(t("checkout.loading"))}</p>
    </fieldset>

    <button type="submit" class="brick-primary brick-co-submit">${escapeHtml(t("checkout.submit"))}</button>
    ${/*
       진행 안내와 오류가 같은 자리를 쓴다. 오류는 즉시 읽혀야 하므로 alert 다 —
       status(polite)는 스크린리더가 하던 말을 끝낸 뒤에야 읽는다.
     */ ""}
    <p class="brick-buy-msg" role="alert"></p>
  </form>

  <section class="brick-co-done" id="brick-co-done" hidden>
    <h2>${escapeHtml(t("checkout.doneTitle"))}</h2>
    <dl>
      <dt>${escapeHtml(t("checkout.orderNo"))}</dt><dd id="brick-co-no"></dd>
      <dt>${escapeHtml(t("checkout.total"))}</dt><dd id="brick-co-total"></dd>
      <dt id="brick-co-bank-label" hidden>${escapeHtml(t("checkout.bankAccount"))}</dt><dd id="brick-co-bank" hidden></dd>
    </dl>
    <p class="brick-co-guest" id="brick-co-guest" hidden>${escapeHtml(t("checkout.guestHint"))}</p>
    <p>
      <a class="brick-primary brick-co-back" id="brick-co-view" href="${escapeHtml(base)}/orders">${escapeHtml(t("orders.viewOrder"))}</a>
      <a class="brick-co-back" href="${escapeHtml(base)}">${escapeHtml(t("checkout.goShop"))}</a>
    </p>
  </section>
</div>
${await gatewayScripts()}${checkoutScript(t)}${addrSearch ? addressSearchScript() + ADDRESS_SEARCH_CSS : ""}
<style>
.brick-checkout { max-width: 640px; }
.brick-checkout h2 { font-size: 17px; margin: 26px 0 10px; }
.brick-co-summary table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.brick-co-summary td { padding: 8px 4px; border-bottom: 1px solid var(--color-line, #e7e7ec); }
.brick-co-summary td:last-child { text-align: right; white-space: nowrap; }
.brick-co-totals { margin: 10px 0 0; font-size: 14.5px; }
.brick-co-totals div { display: flex; justify-content: space-between; padding: 3px 0; }
.brick-co-totals .brick-grand { font-weight: 700; font-size: 16px; border-top: 1px solid var(--color-line, #e7e7ec); padding-top: 8px; margin-top: 6px; }
.brick-co-form .brick-field { display: block; margin-top: 12px; font-size: 13.5px; color: var(--color-text-soft, #45454f); }
.brick-co-form .brick-field input { display: block; width: 100%; margin-top: 5px; }
/* 문제가 있는 칸은 눈으로도 보여야 한다 — aria-invalid 만으로는 스크린리더에만 전해진다 */
.brick-co-form [aria-invalid="true"] { border-color: var(--color-danger, #c8322f); outline: 2px solid var(--color-danger, #c8322f); outline-offset: 1px; }
.brick-co-form .brick-buy-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-co-addr { display: grid; grid-template-columns: 130px 1fr; gap: 10px; }
.brick-co-pay { background: var(--color-bg-soft, #f7f7f9); border: 1px solid var(--color-line, #e7e7ec); border-radius:var(--radius-lg, 10px); padding: 12px 14px; margin: 0; }
/* 제목(h2)이 바로 위에 있으므로 legend 는 스크린리더에만 남긴다 */
.brick-co-pay-legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* 44px — 폰에서 누르는 자리다 */
.brick-co-pay-opt { display: flex; align-items: center; gap: 9px; min-height: 44px; cursor: pointer; font-size: 14.5px; }
.brick-co-pay-opt + .brick-co-pay-opt { border-top: 1px solid var(--color-line, #e7e7ec); }
.brick-co-pay-one { margin: 0; font-size: 14.5px; }
.brick-co-pay-hint, .brick-co-pay-hints { display: block; margin-top: 4px; color: var(--color-text-soft, #45454f); font-size: 12.5px; }
.brick-co-pay-loading { margin: 0; color: var(--color-muted, #6c6c7a); font-size: 13px; }
.brick-co-return { font-size: 15px; margin: 0 0 10px; }
.brick-co-return.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-co-points { display: flex; gap: 8px; align-items: center; }
.brick-co-points input { flex: 1; }
#brick-co-points-hint { display: block; margin-top: 4px; font-size: 12.5px; color: var(--color-muted, #71717d); }
.brick-co-submit { width: 100%; padding: 14px; margin-top: 18px; font-size: 15px; }
.brick-co-done dl { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; }
.brick-co-done dt { color: var(--color-muted, #71717d); }
.brick-co-done dd { margin: 0; font-weight: 600; }
.brick-co-back { display: inline-block; padding: 10px 18px; border-radius:var(--radius, 8px); text-decoration: none; }
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
  ${moneyFnScript("fmt")}
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  /**
   * 합계 — 장바구니 응답과 견적 응답이 같은 모양이라 한 함수가 둘 다 그린다.
   *
   * 지역 추가 배송비는 **우편번호를 받은 뒤에만** 알 수 있으므로 처음에는 없고,
   * 주소를 입력하면 나타난다. 줄로 보여줘야 한다 — 총액만 조용히 늘면 손님은
   * 무엇이 붙었는지 모른 채 주문하거나 그 자리에서 이탈한다.
   */
  function totalsHtml(d){
    return '<div class="brick-co-totals">' +
      '<div><span>' + ${JSON.stringify(t("checkout.subtotal"))} + '</span><span>' + fmt(d.subtotal) + '</span></div>' +
      (d.discount ? '<div><span>' + ${JSON.stringify(t("checkout.discount"))} + '</span><span>-' + fmt(d.discount) + '</span></div>' : '') +
      '<div><span>' + ${JSON.stringify(t("checkout.shippingFee"))} + '</span><span>' +
        (d.shippingFee ? fmt(d.shippingFee) : ${JSON.stringify(t("checkout.free"))}) + '</span></div>' +
      (d.zoneFee ? '<div><span>' + ${JSON.stringify(t("checkout.zoneFee"))} +
        (d.zoneName ? ' (' + esc(d.zoneName) + ')' : '') + '</span><span>' + fmt(d.zoneFee) + '</span></div>' : '') +
      '<div class="brick-grand"><span>' + ${JSON.stringify(t("checkout.total"))} + '</span><span>' + fmt(d.total) + '</span></div>' +
      '</div>';
  }

  /* PG 에서 돌아온 길이면 장바구니를 다시 그리지 않는다 — 함수 선언은 호이스팅된다 */
  var returning = finishReturn();

  if (!returning) fetch('/api/plugins/brick-shop/cart' + qs)
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
      itemsBox.innerHTML = '<table><tbody>' + rows + '</tbody></table>' + totalsHtml(d);
      form.hidden = false;
      setupPoints(d);
    })
    .catch(function(){ itemsBox.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("checkout.fail"))} + '</p>'; });

  /*
   * 결제수단 — 서버가 "지금 쓸 수 있는" 것만 준다(키를 넣지 않은 PG 는 빠진다).
   * 하나뿐이면 고르게 하지 않고 그것만 알려 준다 — 선택지가 하나인 라디오는
   * 누를 것이 없는데 자리만 차지한다.
   */
  var methodsBox = document.getElementById('brick-co-methods');
  var methods = [];
  var chosen = 'bank_transfer';

  /*
   * PG 에서 돌아왔다 — 승인을 마친다.
   *
   * 주소의 brickPay 가 어느 수단이었는지 알려 준다. PG 마다 돌려주는 칸 이름이
   * 다르므로(토스는 paymentKey), 번역은 그 플러그인의 readReturn 이 한다.
   * 우리는 주문번호와 거래 키만 들고 /payments/confirm 으로 간다 — 금액 검증은
   * 서버가 PG 에 직접 물어서 한다(화면이 보낸 금액은 신뢰하지 않는다).
   */
  function finishReturn(){
    var q = new URLSearchParams(location.search);
    var provider = q.get('brickPay');
    var orderNo = q.get('orderNo');
    if (!provider || !orderNo) return false;
    var pay = (window.brickPay || {})[provider];
    var got = pay && typeof pay.readReturn === 'function' ? pay.readReturn(q) : null;
    form.hidden = true;
    var summary = document.querySelector('.brick-co-summary');
    if (summary) summary.hidden = false;
    /*
     * 안내는 **주문 요약 자리**에 쓴다. 폼 안의 msg 를 쓰면 안 된다 —
     * 돌아온 길에서는 장바구니를 다시 그리지 않으므로 폼이 비어 있고,
     * 거기에 글자만 띄우면 손님은 빈 주문서를 마주한다.
     * 주문은 이미 만들어져 있으므로 그 주문으로 가는 길을 함께 준다.
     */
    function notice(text, isError){
      itemsBox.innerHTML = '<p class="brick-co-return' + (isError ? ' is-error' : '') + '">' + esc(text) + '</p>' +
        '<p><a class="brick-co-back" href="' + root.dataset.shopBase + '/orders/' + encodeURIComponent(orderNo) + '">' +
        ${JSON.stringify(t("orders.viewOrder"))} + '</a></p>';
    }
    if (!got) {
      // 손님이 PG 화면에서 취소했거나 실패했다 — 주문은 결제대기로 남는다
      notice(${JSON.stringify(t("checkout.payCancelled"))}, true);
      return true;
    }
    notice(${JSON.stringify(t("checkout.payConfirming"))}, false);
    fetch('/api/plugins/brick-shop/payments/confirm', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ orderNo: orderNo, provider: provider, providerTid: got.providerTid, amount: got.amount })
    }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
      .then(function(res){
        if (!res.ok) {
          notice(res.d.message || ${JSON.stringify(t("checkout.payFail"))}, true);
          return;
        }
        if (summary) summary.hidden = true;   // 완료 화면이 떴으면 진행 안내는 치운다
        document.getElementById('brick-co-no').textContent = orderNo;
        if (res.d.amount != null) document.getElementById('brick-co-total').textContent = fmt(res.d.amount);
        var view = document.getElementById('brick-co-view');
        if (view) view.href = root.dataset.shopBase + '/orders/' + encodeURIComponent(orderNo);
        document.getElementById('brick-co-done').hidden = false;
        window.scrollTo(0, 0);
      })
      .catch(function(){ notice(${JSON.stringify(t("checkout.payFail"))}, true); });
    return true;
  }

  function drawMethods(list, bankAccount){
    methods = list;
    if (!list.length) { methodsBox.hidden = true; return; }
    chosen = list[0].provider;
    var hint = function(p){
      return p === 'bank_transfer'
        ? '<small class="brick-co-pay-hint">' + ${JSON.stringify(t("checkout.bankHint"))} + '</small>'
        : '';
    };
    if (list.length === 1) {
      methodsBox.innerHTML = '<p class="brick-co-pay-one"><strong>' + esc(list[0].displayName) + '</strong></p>' + hint(list[0].provider);
      return;
    }
    methodsBox.innerHTML = list.map(function(m, i){
      return '<label class="brick-co-pay-opt">' +
        '<input type="radio" name="paymentMethod" value="' + esc(m.provider) + '"' + (i === 0 ? ' checked' : '') + ' /> ' +
        '<span>' + esc(m.displayName) + '</span></label>';
    }).join('') + '<div class="brick-co-pay-hints"></div>';
    var hints = methodsBox.querySelector('.brick-co-pay-hints');
    var sync = function(){
      var el = methodsBox.querySelector('input[name=paymentMethod]:checked');
      chosen = el ? el.value : list[0].provider;
      hints.innerHTML = hint(chosen);
    };
    methodsBox.addEventListener('change', sync);
    sync();
  }

  fetch('/api/plugins/brick-shop/payment-methods')
    .then(function(r){ return r.json(); })
    .then(function(d){ drawMethods(d.methods || [], d.bankAccount); })
    .catch(function(){
      // 목록을 못 받으면 기본 경로(무통장입금)로 둔다 — 주문 자체는 막지 않는다
      methodsBox.innerHTML = '<p class="brick-co-pay-one"><strong>' + ${JSON.stringify(t("checkout.bank"))} + '</strong></p>' +
        '<small class="brick-co-pay-hint">' + ${JSON.stringify(t("checkout.bankHint"))} + '</small>';
    });

  /*
   * 포인트 칸을 켜고, 값이 바뀌면 합계를 다시 받는다.
   *
   * 합계를 화면에서 빼서 계산하지 않는다 — 상한(배송비는 포인트로 못 낸다),
   * 등급 할인, 쿠폰이 서로 얽혀 있어서 같은 규칙을 두 곳에 두면 갈라진다.
   * 서버의 견적을 그대로 쓴다.
   */
  /*
   * 합계를 다시 받는 일은 **포인트와 무관하게** 필요하다.
   *
   * 예전에는 requote 가 포인트 설정 안에 있어서, 포인트 플러그인이 꺼진 사이트에서는
   * 아예 다시 계산하지 않았다 — 우편번호를 넣어도 지역 추가 배송비가 화면에
   * 나타나지 않는다.
   */
  var cartData = null;
  var maxUsable = 0;
  var requoteTimer = null;

  function requote(){
    if (!cartData) return;
    var pointInput = form.querySelector('input[name=pointUsed]');
    var want = 0;
    if (pointInput) {
      want = Math.max(0, Math.min(maxUsable, Math.floor(Number(pointInput.value) || 0)));
      pointInput.value = String(want);
    }
    var f = new FormData(form);
    var coupon = String(f.get('couponCode') || '').trim();
    fetch('/api/plugins/brick-shop/quote', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({
        items: cartData.items.map(function(it){ return { productId: it.productId, optionId: it.optionId || null, quantity: it.quantity }; }),
        couponCode: coupon || null,
        pointUsed: want,
        /*
         * 우편번호를 보낸다.
         *
         * 안 보내면 견적에 **지역 추가 배송비가 빠진다.** 서버는 주문할 때 우편번호로
         * 그 돈을 붙이므로, 제주·도서산간 손님은 화면에서 본 금액과 다른 금액으로
         * 주문된다 — 화면 25,000원, 실제 28,000원.
         */
        postcode: String(f.get('postcode') || '').trim() || null,
      }),
    }).then(function(r){ return r.ok ? r.json() : null; }).then(function(q){
      if (!q) return;
      /*
       * 합계 전체를 다시 그린다.
       *
       * 예전에는 총액 숫자 하나만 바꿔치웠는데, 그러면 **왜 늘었는지가 안 보인다.**
       */
      var box = document.querySelector('.brick-co-totals');
      if (box) box.outerHTML = totalsHtml(q);
    }).catch(function(){ /* 합계는 서버가 주문 시 다시 계산한다 */ });
  }
  function requoteSoon(){ clearTimeout(requoteTimer); requoteTimer = setTimeout(requote, 300); }

  /** 금액이 달라지는 입력들 — 전부 합계를 다시 받는다 */
  function bindRequote(){
    ['postcode', 'couponCode'].forEach(function(name){
      var el = form.querySelector('[name=' + name + ']');
      if (el) el.addEventListener('input', requoteSoon);
    });
  }

  function setupPoints(cart){
    cartData = cart;
    bindRequote();
    var row = document.getElementById('brick-co-points-row');
    if (!row || !cart.pointsAvailable || !(cart.pointBalance > 0)) return;
    var input = row.querySelector('input[name=pointUsed]');
    var hint = document.getElementById('brick-co-points-hint');
    maxUsable = Math.min(cart.pointBalance, Math.max(0, cart.total - (cart.shippingFee || 0)));
    input.max = String(maxUsable);
    // 포인트는 돈이 아니다 — 금액 포맷(fmt)을 쓰면 "3,000원점" 이 된다
    var num = function(n){ return String(Math.floor(Number(n) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); };
    hint.textContent = ${JSON.stringify(t("checkout.pointsHint"))}
      .replace('{balance}', num(cart.pointBalance)).replace('{max}', num(maxUsable));
    row.hidden = false;

    input.addEventListener('input', requoteSoon);
    document.getElementById('brick-co-points-all').addEventListener('click', function(){
      input.value = String(maxUsable);
      requote();
    });
  }

  // 재시도(더블클릭·네트워크 재전송)로 같은 주문이 두 번 생기지 않게 키를 고정한다
  var idem = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var btn = form.querySelector('.brick-co-submit');
    btn.disabled = true;
    msg.classList.remove('is-error');
    msg.textContent = ${JSON.stringify(t("checkout.submitting"))};
    var f = new FormData(form);
    var orderer = {};
    ['ordererName','ordererPhone','ordererEmail','postcode','address1','address2','deliveryMemo'].forEach(function(k){
      var v = String(f.get(k) || '').trim();
      if (v) orderer[k] = v;
    });
    orderer.paymentMethod = chosen;
    var body = { orderer: orderer, idempotencyKey: idem };
    var coupon = String(f.get('couponCode') || '').trim();
    if (coupon) body.couponCode = coupon;
    var usedPoint = Math.max(0, Math.floor(Number(f.get('pointUsed') || 0)));
    if (usedPoint > 0) body.pointUsed = usedPoint;
    if (guest) body.guestToken = guest;

    fetch('/api/plugins/brick-shop/orders', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
    }).then(function(r){ return r.json().then(function(d){ return {ok: r.ok, d: d}; }); })
      .then(function(res){
        if (!res.ok) {
          /*
           * 어느 칸이 문제인지 데려간다.
           *
           * 메시지만 띄우면 손님은 여덟 칸 중 어디를 고쳐야 하는지 위로 올라가 찾아야 하고,
           * 그 지점이 결제 직전이다 — 여기서 그만두면 판매가 끝난다. 서버가 field 를 주면
           * 그 칸에 표시를 걸고 포커스를 옮긴다(스크린리더도 그 칸의 라벨을 읽는다).
           */
          form.querySelectorAll('[aria-invalid="true"]').forEach(function(el){ el.removeAttribute('aria-invalid'); });
          msg.classList.add('is-error');
          msg.textContent = res.d.message || ${JSON.stringify(t("checkout.fail"))};
          var bad = res.d.field ? form.querySelector('[name="' + String(res.d.field).replace(/[^A-Za-z0-9_]/g, '') + '"]') : null;
          if (bad) {
            bad.setAttribute('aria-invalid', 'true');
            bad.focus();
            bad.scrollIntoView({ block: 'center' });
          } else {
            // 어느 칸인지 모르면 적어도 메시지는 보이게 한다
            msg.scrollIntoView({ block: 'center' });
          }
          btn.disabled = false;
          return;
        }
        var d = res.d;
        /*
         * 그 자리에서 승인이 나야 하는 수단이면 PG 로 넘긴다.
         *
         * 주문은 이미 만들어졌다(결제대기). 승인은 PG 화면에서 끝나고,
         * 돌아오면 이 화면이 조회 문자열을 보고 /payments/confirm 으로 마친다.
         * 넘기는 함수가 없으면 **주문서가 그 수단을 내놓지 않았어야 한다** —
         * 여기까지 왔다면 설치가 어긋난 것이므로 조용히 완료 화면을 띄우지
         * 않고 그대로 말한다(손님이 결제했다고 믿는 것이 가장 나쁘다).
         */
        var picked = methods.filter(function(m){ return m.provider === chosen; })[0];
        if (picked && picked.online) {
          var pay = (window.brickPay || {})[chosen];
          if (typeof pay !== 'function') {
            msg.classList.add('is-error');
            msg.textContent = ${JSON.stringify(t("checkout.payUnavailable"))};
            msg.scrollIntoView({ block: 'center' });
            btn.disabled = false;
            return;
          }
          msg.textContent = ${JSON.stringify(t("checkout.payRedirect"))};
          var back = location.origin + location.pathname + '?brickPay=' + encodeURIComponent(chosen) + '&orderNo=' + encodeURIComponent(d.orderNo);
          Promise.resolve(pay({ orderNo: d.orderNo, amount: d.total, orderName: d.orderName || d.orderNo, returnUrl: back }))
            .catch(function(){
              msg.classList.add('is-error');
              msg.textContent = ${JSON.stringify(t("checkout.payFail"))};
              btn.disabled = false;
            });
          return;
        }
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
        var view = document.getElementById('brick-co-view');
        if (view) view.href = root.dataset.shopBase + '/orders/' + encodeURIComponent(d.orderNo);
        document.getElementById('brick-co-done').hidden = false;
        window.scrollTo(0, 0);
      })
      .catch(function(){
        msg.classList.add('is-error');
        msg.textContent = ${JSON.stringify(t("checkout.fail"))};
        msg.scrollIntoView({ block: 'center' });
        btn.disabled = false;
      });
  });
})();
</script>`;
