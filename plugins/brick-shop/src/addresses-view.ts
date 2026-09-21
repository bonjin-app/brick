import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";
import { addressSearchField, addressSearchScript, ADDRESS_SEARCH_CSS } from "./address-search.js";
import type { ShopSettings } from "./types.js";

/**
 * 배송지 관리 화면 — /shop/addresses (회원 메뉴).
 *
 * 주문서에서 저장한 주소를 회원이 직접 고치고 지운다. 저장만 되고 관리할 곳이
 * 없으면, 이사한 뒤로는 주문할 때마다 틀린 주소를 지우고 다시 적게 된다 —
 * 저장이 오히려 방해가 된다.
 */
export function registerAddressesView(
  ctx: PluginContext,
  settings: () => Promise<ShopSettings>,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const addressesBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "addresses",
    displayName: "배송지 관리",
    render: async (_props, blockCtx) => {
      const addrSearch = (await settings()).addressSearch !== false;
      return `
<div class="brick-addrs" id="brick-addrs" data-user="${blockCtx?.user ? "1" : "0"}">
  <div id="brick-addrs-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
  <form class="brick-addr-form" id="brick-addr-form" hidden>
    <h2 id="brick-addr-form-title">${escapeHtml(t("addrs.addTitle"))}</h2>
    <label class="brick-field">${escapeHtml(t("addrs.label"))}
      <input type="text" name="label" maxlength="30" placeholder="${escapeHtml(t("addrs.labelHint"))}" />
    </label>
    <label class="brick-field">${escapeHtml(t("addr.field.receiverName"))}
      <input type="text" name="receiverName" autocomplete="name" required maxlength="50" />
    </label>
    <label class="brick-field">${escapeHtml(t("addr.field.receiverPhone"))}
      <input type="tel" name="receiverPhone" autocomplete="tel" inputmode="tel" required maxlength="20" placeholder="010-0000-0000" />
    </label>
    <div class="brick-addr-cols">
      <label class="brick-field">${escapeHtml(t("checkout.postcode"))}
        <input type="text" name="postcode" autocomplete="postal-code" inputmode="numeric" required maxlength="10" />
      </label>
      <label class="brick-field">${escapeHtml(t("checkout.address1"))}
        <input type="text" name="address1" autocomplete="street-address" required maxlength="200" />
      </label>
    </div>
    ${addrSearch ? addressSearchField() : ""}
    <label class="brick-field">${escapeHtml(t("checkout.address2"))}
      <input type="text" name="address2" autocomplete="address-line2" maxlength="200" />
    </label>
    <label class="brick-addr-check">
      <input type="checkbox" name="isDefault" /> ${escapeHtml(t("addrs.makeDefault"))}
    </label>
    <div class="brick-addr-actions">
      <button type="submit" class="brick-primary">${escapeHtml(t("addrs.save"))}</button>
      <button type="button" data-cancel>${escapeHtml(t("addrs.cancel"))}</button>
      <span class="brick-addr-formmsg" role="alert"></span>
    </div>
  </form>
</div>
${addressesScript(t)}${addrSearch ? addressSearchScript() + ADDRESS_SEARCH_CSS : ""}${ADDRS_CSS}`;
    },
  };

  ctx.registerBlock(addressesBlock);
  ctx.registerScreen({ path: "shop/addresses", title: "배송지 관리", block: "addresses", memberMenu: true, order: 22 });
  return { addressesBlock };
}

const ADDRS_CSS = `
<style>
.brick-addrs { max-width: 640px; }
.brick-addr-card { border: 1px solid var(--color-line, #e4e4ea); border-radius: var(--radius-lg, 12px); padding: 14px 16px; margin-bottom: 12px; }
.brick-addr-card.is-default { border-color: var(--color-primary, #d0402c); }
.brick-addr-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.brick-addr-name { font-weight: 700; }
.brick-addr-tag { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--color-line, #e4e4ea); color: var(--color-muted, #6c6c7a); }
.brick-addr-tag.is-on { border-color: var(--color-primary, #d0402c); color: var(--color-primary, #d0402c); }
.brick-addr-line { font-size: 14px; color: var(--color-text-soft, #45454f); margin: 2px 0; }
.brick-addr-card-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
/* 40px — 폰에서 누르는 자리다 */
.brick-addrs button { min-height: 40px; padding: 0 14px; cursor: pointer; font: inherit; font-size: 13.5px; }
.brick-addr-form { border-top: 1px solid var(--color-line, #e4e4ea); margin-top: 20px; padding-top: 4px; }
.brick-addr-form .brick-field { display: block; margin-top: 12px; font-size: 13.5px; color: var(--color-text-soft, #45454f); }
.brick-addr-form .brick-field input { display: block; width: 100%; margin-top: 5px; }
.brick-addr-cols { display: grid; grid-template-columns: 130px 1fr; gap: 10px; }
.brick-addr-check { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 14px; min-height: 40px; }
.brick-addr-actions { margin-top: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.brick-addr-formmsg { font-size: 13.5px; color: var(--color-danger, #c8322f); font-weight: 600; }
.brick-addrs-msg { font-size: 13.5px; min-height: 18px; }
.brick-addrs-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
@media (max-width: 560px) { .brick-addr-cols { grid-template-columns: 1fr; } }
</style>`;

const addressesScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-addrs');
  if (!root) return;
  var body = document.getElementById('brick-addrs-body');
  var form = document.getElementById('brick-addr-form');
  var API = '/api/plugins/brick-shop';
  var editing = null;
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  if (root.dataset.user !== '1') {
    var next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("addrs.loginRequired"))} +
      ' <a href="/login?next=' + next + '">' + ${JSON.stringify(t("cards.login"))} + '</a></p>';
    return;
  }

  function msg(text, bad){
    var m = body.querySelector('.brick-addrs-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'brick-addrs-msg' + (bad ? ' is-error' : '');
  }
  function formMsg(text){ form.querySelector('.brick-addr-formmsg').textContent = text || ''; }

  function card(a){
    return '<section class="brick-addr-card' + (a.isDefault ? ' is-default' : '') + '" data-id="' + esc(a.id) + '">' +
      '<div class="brick-addr-top">' +
        '<span class="brick-addr-name">' + esc(a.receiverName) + '</span>' +
        (a.label ? '<span class="brick-addr-tag">' + esc(a.label) + '</span>' : '') +
        (a.isDefault ? '<span class="brick-addr-tag is-on">' + ${JSON.stringify(t("addrs.default"))} + '</span>' : '') +
      '</div>' +
      '<p class="brick-addr-line">' + esc(a.receiverPhone) + '</p>' +
      '<p class="brick-addr-line">[' + esc(a.postcode) + '] ' + esc(a.address1) + ' ' + esc(a.address2) + '</p>' +
      '<div class="brick-addr-card-actions">' +
        (a.isDefault ? '' : '<button type="button" data-default>' + ${JSON.stringify(t("addrs.makeDefault"))} + '</button>') +
        '<button type="button" data-edit>' + ${JSON.stringify(t("addrs.edit"))} + '</button>' +
        '<button type="button" data-drop>' + ${JSON.stringify(t("addrs.remove"))} + '</button>' +
      '</div></section>';
  }

  function fillForm(a){
    form.label.value = a ? (a.label || '') : '';
    form.receiverName.value = a ? a.receiverName : '';
    form.receiverPhone.value = a ? a.receiverPhone : '';
    form.postcode.value = a ? a.postcode : '';
    form.address1.value = a ? a.address1 : '';
    form.address2.value = a ? (a.address2 || '') : '';
    form.isDefault.checked = a ? !!a.isDefault : false;
    document.getElementById('brick-addr-form-title').textContent =
      a ? ${JSON.stringify(t("addrs.editTitle"))} : ${JSON.stringify(t("addrs.addTitle"))};
    formMsg('');
  }

  function openForm(a){
    editing = a ? a.id : null;
    fillForm(a);
    form.hidden = false;
    form.receiverName.focus();
  }

  function render(items){
    var list = items.length
      ? items.map(card).join('')
      : '<p class="brick-shop-empty">' + ${JSON.stringify(t("addrs.empty"))} + '</p>';
    body.innerHTML = list +
      '<p><button type="button" id="brick-addr-add">' + ${JSON.stringify(t("addrs.add"))} + '</button></p>' +
      '<p class="brick-addrs-msg" role="alert"></p>';
    document.getElementById('brick-addr-add').addEventListener('click', function(){ openForm(null); });

    body.querySelectorAll('[data-id]').forEach(function(el){
      var id = el.dataset.id;
      var mine = items.filter(function(a){ return a.id === id; })[0];
      var editBtn = el.querySelector('[data-edit]');
      if (editBtn) editBtn.addEventListener('click', function(){ openForm(mine); });
      var defBtn = el.querySelector('[data-default]');
      if (defBtn) defBtn.addEventListener('click', function(){
        defBtn.disabled = true;
        fetch(API + '/me/addresses/' + encodeURIComponent(id) + '/default', { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if (!res.ok) { msg(res.d.message || '', true); defBtn.disabled = false; return; } load(); })
          .catch(function(){ msg(${JSON.stringify(t("addrs.failed"))}, true); defBtn.disabled = false; });
      });
      el.querySelector('[data-drop]').addEventListener('click', function(){
        if (!confirm(${JSON.stringify(t("addrs.removeConfirm"))})) return;
        fetch(API + '/me/addresses/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if (!res.ok) { msg(res.d.message || '', true); return; } form.hidden = true; load(); })
          .catch(function(){ msg(${JSON.stringify(t("addrs.failed"))}, true); });
      });
    });
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var f = new FormData(form);
    var payload = {
      label: String(f.get('label') || '').trim(),
      receiverName: String(f.get('receiverName') || '').trim(),
      receiverPhone: String(f.get('receiverPhone') || '').trim(),
      postcode: String(f.get('postcode') || '').trim(),
      address1: String(f.get('address1') || '').trim(),
      address2: String(f.get('address2') || '').trim(),
      isDefault: form.isDefault.checked,
    };
    var url = API + '/me/addresses' + (editing ? '/' + encodeURIComponent(editing) : '');
    fetch(url, { method: editing ? 'PUT' : 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
      .then(function(res){
        if (!res.ok) {
          formMsg(res.d.message || ${JSON.stringify(t("addrs.failed"))});
          // 어느 칸이 문제인지 서버가 알려주면 그 칸으로 데려간다
          var el = res.d.field && form.querySelector('[name="' + res.d.field + '"]');
          if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
          return;
        }
        form.hidden = true;
        editing = null;
        load();
      })
      .catch(function(){ formMsg(${JSON.stringify(t("addrs.failed"))}); });
  });
  form.querySelector('[data-cancel]').addEventListener('click', function(){ form.hidden = true; editing = null; });

  function load(){
    return fetch(API + '/me/addresses')
      .then(function(r){ return r.ok ? r.json() : { items: [] }; })
      .then(function(d){ render(d.items || []); })
      .catch(function(){ body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("addrs.failed"))} + '</p>'; });
  }
  load();
})();
</script>`;
