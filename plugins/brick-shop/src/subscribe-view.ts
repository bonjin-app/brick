import { sql } from "drizzle-orm";
import type { BlockRenderContext, PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { won, type Db } from "./types.js";
import { moneyFnScript } from "./i18n.js";

/**
 * 정기배송 신청 화면 — /shop/subscribe/<상품 slug>.
 *
 * 마지막으로 닿지 않던 칸이었다. 서버에는 가입(`POST /subscriptions`)이 있고,
 * 카드 등록 화면도 내 정기배송(해지·재개) 화면도 만들었는데 **가입 화면이
 * 없었다** — 관리자가 상품에 정기배송 주기를 설정해도 손님은 그것을 볼 수도,
 * 신청할 수도 없었다. 상품 상세에 주기가 표시조차 되지 않았다.
 *
 * 금액은 `POST /subscriptions/quote` 가 낸다 — 장바구니 견적이 아니라
 * **가입이 실제로 계산하는 방식 그대로**다(등급 할인·쿠폰 없이). 정기결제에서
 * 보여 준 금액과 빠져나가는 금액이 다르면 그것으로 신뢰가 끝난다.
 */
export function registerSubscribeView(
  ctx: PluginContext,
  db: Db,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const field = (label: string, inner: string) =>
    `<label class="brick-field">${escapeHtml(label)}${inner}</label>`;

  const subscribeBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "subscription-signup",
    displayName: "정기배송 신청",
    propsSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          title: "상품 slug",
          description: "비우면 주소의 마지막 경로를 상품 slug로 사용합니다 (/shop/subscribe/<slug>)",
        },
      },
    },
    render: async (props, blockCtx?: BlockRenderContext) => {
      const slug = String(props.slug ?? blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      const back = `<p class="brick-subf-back"><a href="/shop">${escapeHtml(t("checkout.goShop"))}</a></p>`;
      if (!slug) return `<div class="brick-shop-empty">${escapeHtml(t("detail.pickProduct"))}</div>${back}`;

      const { rows } = await db.execute(sql`
        SELECT slug, name, image_url, price, stock, status, sub_interval, free_shipping
        FROM shop_products WHERE slug = ${slug} LIMIT 1
      `);
      const p = rows[0];
      /*
       * 정기배송 상품이 아니면 **폼을 그리지 않는다.** 서버가 어차피 거절하는
       * 신청서를 채우게 두는 것은 손님의 시간을 버리는 일이다.
       */
      if (!p || p.status === "hidden" || p.status === "draft") {
        return `<div class="brick-shop-empty">${escapeHtml(t("detail.notFound"))}</div>${back}`;
      }
      const toProduct = `<p class="brick-subf-back"><a href="/shop/${encodeURIComponent(String(p.slug))}">${escapeHtml(t("subs.goProduct"))}</a></p>`;
      if (!p.sub_interval) {
        return `<div class="brick-shop-empty">${escapeHtml(t("subs.notSubscribable"))}</div>${toProduct}`;
      }
      // 품절은 "정기배송 상품이 아니다" 와 다르다 — 기다리면 다시 살 수 있다
      if (p.status !== "selling") {
        return `<div class="brick-shop-empty">${escapeHtml(t("detail.soldoutNotice"))}</div>${toProduct}`;
      }

      blockCtx?.setSeo?.({ title: t("subs.signupTitle") });
      const cycle = intervalLabel(String(p.sub_interval), t);
      const href = `/shop/${encodeURIComponent(String(p.slug))}`;

      return `
<div class="brick-subscribe" id="brick-subscribe"
     data-user="${blockCtx?.user ? "1" : "0"}" data-slug="${escapeHtml(String(p.slug))}">
  <section class="brick-subf-product">
    <span class="brick-subf-thumb">${
      p.image_url
        ? `<img src="${escapeHtml(String(p.image_url))}" alt="" loading="lazy" />`
        : `<span class="brick-noimg">${escapeHtml(t("common.noImage"))}</span>`
    }</span>
    <span class="brick-subf-what">
      <a class="brick-subf-name" href="${escapeHtml(href)}">${escapeHtml(String(p.name))}</a>
      <span class="brick-subf-cycle">${escapeHtml(cycle)}</span>
      <strong class="brick-subf-price">${won(Number(p.price))}</strong>
    </span>
  </section>

  <p class="brick-subf-note">${escapeHtml(t("subs.cycleNote", { cycle }))}</p>

  <div id="brick-subf-gate"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>

  <form class="brick-subf-form" id="brick-subf-form" hidden>
    ${/* 수량은 제목을 달지 않는다 — 바로 위가 상품 상자라 "수량 / 수량" 이 두 번 읽힌다 */ ""}
    ${field(t("detail.qty"), '<input type="number" name="quantity" value="1" min="1" max="999" inputmode="numeric" />')}

    <h2>${escapeHtml(t("checkout.orderer"))}</h2>
    ${field(t("checkout.name"), '<input type="text" name="ordererName" autocomplete="name" required maxlength="50" />')}
    ${field(t("checkout.phone"), '<input type="tel" name="ordererPhone" autocomplete="tel" inputmode="tel" required maxlength="20" placeholder="010-0000-0000" />')}
    ${field(t("checkout.email"), '<input type="email" name="ordererEmail" autocomplete="email" maxlength="255" />')}

    <h2>${escapeHtml(t("checkout.shippingTo"))}</h2>
    <div class="brick-subf-addr">
      ${field(t("checkout.postcode"), '<input type="text" name="postcode" autocomplete="postal-code" inputmode="numeric" required maxlength="10" />')}
      ${field(t("checkout.address1"), '<input type="text" name="address1" autocomplete="street-address" required maxlength="200" />')}
    </div>
    ${field(t("checkout.address2"), '<input type="text" name="address2" autocomplete="address-line2" maxlength="200" />')}
    ${field(t("checkout.memo"), '<input type="text" name="deliveryMemo" maxlength="200" />')}
    <p class="brick-subf-hint">${escapeHtml(t("checkout.zoneHint"))}</p>

    <h2>${escapeHtml(t("subs.card"))}</h2>
    <div id="brick-subf-cards"></div>

    <section class="brick-subf-sum">
      <div><span>${escapeHtml(t("checkout.subtotal"))}</span><span id="brick-subf-subtotal">—</span></div>
      <div><span>${escapeHtml(t("checkout.shippingFee"))}</span><span id="brick-subf-ship">—</span></div>
      <div id="brick-subf-zone-row" hidden><span id="brick-subf-zone-label">${escapeHtml(t("checkout.zoneFee"))}</span><span id="brick-subf-zone">—</span></div>
      <div class="brick-grand"><span>${escapeHtml(t("subs.firstTotal"))}</span><span id="brick-subf-total">—</span></div>
    </section>

    <button type="submit" class="brick-primary brick-subf-submit">${escapeHtml(t("subs.submit"))}</button>
    ${/* 오류는 즉시 읽혀야 하므로 alert 다 — status(polite)는 하던 말을 끝낸 뒤에야 읽힌다 */ ""}
    <p class="brick-subf-msg" role="alert"></p>
  </form>

  <section class="brick-subf-done" id="brick-subf-done" hidden>
    <h2>${escapeHtml(t("subs.doneTitle"))}</h2>
    <p id="brick-subf-done-note"></p>
    <p>
      <a class="brick-primary brick-subf-go" href="/shop/subscriptions">${escapeHtml(t("subs.viewMine"))}</a>
      <a class="brick-subf-go" href="/shop">${escapeHtml(t("checkout.goShop"))}</a>
    </p>
  </section>
</div>
${subscribeScript(t)}${SUBSCRIBE_CSS}`;
    },
  };

  ctx.registerBlock(subscribeBlock);
  /*
   * 화면도 선언한다 — 스타터의 shop 페이지가 있으면 그 페이지의 storefront 가
   * 이기고(같은 블록을 그린다), 없으면 이 선언이 주소를 살린다. 회원 메뉴에는
   * 넣지 않는다: 상품이 정해져야 의미가 있는 화면이다.
   */
  ctx.registerScreen({ path: "shop/subscribe", title: "정기배송 신청", block: "subscription-signup" });
  return { subscribeBlock };
}

/** 주기 표기 — 서버가 남긴 코드(week·month)를 손님의 언어로 바꾼다 */
export function intervalLabel(
  interval: string,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  return interval === "week" ? t("subs.intervalWeek") : t("subs.intervalMonth");
}

const SUBSCRIBE_CSS = `
<style>
.brick-subscribe { max-width: 680px; }
.brick-subscribe h2 { font-size: 15px; margin: 26px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--color-line, #e4e4ea); }
.brick-subf-product { display: flex; gap: 16px; align-items: center; padding: 16px; border: 1px solid var(--color-line, #e4e4ea); border-radius: var(--radius-lg, 12px); }
.brick-subf-thumb { flex: none; width: 84px; height: 84px; overflow: hidden; border-radius: var(--radius, 8px); background: var(--color-bg-soft, #f7f7f9); display: flex; align-items: center; justify-content: center; }
.brick-subf-thumb img { width: 100%; height: 100%; object-fit: cover; }
.brick-subf-what { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
/* 상품명은 상세로 돌아가는 링크다 — 폰에서 누를 수 있어야 하므로 줄 높이를 준다 */
.brick-subf-name { display: inline-block; font-weight: 700; font-size: 15.5px; line-height: 1.5; padding: 4px 0; text-decoration: none; }
.brick-subf-cycle { font-size: 12.5px; color: var(--color-muted, #6c6c7a); }
.brick-subf-price { font-size: 16px; }
.brick-subf-note { margin: 12px 0 0; font-size: 13.5px; color: var(--color-text-soft, #45454f); }
.brick-subf-form .brick-field { display: block; margin-top: 12px; font-size: 13.5px; color: var(--color-text-soft, #45454f); }
.brick-subf-form .brick-field input { display: block; width: 100%; margin-top: 5px; }
.brick-subf-form input[name="quantity"] { max-width: 120px; }
.brick-subf-form [aria-invalid="true"] { border-color: var(--color-danger, #c8322f); outline: 2px solid var(--color-danger, #c8322f); outline-offset: 1px; }
.brick-subf-addr { display: grid; grid-template-columns: 130px 1fr; gap: 10px; }
.brick-subf-hint { margin: 8px 0 0; font-size: 12.5px; color: var(--color-muted, #6c6c7a); }
.brick-subf-cardrow { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 14.5px; cursor: pointer; }
.brick-subf-cardrow + .brick-subf-cardrow { border-top: 1px solid var(--color-line, #e4e4ea); }
.brick-subf-cards-empty { margin: 0; font-size: 13.5px; }
.brick-subf-sum { margin-top: 22px; padding: 14px 16px; background: var(--color-bg-soft, #f7f7f9); border: 1px solid var(--color-line, #e4e4ea); border-radius: var(--radius-lg, 12px); font-size: 14px; }
.brick-subf-sum div { display: flex; justify-content: space-between; padding: 3px 0; }
/* 지역 추가비 줄은 우편번호를 받기 전에는 없다 — display:flex 가 [hidden] 을 이기지 못하게 못박는다 */
.brick-subf-sum div[hidden] { display: none; }
.brick-subf-sum .brick-grand { font-weight: 700; font-size: 16.5px; border-top: 1px solid var(--color-line, #e4e4ea); margin-top: 8px; padding-top: 9px; }
.brick-subf-submit { width: 100%; padding: 15px; margin-top: 16px; font-size: 15px; }
.brick-subf-msg { font-size: 13.5px; min-height: 18px; }
.brick-subf-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-subf-back { margin-top: 14px; font-size: 13.5px; }
.brick-subf-go { display: inline-block; padding: 10px 18px; border-radius: var(--radius, 8px); text-decoration: none; }
.brick-subf-done p { font-size: 14.5px; }
@media (max-width: 560px) {
  .brick-subf-addr { grid-template-columns: 1fr; }
  .brick-subf-product { padding: 12px; gap: 12px; }
  .brick-subf-thumb { width: 66px; height: 66px; }
}
</style>`;

const subscribeScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-subscribe');
  if (!root) return;
  var API = '/api/plugins/brick-shop';
  var slug = root.dataset.slug;
  var gate = document.getElementById('brick-subf-gate');
  var form = document.getElementById('brick-subf-form');
  var done = document.getElementById('brick-subf-done');
  var msg = form.querySelector('.brick-subf-msg');
  ${moneyFnScript("fmt")}
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fail(text){ msg.textContent = text; msg.className = 'brick-subf-msg is-error'; }
  function say(text){ msg.textContent = text; msg.className = 'brick-subf-msg'; }

  if (root.dataset.user !== '1') {
    var next = encodeURIComponent(location.pathname + location.search);
    gate.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("subs.loginRequired"))} +
      ' <a href="/login?next=' + next + '">' + ${JSON.stringify(t("cards.login"))} + '</a></p>';
    return;
  }

  /*
   * 카드가 없으면 폼을 열지 않는다 — 다 채운 뒤 "카드가 없습니다" 로 막는 것은
   * 손님에게 두 번 일을 시키는 것이다. 카드 등록 화면으로 보내되, 돌아올 주소를
   * 들려 보낸다.
   */
  function cardsBox(items){
    var box = document.getElementById('brick-subf-cards');
    if (!items.length) {
      box.innerHTML = '<p class="brick-subf-cards-empty">' + ${JSON.stringify(t("subs.cardEmpty"))} + '</p>';
      return false;
    }
    box.innerHTML = items.map(function(c, i){
      return '<label class="brick-subf-cardrow">' +
        '<input type="radio" name="billingKeyId" value="' + esc(c.id) + '"' + (i === 0 ? ' checked' : '') + ' /> ' +
        esc(c.cardLabel || c.card_label || c.provider) + '</label>';
    }).join('');
    return true;
  }

  function fields(){
    var f = new FormData(form);
    var o = {};
    ['ordererName','ordererPhone','ordererEmail','postcode','address1','address2','deliveryMemo'].forEach(function(k){
      var v = String(f.get(k) || '').trim();
      if (v) o[k] = v;
    });
    return o;
  }
  function qty(){ return Math.max(1, Math.min(999, Math.floor(Number(form.quantity.value) || 1))); }

  /** 금액 — 수량·우편번호가 바뀔 때마다 서버에 다시 묻는다 (지역 추가비가 붙는다) */
  var quoteSeq = 0;
  function refreshQuote(){
    var mine = ++quoteSeq;
    var post = String(new FormData(form).get('postcode') || '').trim();
    return fetch(API + '/subscriptions/quote', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ productSlug: slug, quantity: qty(), postcode: post || null })
    }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){
        if (mine !== quoteSeq) return;   // 늦게 온 응답이 새 금액을 덮지 않게 한다
        if (!res.ok) { fail(res.d.message || ${JSON.stringify(t("subs.quoteFail"))}); return; }
        var q = res.d;
        document.getElementById('brick-subf-subtotal').textContent = fmt(q.subtotal);
        document.getElementById('brick-subf-ship').textContent =
          q.shippingFee > 0 ? fmt(q.shippingFee) : ${JSON.stringify(t("checkout.free"))};
        var zoneRow = document.getElementById('brick-subf-zone-row');
        if (q.zoneFee > 0) {
          zoneRow.hidden = false;
          document.getElementById('brick-subf-zone').textContent = fmt(q.zoneFee);
          if (q.zoneName) document.getElementById('brick-subf-zone-label').textContent =
            ${JSON.stringify(t("checkout.zoneFee"))} + ' (' + q.zoneName + ')';
        } else { zoneRow.hidden = true; }
        document.getElementById('brick-subf-total').textContent = fmt(q.total);
        say('');
      })
      .catch(function(){ if (mine === quoteSeq) fail(${JSON.stringify(t("subs.quoteFail"))}); });
  }

  form.addEventListener('input', function(e){
    var name = e.target && e.target.name;
    if (name === 'quantity' || name === 'postcode') refreshQuote();
  });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var picked = form.querySelector('input[name="billingKeyId"]:checked');
    if (!picked) { fail(${JSON.stringify(t("subs.cardPick"))}); return; }
    var btn = form.querySelector('.brick-subf-submit');
    btn.disabled = true;
    say(${JSON.stringify(t("subs.submitting"))});
    fetch(API + '/subscriptions', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ productSlug: slug, quantity: qty(), billingKeyId: picked.value, orderer: fields() })
    }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){
        if (!res.ok) {
          fail(res.d.message || ${JSON.stringify(t("subs.signupFail"))});
          // 서버가 어느 칸인지 알려주면 그 칸으로 데려간다 (주소 칸이 일곱 개다)
          var f = res.d.field && form.querySelector('[name="' + res.d.field + '"]');
          if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); }
          btn.disabled = false;
          return;
        }
        form.hidden = true;
        done.hidden = false;
        document.getElementById('brick-subf-done-note').textContent =
          ${JSON.stringify(t("subs.doneNote", { orderNo: "__O__" }))}.replace('__O__', res.d.orderNo || '');
        done.scrollIntoView({ block: 'start' });
      })
      .catch(function(){ fail(${JSON.stringify(t("subs.signupFail"))}); btn.disabled = false; });
  });

  fetch(API + '/me/billing-keys')
    .then(function(r){ return r.ok ? r.json() : { items: [] }; })
    .then(function(d){
      var items = d.items || [];
      if (!items.length) {
        var back = encodeURIComponent(location.pathname + location.search);
        gate.innerHTML = '<p class="brick-subf-cards-empty">' + ${JSON.stringify(t("subs.cardEmpty"))} + '</p>' +
          '<p><a class="brick-primary brick-subf-go" href="/shop/cards?next=' + back + '">' +
          ${JSON.stringify(t("subs.cardGo"))} + '</a></p>';
        return;
      }
      gate.hidden = true;
      form.hidden = false;
      cardsBox(items);
      refreshQuote();
    })
    .catch(function(){
      gate.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("cards.loadFail"))} + '</p>';
    });
})();
</script>`;
