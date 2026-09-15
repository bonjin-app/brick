import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { localeTag, dateOptsScript } from "./i18n.js";

/**
 * 재입고 알림 — 내 신청 내역과 **해지**.
 *
 * 해지 링크가 죽어 있었다. 재입고 메일은 "신청하지 않으셨다면 아래 링크를 눌러
 * 알림을 해지해주세요" 라며 `/shop/restock/cancel/<토큰>` 을 보내는데, 스토어프론트에
 * 그 경로를 받는 자리가 없어서 **"상품을 찾을 수 없습니다"** 가 떴다(재현했다).
 * 목록 API 도 같은 주소를 `cancelPath` 로 돌려주고 있었다.
 *
 * 한 번 신청하면 끊을 방법이 없는 알림은, 광고가 아니라고 적어 두었어도
 * 받는 사람에게는 끊을 수 없는 메일이다.
 *
 * 해지는 **로그인을 요구하지 않는다** — 비회원도 신청할 수 있고, 잘못 신청된
 * 사람에게 "로그인해서 해지하라"는 것은 해지 경로가 없는 것과 같다(서버의
 * `cancelRestockAlert` 주석이 같은 말을 한다).
 */
export function registerRestockView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const restockBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "restock-alerts",
    displayName: "재입고 알림",
    render: async (props, blockCtx) => {
      const tail = String(blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      const seg = tail.split("/").filter(Boolean);
      // 라우터가 props 로 주는 길(쇼핑몰 페이지)과 선언 화면의 pathTail, 둘 다 받는다
      const fromRouter = props.token !== undefined || props.mode !== undefined;
      const token = String(
        (fromRouter ? props.token : seg[0] === "cancel" ? seg[1] : "") ?? "",
      ).trim();

      if (token) {
        blockCtx?.setSeo?.({ title: t("restock.cancelTitle") });
        return `
<div class="brick-restock-cancel" id="brick-restock-cancel" data-token="${escapeHtml(token)}">
  <h2>${escapeHtml(t("restock.cancelTitle"))}</h2>
  <p class="brick-restock-result" role="status">${escapeHtml(t("restock.cancelBusy"))}</p>
</div>
${cancelScript(t)}${RESTOCK_CSS}`;
      }

      if (!blockCtx?.user) {
        return `<div class="brick-restock-mine"><p class="brick-shop-empty">${
          escapeHtml(t("restock.loginRequired"))
        } <a href="/login">${escapeHtml(t("coupons.login"))}</a></p></div>${RESTOCK_CSS}`;
      }
      blockCtx?.setSeo?.({ title: t("restock.myTitle") });
      return `
<div class="brick-restock-mine" id="brick-restock-mine">
  <div id="brick-restock-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${listScript(t)}${RESTOCK_CSS}`;
    },
  };
  ctx.registerBlock(restockBlock);
  return { restockBlock };
}

/**
 * 해지 화면.
 *
 * 열자마자 해지한다 — 메일에서 "해지" 를 누른 사람에게 버튼을 한 번 더 내밀면
 * 그 자리에서 포기하고, 그러면 메일은 계속 간다. 되돌릴 수 있는 일이고
 * (다시 신청하면 된다) 토큰은 한 사람의 한 신청만 가리킨다.
 */
const cancelScript = (t: (k: string) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-restock-cancel');
  if (!root) return;
  var out = root.querySelector('.brick-restock-result');
  fetch('/api/plugins/brick-shop/restock-alerts/cancel/' + encodeURIComponent(root.dataset.token), { method: 'POST' })
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      out.textContent = res.ok
        ? (res.d.message || ${JSON.stringify(t("restock.cancelled"))})
        : (res.d.message || ${JSON.stringify(t("restock.cancelFail"))});
    })
    .catch(function(){ out.textContent = ${JSON.stringify(t("restock.cancelFail"))}; });
})();
</script>`;

/** 내 신청 내역 — 회원만. 비회원은 메일의 해지 링크를 쓴다 */
const listScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-restock-mine');
  if (!root) return;
  var body = document.getElementById('brick-restock-body');
  var TAG = ${JSON.stringify(localeTag())};
  ${dateOptsScript()}
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function load(notice){
    fetch('/api/plugins/brick-shop/me/restock-alerts')
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d) { body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("restock.cancelFail"))} + '</p>'; return; }
        var items = d.items || [];
        if (!items.length) {
          body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("restock.empty"))} + '</p>' +
            (notice ? '<p class="brick-restock-result" role="status">' + esc(notice) + '</p>' : '');
          return;
        }
        var rows = items.map(function(it){
          return '<tr><td><a href="/shop/' + encodeURIComponent(it.productSlug) + '">' + esc(it.productName) + '</a>' +
            (it.optionName ? '<br /><small>' + esc(it.optionName) + '</small>' : '') + '</td>' +
            '<td>' + new Date(it.createdAt).toLocaleDateString(TAG, DATE_OPTS) + '</td>' +
            '<td>' + (it.notifiedAt
              ? ${JSON.stringify(t("restock.statusNotified"))}
              : ${JSON.stringify(t("restock.statusWaiting"))}) + '</td>' +
            '<td><button type="button" class="brick-restock-drop" data-path="' + esc(it.cancelPath) + '">' +
            ${JSON.stringify(t("restock.cancel"))} + '</button></td></tr>';
        }).join('');
        body.innerHTML = '<table><thead><tr>' +
          '<th>' + ${JSON.stringify(t("restock.colProduct"))} + '</th>' +
          '<th>' + ${JSON.stringify(t("restock.colDate"))} + '</th>' +
          '<th>' + ${JSON.stringify(t("restock.colStatus"))} + '</th>' +
          '<th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="brick-restock-result" role="status">' + esc(notice || '') + '</p>';

        body.querySelectorAll('.brick-restock-drop').forEach(function(btn){
          btn.addEventListener('click', function(){
            if (!confirm(${JSON.stringify(t("restock.cancelConfirm"))})) return;
            btn.disabled = true;
            // 목록이 준 cancelPath 를 그대로 쓴다 — 토큰 주소를 화면이 또 만들면 갈라진다
            var token = String(btn.dataset.path).split('/').pop();
            fetch('/api/plugins/brick-shop/restock-alerts/cancel/' + encodeURIComponent(token), { method: 'POST' })
              .then(function(r){ return r.ok; })
              .then(function(ok){
                if (!ok) { btn.disabled = false; return; }
                load(${JSON.stringify(t("restock.cancelled"))});
              })
              .catch(function(){ btn.disabled = false; });
          });
        });
      })
      .catch(function(){ body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("restock.cancelFail"))} + '</p>'; });
  }
  load('');
})();
</script>`;

const RESTOCK_CSS = `
<style>
.brick-restock-mine table { width: 100%; border-collapse: collapse; font-size: 14px; }
.brick-restock-mine th, .brick-restock-mine td { padding: 9px 6px; border-bottom: 1px solid var(--color-line, #e7e7ec); text-align: left; }
.brick-restock-mine th { color: var(--color-muted, #71717d); font-weight: 600; }
.brick-restock-mine small { color: var(--color-muted, #71717d); }
/* 40px — 폰에서 알림을 끊는 버튼이다 */
.brick-restock-drop { min-height: 40px; padding: 0 12px; cursor: pointer; font: inherit; font-size: 13px; }
.brick-restock-cancel { max-width: 520px; margin: 0 auto; text-align: center; padding: 28px 16px; }
.brick-restock-result { font-size: 14.5px; color: var(--color-muted, #71717d); }
</style>`;
