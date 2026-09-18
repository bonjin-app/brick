import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { moneyFnScript, localeTag, dateOptsScript } from "./i18n.js";

/**
 * 내 정기배송 화면.
 *
 * 서버에는 가입·목록·회차 이력·해지·재개가 다 있었는데 **회원이 볼 화면이
 * 없었다.** 문서는 "해지는 항상 즉시" 라고 약속하고, 코드도 조건 없이 그렇게
 * 만들어져 있다(`cancelSubscription` 은 확인 절차를 쌓지 않는다) — 그런데
 * 해지를 누를 자리가 없으면 그 약속은 지킬 수 없는 약속이다. 정기적으로 돈이
 * 빠져나가는 계약에서 멈추는 길이 없는 것은 가장 나쁜 실패다.
 *
 * 카드가 사라지면 서버가 구독을 `paused` 로 세운다(`pause_reason` 에 이유가
 * 적힌다). 그 상태에서 다시 시작하는 길도 여기 있다 — 카드를 다시 등록한 뒤
 * "다시 시작" 이다.
 */
export function registerSubscriptionsView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const subsBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "my-subscriptions",
    displayName: "내 정기배송",
    render: async (_props, blockCtx) => `
<div class="brick-subs" id="brick-subs" data-user="${blockCtx?.user ? "1" : "0"}">
  <div id="brick-subs-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${subsScript(t)}${SUBS_CSS}`,
  };

  ctx.registerBlock(subsBlock);
  ctx.registerScreen({ path: "shop/subscriptions", title: "정기배송", block: "my-subscriptions", memberMenu: true, order: 18 });
}

const SUBS_CSS = `
<style>
.brick-subs { max-width: 640px; }
.brick-sub { border: 1px solid var(--color-line, #e7e7ec); border-radius:var(--radius-lg, 12px); padding: 16px; margin-bottom: 14px; }
.brick-sub-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.brick-sub-name { font-weight: 700; font-size: 16px; }
.brick-sub-state { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--color-bg-soft, #f7f7f9); border: 1px solid var(--color-line, #e7e7ec); }
.brick-sub-state.is-active { color: var(--color-success, #11795a); }
.brick-sub-state.is-paused { color: var(--color-warning, #96610a); }
.brick-sub-state.is-cancelled { color: var(--color-muted, #6c6c7a); }
.brick-sub dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 12px 0 0; font-size: 14px; }
.brick-sub dt { color: var(--color-text-soft, #45454f); }
.brick-sub dd { margin: 0; }
.brick-sub-pause { margin: 10px 0 0; font-size: 13.5px; color: var(--color-warning, #96610a); }
.brick-sub-actions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
/* 40px — 폰에서 누르는 자리다. 해지는 언제나 한 번에 닿아야 한다 */
.brick-subs button { min-height: 40px; padding: 0 14px; cursor: pointer; font: inherit; font-size: 13.5px; }
.brick-sub-msg { font-size: 13.5px; }
.brick-sub-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-sub-events { margin-top: 12px; font-size: 13px; }
.brick-sub-events ul { margin: 8px 0 0; padding-left: 18px; }
.brick-sub-events li { margin: 3px 0; color: var(--color-text-soft, #45454f); }
</style>`;

const subsScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-subs');
  if (!root) return;
  var body = document.getElementById('brick-subs-body');
  var API = '/api/plugins/brick-shop';
  ${moneyFnScript("fmt")}
  var TAG = ${JSON.stringify(localeTag())};  // 날짜도 사이트 언어를 따른다
  ${dateOptsScript()}                        // …그리고 사이트 시간대를 따른다
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function day(v){ return v ? new Date(v).toLocaleDateString(TAG, DATE_OPTS) : '—'; }

  if (root.dataset.user !== '1') {
    var next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("subs.loginRequired"))} +
      ' <a href="/login?next=' + next + '">' + ${JSON.stringify(t("cards.login"))} + '</a></p>';
    return;
  }

  var STATE = {
    active: ${JSON.stringify(t("subs.stateActive"))},
    paused: ${JSON.stringify(t("subs.statePaused"))},
    cancelled: ${JSON.stringify(t("subs.stateCancelled"))}
  };

  /*
   * 회차 이력의 종류 — 서버는 코드(charged·failed…)로 남긴다.
   * 그대로 보여 주면 손님 화면에 영어 코드가 뜬다("2026. 9. 18. — charged").
   */
  var KIND = {
    charged: ${JSON.stringify(t("subs.kindCharged"))},
    failed: ${JSON.stringify(t("subs.kindFailed"))},
    paused: ${JSON.stringify(t("subs.kindPaused"))},
    resumed: ${JSON.stringify(t("subs.kindResumed"))},
    cancelled: ${JSON.stringify(t("subs.kindCancelled"))}
  };

  function card(s){
    var cls = s.status === 'active' ? 'is-active' : s.status === 'paused' ? 'is-paused' : 'is-cancelled';
    return '<section class="brick-sub" data-sub="' + esc(s.id) + '">' +
      '<div class="brick-sub-head"><span class="brick-sub-name">' + esc(s.productName) +
        (s.quantity > 1 ? ' × ' + s.quantity : '') + '</span>' +
        '<span class="brick-sub-state ' + cls + '">' + esc(STATE[s.status] || s.status) + '</span></div>' +
      '<dl>' +
        '<dt>' + ${JSON.stringify(t("subs.cycle"))} + '</dt><dd>' + esc(s.intervalLabel || '') + '</dd>' +
        '<dt>' + ${JSON.stringify(t("subs.amount"))} + '</dt><dd>' + fmt(s.amount) + '</dd>' +
        '<dt>' + ${JSON.stringify(t("subs.nextCharge"))} + '</dt><dd>' +
          (s.status === 'active' ? day(s.nextChargeAt) : '—') + '</dd>' +
        '<dt>' + ${JSON.stringify(t("subs.card"))} + '</dt><dd>' + esc(s.cardLabel || '—') + '</dd>' +
        '<dt>' + ${JSON.stringify(t("subs.cycleNo"))} + '</dt><dd>' + Number(s.cycleNo || 0) + '</dd>' +
      '</dl>' +
      (s.pauseReason ? '<p class="brick-sub-pause">' + esc(s.pauseReason) + '</p>' : '') +
      '<div class="brick-sub-actions">' +
        (s.status === 'active' ? '<button type="button" data-cancel>' + ${JSON.stringify(t("subs.cancel"))} + '</button>' : '') +
        (s.status === 'paused' ? '<button type="button" data-resume>' + ${JSON.stringify(t("subs.resume"))} + '</button>' +
                                 '<button type="button" data-cancel>' + ${JSON.stringify(t("subs.cancel"))} + '</button>' : '') +
        '<button type="button" data-events>' + ${JSON.stringify(t("subs.history"))} + '</button>' +
        '<span class="brick-sub-msg" role="alert"></span>' +
      '</div>' +
      '<div class="brick-sub-events" hidden></div></section>';
  }

  function bind(el){
    var id = el.dataset.sub;
    var msg = el.querySelector('.brick-sub-msg');
    function fail(text){ msg.textContent = text; msg.className = 'brick-sub-msg is-error'; }

    var cancelBtn = el.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', function(){
      /*
       * 확인은 한 번만 묻는다 — 되돌릴 수 없는 일이라 묻긴 하지만,
       * 해지를 어렵게 만들지 않는다(문서가 "항상, 즉시" 라고 약속한다).
       */
      if (!confirm(${JSON.stringify(t("subs.cancelConfirm"))})) return;
      cancelBtn.disabled = true;
      fetch(API + '/me/subscriptions/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(res){
          if (!res.ok) { fail(res.d.message || ${JSON.stringify(t("subs.cancelFail"))}); cancelBtn.disabled = false; return; }
          load();
        })
        .catch(function(){ fail(${JSON.stringify(t("subs.cancelFail"))}); cancelBtn.disabled = false; });
    });

    var resumeBtn = el.querySelector('[data-resume]');
    if (resumeBtn) resumeBtn.addEventListener('click', function(){
      resumeBtn.disabled = true;
      fetch(API + '/me/subscriptions/' + encodeURIComponent(id) + '/resume', {
        method: 'POST', headers: {'content-type':'application/json'}, body: '{}'
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(res){
          if (!res.ok) { fail(res.d.message || ${JSON.stringify(t("subs.resumeFail"))}); resumeBtn.disabled = false; return; }
          load();
        })
        .catch(function(){ fail(${JSON.stringify(t("subs.resumeFail"))}); resumeBtn.disabled = false; });
    });

    el.querySelector('[data-events]').addEventListener('click', function(){
      var box = el.querySelector('.brick-sub-events');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<p>' + ${JSON.stringify(t("orders.loading"))} + '</p>';
      fetch(API + '/me/subscriptions/' + encodeURIComponent(id) + '/events')
        .then(function(r){ return r.ok ? r.json() : { items: [] }; })
        .then(function(d){
          var items = d.items || [];
          box.innerHTML = items.length
            ? '<ul>' + items.map(function(ev){
                var kind = String(ev.kind || '');
                var no = ev.cycle_no ? ${JSON.stringify(t("subs.cycleN", { n: "__N__" }))}.replace('__N__', ev.cycle_no) + ' · ' : '';
                return '<li>' + day(ev.created_at || ev.createdAt) + ' — ' + no + esc(KIND[kind] || kind) +
                  (ev.detail ? ' (' + esc(ev.detail) + ')' : '') + '</li>';
              }).join('') + '</ul>'
            : '<p>' + ${JSON.stringify(t("subs.noHistory"))} + '</p>';
        })
        .catch(function(){ box.innerHTML = '<p>' + ${JSON.stringify(t("subs.historyFail"))} + '</p>'; });
    });
  }

  function load(){
    return fetch(API + '/me/subscriptions')
      .then(function(r){ return r.ok ? r.json() : { items: [] }; })
      .then(function(d){
        var items = d.items || [];
        if (!items.length) {
          body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("subs.empty"))} + '</p>';
          return;
        }
        body.innerHTML = items.map(card).join('');
        body.querySelectorAll('[data-sub]').forEach(bind);
      })
      .catch(function(){
        body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("subs.loadFail"))} + '</p>';
      });
  }

  load();
})();
</script>`;
