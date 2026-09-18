import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { gatewayScripts } from "./pay-client.js";

/**
 * 결제 카드(빌링키) 화면 — 정기배송이 쓰는 카드를 회원이 직접 관리한다.
 *
 * 서버는 처음부터 다 갖고 있었다: 카드 등록 준비(`/me/billing-keys/prepare`),
 * 발급(`POST /me/billing-keys`), 목록, 삭제, 그리고 정기결제 가입·해지·재개까지
 * 열 개의 라우트. **화면이 하나도 없었다.** 그래서 회원은 카드를 등록할 수
 * 없고, 카드가 없으니 정기배송에 가입할 수도 없다 — 관리 화면의 "정기배송"
 * 목록은 만들어질 수 없는 구독을 기다리고 있었다.
 *
 * 카드번호는 **PG 의 카드 등록 창에서만** 입력된다. 우리가 받는 것은 그 창이
 * 돌려준 1회용 authKey 뿐이고, 그것으로 서버가 PG 에 빌링키를 요청한다 —
 * 카드번호는 이 시스템을 지나가지 않는다(payments.ts 의 계약).
 */
export function registerCardsView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const cardsBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "billing-cards",
    displayName: "결제 카드",
    render: async (_props, blockCtx) => `
<div class="brick-cards" id="brick-cards" data-user="${blockCtx?.user ? "1" : "0"}">
  <div id="brick-cards-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${await gatewayScripts()}${cardsScript(t)}${CARDS_CSS}`,
  };

  ctx.registerBlock(cardsBlock);
  ctx.registerScreen({ path: "shop/cards", title: "결제 카드", block: "billing-cards", memberMenu: true, order: 20 });
}

const CARDS_CSS = `
<style>
.brick-cards { max-width: 560px; }
.brick-card-row { display: flex; align-items: center; gap: 12px; padding: 14px 4px; border-bottom: 1px solid var(--color-line, #e7e7ec); }
.brick-card-label { flex: 1; font-weight: 600; }
.brick-card-date { color: var(--color-muted, #6c6c7a); font-size: 12.5px; }
/* 40px — 폰에서 누르는 자리다 */
.brick-cards button { min-height: 40px; padding: 0 14px; cursor: pointer; font: inherit; font-size: 13.5px; }
.brick-card-add { margin-top: 18px; }
.brick-cards-msg { font-size: 13.5px; min-height: 18px; }
.brick-cards-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-cards-note { color: var(--color-text-soft, #45454f); font-size: 12.5px; margin: 14px 0 0; }
</style>`;

const cardsScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-cards');
  if (!root) return;
  var body = document.getElementById('brick-cards-body');
  var API = '/api/plugins/brick-shop';
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  if (root.dataset.user !== '1') {
    var next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("cards.loginRequired"))} +
      ' <a href="/login?next=' + next + '">' + ${JSON.stringify(t("cards.login"))} + '</a></p>';
    return;
  }

  function msgBox(){ return document.querySelector('.brick-cards-msg'); }
  function say(text, bad){
    var m = msgBox();
    if (!m) return;
    m.textContent = text;
    m.className = 'brick-cards-msg' + (bad ? ' is-error' : '');
  }

  /*
   * 카드 등록 창에서 돌아왔다.
   *
   * PG 마다 돌려주는 칸 이름이 다르므로(토스는 authKey·customerKey) 번역은
   * 그 플러그인의 readCardReturn 이 한다. 우리는 그 값을 서버에 넘길 뿐이고,
   * 빌링키 발급은 서버가 PG 에 직접 요청한다.
   */
  function finishReturn(){
    var q = new URLSearchParams(location.search);
    var provider = q.get('brickCard');
    if (!provider) return Promise.resolve(null);
    var pay = (window.brickPay || {})[provider];
    var got = pay && typeof pay.readCardReturn === 'function' ? pay.readCardReturn(q) : null;
    if (!got) return Promise.resolve(${JSON.stringify(t("cards.addCancelled"))});
    return fetch(API + '/me/billing-keys', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ provider: provider, authKey: got.authKey, customerKey: got.customerKey })
    }).then(function(r){ return r.json().then(function(d){ return r.ok ? null : (d.message || ${JSON.stringify(t("cards.addFail"))}); }); })
      .catch(function(){ return ${JSON.stringify(t("cards.addFail"))}; });
  }

  function render(items, providers, note){
    var rows = items.length
      ? items.map(function(c){
          return '<div class="brick-card-row" data-card="' + esc(c.id) + '">' +
            '<span class="brick-card-label">' + esc(c.cardLabel || c.card_label || c.provider) + '</span>' +
            '<span class="brick-card-date">' + String(c.createdAt || c.created_at || '').slice(0, 10) + '</span>' +
            '<button type="button" data-drop>' + ${JSON.stringify(t("cards.remove"))} + '</button></div>';
        }).join('')
      : '<p class="brick-shop-empty">' + ${JSON.stringify(t("cards.empty"))} + '</p>';

    var add = providers.length
      ? '<p class="brick-card-add">' + providers.map(function(p){
          return '<button type="button" data-add="' + esc(p.provider) + '">' +
            ${JSON.stringify(t("cards.add", { name: "__N__" }))}.replace('__N__', esc(p.displayName)) + '</button>';
        }).join(' ') + '</p>'
      // 정기결제를 지원하는 PG 가 없다 — 등록할 수 있는 척하지 않는다
      : '<p class="brick-cards-note">' + ${JSON.stringify(t("cards.noProvider"))} + '</p>';

    body.innerHTML = rows + add +
      '<p class="brick-cards-msg" role="alert"></p>' +
      '<p class="brick-cards-note">' + ${JSON.stringify(t("cards.safetyNote"))} + '</p>';
    if (note) say(note, true);

    body.querySelectorAll('[data-add]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var provider = btn.dataset.add;
        var pay = (window.brickPay || {})[provider];
        if (!pay || typeof pay.registerCard !== 'function') { say(${JSON.stringify(t("cards.addUnavailable"))}, true); return; }
        btn.disabled = true;
        say(${JSON.stringify(t("cards.adding"))}, false);
        fetch(API + '/me/billing-keys/prepare', { method: 'POST' })
          .then(function(r){ return r.json(); })
          .then(function(d){
            var back = location.origin + location.pathname + '?brickCard=' + encodeURIComponent(provider);
            return pay.registerCard({ customerKey: d.customerKey, returnUrl: back });
          })
          .catch(function(){ say(${JSON.stringify(t("cards.addFail"))}, true); btn.disabled = false; });
      });
    });

    body.querySelectorAll('[data-drop]').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (!confirm(${JSON.stringify(t("cards.removeConfirm"))})) return;
        var id = btn.closest('[data-card]').dataset.card;
        btn.disabled = true;
        fetch(API + '/me/billing-keys/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function(r){ return r.json().then(function(d){ return {ok: r.ok, d: d}; }); })
          .then(function(res){
            if (!res.ok) { say(res.d.message || ${JSON.stringify(t("cards.removeFail"))}, true); btn.disabled = false; return; }
            load();
          })
          .catch(function(){ say(${JSON.stringify(t("cards.removeFail"))}, true); btn.disabled = false; });
      });
    });
  }

  function load(note){
    return Promise.all([
      fetch(API + '/me/billing-keys').then(function(r){ return r.ok ? r.json() : { items: [] }; }),
      fetch(API + '/billing/providers').then(function(r){ return r.ok ? r.json() : { providers: [] }; })
    ]).then(function(res){
      render(res[0].items || [], res[1].providers || [], note);
    }).catch(function(){
      body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("cards.loadFail"))} + '</p>';
    });
  }

  finishReturn().then(function(note){ load(note); });
})();
</script>`;
