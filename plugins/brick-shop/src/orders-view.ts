import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, STACK_TABLE_CSS } from "@brick/plugin-sdk";
import { gatewayScripts } from "./pay-client.js";
import { moneyFnScript, localeTag, dateOptsScript } from "./i18n.js";

/**
 * 주문 조회 화면 — <상점>/orders (목록) · <상점>/orders/<주문번호> (상세).
 *
 * 주문서를 만들고 나니 다음 구멍이 보였다: **주문한 손님이 주문을 다시 볼
 * 화면이 없다.** 회원 목록 API(/my/orders)와 단건 조회(/orders/:orderNo,
 * 비회원은 guestToken)는 있었지만 화면이 없으면 없는 기능이다.
 *
 * 골격은 서버, 내용은 클라이언트가 인증 API 로 — 주문은 개인정보라
 * 렌더 캐시에 실으면 안 된다 (ADR-30 패턴, 장바구니·주문서와 동일).
 * 비회원은 주문했던 기기의 guestToken(localStorage)으로만 조회된다 —
 * 주문번호만으로 열리면 순차 번호라 남의 주문을 열람할 수 있다.
 */
export function registerOrdersView(ctx: PluginContext, t: (k: string, p?: Record<string, string | number>) => string) {
  /** 상태 코드 → 현재 언어 라벨. 렌더 시점 t 로 만들어 클라이언트에 주입한다 */
  const statusLabels = () =>
    JSON.stringify(Object.fromEntries(
      ["pending", "paid", "preparing", "shipped", "delivered", "cancelled", "refunded"]
        .map((s) => [s, t(`status.${s}`)]),
    ));

  const ordersBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "orders",
    displayName: "주문 조회",
    render: async (props, blockCtx) => {
      const path = String(blockCtx?.path ?? "").replace(/^\/+|\/+$/g, "");
      const tail = String(blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      /*
       * 주문번호는 두 길로 들어온다.
       *
       *   - 쇼핑몰 페이지가 있는 사이트: `/shop` 라우터가 props 로 준다.
       *   - 페이지 없이 **선언 화면**(shop/orders)만 있는 사이트: pathTail 이
       *     곧 주문번호다.
       *
       * 두 번째를 읽지 않아서, 선언 화면만 쓰는 사이트에서는 주문 상세가
       * 아예 열리지 않았다 — 주소를 정확히 쳐도 목록이 다시 나왔다. 상세에
       * 붙어 있는 것(입금 계좌 · 청약철회 · 현금영수증)도 전부 닿지 않았다.
       */
      const fromRouter = props.orderNo !== undefined;
      let orderNo = String((fromRouter ? props.orderNo : tail) ?? "").trim();
      if (!fromRouter && orderNo.includes("/")) orderNo = "";
      /*
       * 목록 주소 = 지금 경로에서 주문번호를 뗀 것.
       *
       * 예전에는 "블록이 올라간 페이지" 를 base 로 잡고 거기에 `/orders` 를
       * 덧붙였는데, 선언 화면은 **이미 그 경로에 올라가 있다.** 그래서 목록의
       * 링크가 /shop/orders/orders/… 라는 없는 주소가 됐다.
       */
      const listUrl = `/${
        orderNo && path.endsWith(orderNo)
          ? path.slice(0, path.length - orderNo.length).replace(/\/+$/g, "")
          : path || "shop/orders"
      }`;

      /*
       * 선언 화면으로 들어오면 제목을 여기서 정해야 한다 — `/shop` 라우터는
       * 호출 전에 정해 주지만(blocks.ts), 선언 화면은 등록된 제목("주문 내역")을
       * 그대로 쓴다. 상세를 열었는데 문서 제목과 h1 이 "주문 내역" 이면 어느
       * 화면인지 알 수 없다.
       */
      if (!fromRouter) {
        blockCtx?.setSeo?.({ title: t(orderNo ? "orders.detailTitle" : "orders.title") });
      }

      if (orderNo) {
        // ── 상세 ──
        return `
<div class="brick-orders" id="brick-order-detail" data-base="${escapeHtml(listUrl)}" data-order-no="${escapeHtml(orderNo)}">
  <p><a href="${escapeHtml(listUrl)}">← ${escapeHtml(t("orders.backToList"))}</a></p>
  <div id="brick-order-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${await gatewayScripts()}${detailScript(t, statusLabels())}${ORDERS_CSS}`;
      }

      // ── 목록 (회원) / 주문번호 조회 (비회원) ──
      return `
<div class="brick-orders" id="brick-order-list" data-base="${escapeHtml(listUrl)}" data-guest="${blockCtx?.user ? "0" : "1"}">
  <div id="brick-orders-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${listScript(t, statusLabels())}${ORDERS_CSS}`;
    },
  };
  ctx.registerBlock(ordersBlock);
  return ordersBlock;
}

const ORDERS_CSS = `
<style>
.brick-o-banknote{display:block;margin-top:4px;font-size:12.5px;color:var(--color-muted, #6c6c7a)}
.brick-o-payagain{margin:14px 0}
.brick-o-payagain.is-error{color:var(--color-danger, #c8322f);font-weight:600}
.brick-o-paymsg{margin-left:8px;font-size:13.5px}
.brick-orders { max-width: 720px; }
.brick-orders table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.brick-orders td, .brick-orders th { padding: 10px 8px; border-bottom: 1px solid var(--color-line, #e7e7ec); text-align: left; }
.brick-orders .brick-o-total { text-align: right; white-space: nowrap; }
.brick-o-status { display: inline-block; font-size: 12.5px; padding: 3px 9px; border-radius: 999px; background: var(--color-bg-soft, #f7f7f9); border: 1px solid var(--color-line, #e7e7ec); }
.brick-o-lookup { display: flex; gap: 8px; max-width: 460px; margin-top: 10px; }
.brick-o-lookup input { flex: 1; }
.brick-o-meta { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; margin: 14px 0; font-size: 14.5px; }
.brick-o-meta dt { color: var(--color-muted, #71717d); }
.brick-o-meta dd { margin: 0; }
.brick-o-history { font-size: 13.5px; color: var(--color-muted, #71717d); }
.brick-ret { margin-top: 22px; border: 1px solid var(--color-line, #e7e7ec); border-radius: 10px; padding: 12px 16px; }
.brick-ret summary { cursor: pointer; font-weight: 600; }
.brick-ret h4 { margin: 14px 0 6px; font-size: 14px; }
.brick-ret-kinds { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
.brick-ret-kind { display: flex; gap: 6px; align-items: center; }
.brick-ret-form select, .brick-ret-form input[name=detail] { width: 100%; max-width: 420px; }
.brick-ret-note { font-size: 13px; color: var(--color-muted, #71717d); margin: 8px 0; }
.brick-ret-msg { margin-left: 10px; font-size: 13.5px; color: var(--color-danger, #c9342f); }
.brick-ret-done { padding: 14px; background: var(--color-bg-soft, #f7f7f9); border-radius: 10px; margin-top: 18px; }
.brick-receipt { margin-top: 14px; border: 1px solid var(--color-line, #e7e7ec); border-radius: 10px; padding: 12px 16px; }
.brick-receipt summary { cursor: pointer; font-weight: 600; }
.brick-receipt h4 { margin: 14px 0 6px; font-size: 14px; }
.brick-receipt-kinds { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
.brick-receipt-kind { display: flex; gap: 6px; align-items: center; }
.brick-receipt-form input[name=identifier] { width: 100%; max-width: 420px; }
.brick-receipt-note { font-size: 13px; color: var(--color-muted, #71717d); margin: 8px 0; }
.brick-receipt-msg { margin-left: 10px; font-size: 13.5px; color: var(--color-danger, #c9342f); }
.brick-receipt-done { padding: 14px; background: var(--color-bg-soft, #f7f7f9); border-radius: 10px; margin-top: 14px; }
.brick-ret-mine { margin-top: 22px; }
.brick-ret-mine h3 { font-size: 15px; margin: 0 0 8px; }
.brick-ret-mine table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.brick-ret-mine th, .brick-ret-mine td { padding: 7px 6px; border-bottom: 1px solid var(--color-line, #e7e7ec); text-align: left; vertical-align: top; }
.brick-ret-mine th { color: var(--color-muted, #71717d); font-weight: 600; }
.brick-ret-mine small { color: var(--color-muted, #71717d); }
/* 44px — 폰에서 신청을 물리는 버튼이다. 빗나가면 옆줄의 다른 요청을 누른다 */
.brick-ret-drop { min-height: 40px; padding: 0 12px; cursor: pointer; font: inherit; font-size: 13px; }
/* 목록 표는 폰에서 카드로 접는다 — 맨 뒤에 와야 위의 표 규칙을 덮는다 */
${STACK_TABLE_CSS}
</style>`;

/** 목록 화면 — 회원이면 /my/orders, 401 이면 비회원 조회 폼 */
const listScript = (t: (k: string) => string, labels: string) => `
<script>
(function(){
  var root = document.getElementById('brick-order-list');
  if (!root) return;
  var body = document.getElementById('brick-orders-body');
  var base = root.dataset.base;
  var LABEL = ${labels};
  ${moneyFnScript("fmt")}
  var TAG = ${JSON.stringify(localeTag())};  // 날짜도 사이트 언어를 따른다
  ${dateOptsScript()}  // …그리고 사이트 시간대를 따른다
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function guestForm(){
    body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.guestPrompt"))} + '</p>' +
      '<form class="brick-o-lookup"><input required placeholder="' + ${JSON.stringify(t("orders.orderNoPlaceholder"))} + '" />' +
      '<button class="brick-primary" type="submit">' + ${JSON.stringify(t("orders.lookup"))} + '</button></form>';
    body.querySelector('form').addEventListener('submit', function(e){
      e.preventDefault();
      var no = body.querySelector('input').value.trim();
      if (no) location.href = base + '/' + encodeURIComponent(no);
    });
  }

  if (root.dataset.guest === '1') { guestForm(); return; }
  fetch('/api/plugins/brick-shop/my/orders')
    .then(function(r){
      if (r.status === 401) { guestForm(); return null; }
      return r.json();
    })
    .then(function(d){
      if (!d) return;
      if (!d.items || !d.items.length) {
        body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.empty"))} + '</p>';
        return;
      }
      /* 칸 이름은 머리글과 접힌 카드의 제목(data-label)에 같이 쓴다 */
      var C_DATE = ${JSON.stringify(t("orders.colDate"))};
      var C_ITEMS = ${JSON.stringify(t("orders.colItems"))};
      var C_TOTAL = ${JSON.stringify(t("orders.colTotal"))};
      var C_STATUS = ${JSON.stringify(t("orders.colStatus"))};
      var rows = d.items.map(function(o){
        return '<tr>' +
          '<td data-label="' + C_DATE + '">' + new Date(o.created_at).toLocaleDateString(TAG, DATE_OPTS) + '</td>' +
          '<td data-label="' + C_ITEMS + '"><a href="' + base + '/' + encodeURIComponent(o.order_no) + '">' + esc(o.order_no) + '</a><br />' +
          '<small>' + esc(o.items_summary || '') + '</small></td>' +
          '<td class="brick-o-total" data-label="' + C_TOTAL + '">' + fmt(o.total) + '</td>' +
          '<td data-label="' + C_STATUS + '"><span class="brick-o-status">' + esc(LABEL[o.status] || o.status) + '</span></td>' +
        '</tr>';
      }).join('');
      body.innerHTML = '<table class="brick-stack-table"><thead><tr>' +
        '<th>' + C_DATE + '</th>' +
        '<th>' + C_ITEMS + '</th>' +
        '<th class="brick-o-total">' + C_TOTAL + '</th>' +
        '<th>' + C_STATUS + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    })
    .catch(function(){ body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.notFound"))} + '</p>'; });
})();
</script>`;

/**
 * 상세 화면 — 회원 쿠키로 시도, 실패하면 guestToken 으로 재시도.
 *
 * 토큰은 **주소에서도** 읽는다. 예전에는 이 기기의 localStorage 만 봤는데, 그러면
 * 주문 안내 메일의 링크를 다른 기기(대개 폰)에서 열면 아무것도 보이지 않는다 —
 * 서버는 `?token=` 을 받는데 화면이 그것을 쓰지 않았다. 주소로 들어온 토큰은
 * localStorage 에도 넣어 그 기기에서 다음 조회가 되게 한다.
 */
const detailScript = (t: (k: string, p?: Record<string, string | number>) => string, labels: string) => `
<script>
(function(){
  var root = document.getElementById('brick-order-detail');
  if (!root) return;

  /** 이 주문을 볼 수 있는 토큰 — 주소가 먼저, 없으면 이 기기에 저장된 것 */
  function guestToken(){
    var fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) {
      try { localStorage.setItem('brick_shop_guest', fromUrl); } catch (e) { /* 사생활 보호 모드 */ }
      return fromUrl;
    }
    try { return localStorage.getItem('brick_shop_guest'); } catch (e) { return null; }
  }
  var body = document.getElementById('brick-order-body');
  var no = root.dataset.orderNo;
  var LABEL = ${labels};
  ${moneyFnScript("fmt")}
  var TAG = ${JSON.stringify(localeTag())};  // 날짜도 사이트 언어를 따른다
  ${dateOptsScript()}  // …그리고 사이트 시간대를 따른다
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function load(withToken){
    var guest = guestToken();
    var url = '/api/plugins/brick-shop/orders/' + encodeURIComponent(no) +
      (withToken && guest ? '?token=' + encodeURIComponent(guest) : '');
    return fetch(url).then(function(r){ return r.ok ? r.json() : null; });
  }

  /**
   * 현금영수증.
   *
   * 신청 가능 여부는 **서버가 판단해 준다**(cashReceipt). 규칙이 여기에도 있으면
   * 둘이 갈라져서, 못 하는 주문에 폼을 내밀거나 할 수 있는데 안 내밀게 된다.
   */
  /** 이 주문에 낸 요청 목록 — 상태와 환불액, 그리고 철회 버튼 */
  function renderMyRequests(slot, orderNo, list, q, notice){
    if (!list.length) return;
    var R_NO = ${JSON.stringify(t("ret.colNo"))};
    var R_KIND = ${JSON.stringify(t("ret.colKind"))};
    var R_STATUS = ${JSON.stringify(t("ret.colStatus"))};
    var R_REFUND = ${JSON.stringify(t("ret.colRefund"))};
    var rows = list.map(function(r){
      var refund = Number(r.refund_amount || 0);
      return '<tr>' +
        '<td data-label="' + R_NO + '">' + esc(r.return_no) + '<br /><small>' +
          new Date(r.created_at).toLocaleDateString(TAG, DATE_OPTS) + '</small></td>' +
        '<td data-label="' + R_KIND + '">' + esc(r.kind_label) + '<br /><small>' + esc(r.reason_label || '') + '</small></td>' +
        '<td data-label="' + R_STATUS + '">' + esc(r.status_label) + '</td>' +
        '<td class="brick-o-total" data-label="' + R_REFUND + '">' + (refund > 0 ? fmt(refund) : '—') + '</td>' +
        '<td data-label="">' + (r.cancellable
          ? '<button type="button" class="brick-ret-drop" data-ret-id="' + esc(r.id) + '">' +
            ${JSON.stringify(t("ret.cancelRequest"))} + '</button>'
          : '') + '</td>' +
        '</tr>';
    }).join('');

    slot.insertAdjacentHTML('beforeend',
      '<section class="brick-ret-mine"><h3>' + ${JSON.stringify(t("ret.myRequests"))} + '</h3>' +
      '<table class="brick-stack-table"><thead><tr>' +
      '<th>' + R_NO + '</th>' +
      '<th>' + R_KIND + '</th>' +
      '<th>' + R_STATUS + '</th>' +
      '<th class="brick-o-total">' + R_REFUND + '</th>' +
      '<th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="brick-ret-msg" role="status" data-ret-drop-msg></p></section>');

    var msg = slot.querySelector('[data-ret-drop-msg]');
    if (notice) msg.textContent = notice;
    slot.querySelectorAll('.brick-ret-drop').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (!confirm(${JSON.stringify(t("ret.cancelConfirm"))})) return;
        btn.disabled = true;
        fetch('/api/plugins/brick-shop/returns/' + encodeURIComponent(btn.dataset.retId) + '/cancel' + q,
          { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) {
              btn.disabled = false;
              msg.textContent = res.d.message || ${JSON.stringify(t("ret.cancelFail"))};
              return;
            }
            renderReturnSection(orderNo, ${JSON.stringify(t("ret.cancelled"))});
          })
          .catch(function(){ btn.disabled = false; msg.textContent = ${JSON.stringify(t("ret.cancelFail"))}; });
      });
    });
  }

  function renderReceiptSection(orderNo, info){
    var slot = document.getElementById('brick-receipt-slot');
    if (!slot || !info) return;

    if (info.issued) {
      var done = info.issued.status === 'issued'
        ? ${JSON.stringify(t("receipt.issued"))}
        : ${JSON.stringify(t("receipt.pending"))};
      slot.innerHTML = '<p class="brick-receipt-done">' + esc(done) + ' ' + esc(info.issued.identifier) +
        (info.issued.approvalNo
          ? ' · ' + ${JSON.stringify(t("receipt.approvalNo"))} + ' ' + esc(info.issued.approvalNo)
          : '') + '</p>';
      return;
    }
    // 신청할 수 없는 주문에는 아무것도 내밀지 않는다 — 이유는 서버가 알고 있고,
    // 카드 주문에 "발급 안 됩니다" 를 띄우면 없던 걱정을 만든다
    if (!info.available) return;

    var q = (function(){ var g = guestToken(); return g ? ('?token=' + encodeURIComponent(g)) : ''; })();
    slot.innerHTML =
      '<details class="brick-receipt"><summary>' + ${JSON.stringify(t("receipt.request"))} + '</summary>' +
      '<p class="brick-receipt-note">' + ${JSON.stringify(t("receipt.notice"))} + '</p>' +
      '<form class="brick-receipt-form">' +
      '<h4 id="brick-rc-kind-label">' + ${JSON.stringify(t("receipt.kind"))} + '</h4>' +
      '<div class="brick-receipt-kinds" role="radiogroup" aria-labelledby="brick-rc-kind-label"></div>' +
      '<h4 id="brick-rc-id-label">' + ${JSON.stringify(t("receipt.identifier"))} + '</h4>' +
      '<input name="identifier" required maxlength="40" aria-labelledby="brick-rc-id-label" ' +
      'aria-describedby="brick-rc-id-hint" />' +
      '<p class="brick-receipt-note" id="brick-rc-id-hint">' +
      ${JSON.stringify(t("receipt.identifierIncome"))} + '</p>' +
      '<button type="submit" class="brick-primary">' + ${JSON.stringify(t("receipt.submit"))} + '</button>' +
      '<span class="brick-receipt-msg" role="status"></span>' +
      '<p class="brick-receipt-note">' + ${JSON.stringify(t("receipt.legal"))} + '</p>' +
      '</form></details>';

    var form = slot.querySelector('.brick-receipt-form');
    var kinds = form.querySelector('.brick-receipt-kinds');
    var hint = form.querySelector('#brick-rc-id-hint');
    var msg = form.querySelector('.brick-receipt-msg');

    // 용도 목록은 서버에서 받는다 — 화면이 따로 적으면 코드가 갈라진다
    fetch('/api/plugins/brick-shop/tax/info').then(function(r){ return r.json(); })
      .then(function(d){
        kinds.innerHTML = (d.receiptKinds || []).map(function(k){
          return '<label class="brick-receipt-kind"><input type="radio" name="rc-kind" value="' +
            esc(k.code) + '" /> ' + esc(k.label) + '</label>';
        }).join('');
        // 용도에 따라 넣을 번호가 다르다 — 고르고 나서 알면 늦는다
        kinds.addEventListener('change', function(e){
          hint.textContent = e.target.value === 'expense_proof'
            ? ${JSON.stringify(t("receipt.identifierExpense"))}
            : ${JSON.stringify(t("receipt.identifierIncome"))};
        });
      })
      .catch(function(){});

    form.addEventListener('submit', function(e){
      e.preventDefault();
      var kindEl = form.querySelector('input[name=rc-kind]:checked');
      if (!kindEl) { msg.textContent = ${JSON.stringify(t("receipt.pickKind"))}; return; }
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg.textContent = ${JSON.stringify(t("receipt.submitting"))};
      fetch('/api/plugins/brick-shop/orders/' + encodeURIComponent(orderNo) + '/cash-receipt' + q, {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ kind: kindEl.value, identifier: form.querySelector('input[name=identifier]').value })
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(res){
          btn.disabled = false;
          if (!res.ok) { msg.textContent = res.d.message || ${JSON.stringify(t("receipt.fail"))}; return; }
          slot.innerHTML = '<p class="brick-receipt-done" role="status">' +
            esc(res.d.pending ? ${JSON.stringify(t("receipt.pending"))} : ${JSON.stringify(t("receipt.issued"))}) +
            (res.d.approvalNo ? ' · ' + ${JSON.stringify(t("receipt.approvalNo"))} + ' ' + esc(res.d.approvalNo) : '') +
            '</p>';
        })
        .catch(function(){ btn.disabled = false; msg.textContent = ${JSON.stringify(t("receipt.fail"))}; });
    });
  }

  /*
   * notice 는 **다시 그린 뒤에도 남아야 하는 말**이다. 신청 접수번호나 철회
   * 완료를 slot 에 써 놓고 다시 그리면 그 말이 같이 지워진다 — 화면은 바뀌는데
   * 무슨 일이 있었는지는 사라지고, 스크린리더에는 아무 일도 없었던 것이 된다.
   */
  function renderReturnSection(orderNo, notice){
    var slot = document.getElementById('brick-ret-slot');
    if (!slot) return;
    slot.innerHTML = '';  // 다시 그릴 때 겹쳐 쌓이지 않게
    var guest = guestToken();
    var q = guest ? ('?token=' + encodeURIComponent(guest)) : '';
    fetch('/api/plugins/brick-shop/orders/' + encodeURIComponent(orderNo) + '/returnable' + q)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(v){
        if (!v) return;
        /*
         * 이미 낸 요청부터 보여준다.
         *
         * 신청하고 나면 손님이 볼 수 있는 것이 없었다 — 새로고침하면 신청 폼만
         * 다시 나오고, 승인됐는지 거절됐는지 환불이 얼마인지 알 길이 없었다.
         * 신청 폼보다 **위에** 둔다: 지금 궁금한 것은 낸 것의 결과다.
         */
        renderMyRequests(slot, orderNo, v.requests || [], q, notice);

        if (!v.allowedKinds || !v.allowedKinds.length) return;
        var openable = (v.items || []).some(function(it){ return it.availableQty > 0; });
        if (!openable) return;

        var deadline = v.withdrawalDeadline
          ? '<p class="brick-ret-note">' + ${JSON.stringify(t("ret.withdrawalDeadline", { date: "__D__" }))}
              .replace('__D__', new Date(v.withdrawalDeadline).toLocaleDateString(TAG, DATE_OPTS)) + '</p>'
          : '';
        var expired = v.withdrawalExpired
          ? '<p class="brick-ret-note">' + ${JSON.stringify(t("ret.withdrawalExpired"))} + '</p>' : '';

        var kinds = v.allowedKinds.map(function(k){
          return '<label class="brick-ret-kind"><input type="radio" name="ret-kind" value="' + esc(k.code) + '" />' +
            esc(k.label) + '</label>';
        }).join('');

        var rows = (v.items || []).filter(function(it){ return it.availableQty > 0; }).map(function(it){
          return '<tr><td><label><input type="checkbox" data-ret-item="' + esc(it.orderItemId) + '" /> ' +
            esc(it.productName) + (it.optionName ? ' — ' + esc(it.optionName) : '') + '</label></td>' +
            '<td><input type="number" min="1" max="' + it.availableQty + '" value="' + it.availableQty +
            // 이름이 없으면 스크린리더에 "스핀 버튼" 으로만 읽힌다 — 상품이 여럿이면 어느 것인지 알 수 없다
            '" aria-label="' + esc(${JSON.stringify(t("ret.qtyLabel", { product: "__P__", max: "__M__" }))}
              .replace('__P__', it.productName).replace('__M__', it.availableQty)) +
            '" data-ret-qty="' + esc(it.orderItemId) + '" style="width:70px" /> / ' + it.availableQty + '</td></tr>';
        }).join('');

        slot.insertAdjacentHTML('beforeend',
          '<details class="brick-ret"><summary>' + ${JSON.stringify(t("ret.request"))} + '</summary>' +
          deadline + expired +
          '<form class="brick-ret-form">' +
          '<h4>' + ${JSON.stringify(t("ret.kind"))} + '</h4><div class="brick-ret-kinds">' + kinds + '</div>' +
          /*
           * 제목은 h4 로 크게 적혀 있는데 칸과 이어져 있지 않았다 — 눈으로는 보이지만
           * 스크린리더에는 "콤보 상자"·"편집" 으로만 읽힌다. 청약철회는 법이 보장하는
           * 권리이고, 그 신청 폼이 그랬다. 접힌 details 안이라 화면 감사 도구도
           * 보지 못하고 있었다.
           */
          '<h4 id="brick-ret-reason-label">' + ${JSON.stringify(t("ret.reason"))} + '</h4>' +
          '<select name="reason" required aria-labelledby="brick-ret-reason-label">' +
          '<option value="">—</option></select>' +
          '<h4 id="brick-ret-detail-label">' + ${JSON.stringify(t("ret.reasonDetail"))} + '</h4>' +
          '<input name="detail" maxlength="500" aria-labelledby="brick-ret-detail-label" />' +
          '<h4>' + ${JSON.stringify(t("ret.items"))} + '</h4>' +
          '<table><tbody>' + rows + '</tbody></table>' +
          '<p class="brick-ret-note" data-ret-payer></p>' +
          '<button type="submit" class="brick-primary">' + ${JSON.stringify(t("ret.submit"))} + '</button>' +
          '<span class="brick-ret-msg" role="status"></span>' +
          '</form></details>');

        var form = slot.querySelector('.brick-ret-form');
        var sel = form.querySelector('select[name=reason]');
        var payerNote = form.querySelector('[data-ret-payer]');
        var msg = form.querySelector('.brick-ret-msg');

        // 사유 목록 — 각 사유의 반송비 부담을 **미리** 보여준다.
        // 나중에 환불액이 깎여 있으면 분쟁이 된다.
        fetch('/api/plugins/brick-shop/returns/reasons').then(function(r){ return r.json(); })
          .then(function(d){
            sel.innerHTML = '<option value="">—</option>' + (d.items || []).map(function(it){
              return '<option value="' + esc(it.code) + '" data-payer="' + esc(it.shippingPayer) + '">' +
                esc(it.label) + '</option>';
            }).join('');
          });

        sel.addEventListener('change', function(){
          var opt = sel.options[sel.selectedIndex];
          var payer = opt && opt.dataset.payer;
          if (!payer) { payerNote.textContent = ''; return; }
          var who = payer === 'seller'
            ? ${JSON.stringify(t("ret.payerSeller"))}
            : ${JSON.stringify(t("ret.payerCustomer"))};
          payerNote.textContent = ${JSON.stringify(t("ret.shippingPayer"))} + ': ' + who +
            (payer === 'customer' && v.returnShippingFee
              ? ' · ' + ${JSON.stringify(t("ret.returnShippingNote", { amount: "__A__" }))}
                  .replace('__A__', Number(v.returnShippingFee).toLocaleString(${JSON.stringify(localeTag())}))
              : '');
        });

        form.addEventListener('submit', function(e){
          e.preventDefault();
          var kindEl = form.querySelector('input[name=ret-kind]:checked');
          if (!kindEl) { msg.textContent = ${JSON.stringify(t("ret.pickReason"))}; return; }
          if (!sel.value) { msg.textContent = ${JSON.stringify(t("ret.pickReason"))}; return; }
          var items = [];
          form.querySelectorAll('[data-ret-item]:checked').forEach(function(cb){
            var id = cb.dataset.retItem;
            var qtyEl = form.querySelector('[data-ret-qty="' + id + '"]');
            items.push({ orderItemId: id, quantity: Number(qtyEl.value) });
          });
          if (!items.length) { msg.textContent = ${JSON.stringify(t("ret.pickItem"))}; return; }

          var btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          msg.textContent = ${JSON.stringify(t("ret.submitting"))};
          fetch('/api/plugins/brick-shop/orders/' + encodeURIComponent(orderNo) + '/returns' + q, {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ kind: kindEl.value, reasonCode: sel.value,
              reason: form.querySelector('input[name=detail]').value || undefined, items: items })
          }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){
              btn.disabled = false;
              if (!res.ok) { msg.textContent = res.d.message || ${JSON.stringify(t("ret.fail"))}; return; }
              // 접수번호만 알려주고 끝내면 그 다음이 또 안 보인다 — 목록을 다시 그리되
              // 접수번호는 그 위에 남긴다
              renderReturnSection(orderNo,
                ${JSON.stringify(t("ret.done", { no: "__N__" }))}.replace('__N__', res.d.returnNo));
            })
            .catch(function(){ btn.disabled = false; msg.textContent = ${JSON.stringify(t("ret.fail"))}; });
        });
      })
      .catch(function(){});
  }

  /*
   * 결제창에서 돌아왔다 — 승인을 마치고 **상세를 다시 그린다.**
   *
   * 화면을 직접 고치지 않는 이유: 상태·이력·현금영수증 신청 가능 여부가 모두
   * 결제 여부에 딸려 있다. 서버에서 다시 받아 그리면 그것들이 저절로 맞는다.
   */
  function finishReturn(){
    var q = new URLSearchParams(location.search);
    var provider = q.get('brickPay');
    if (!provider || q.get('orderNo') !== no) return Promise.resolve(null);
    var pay = (window.brickPay || {})[provider];
    var got = pay && typeof pay.readReturn === 'function' ? pay.readReturn(q) : null;
    // 취소·실패로 돌아왔다 — 주문은 결제대기로 남는다. 아래에서 다시 결제할 수 있다.
    if (!got) return Promise.resolve(${JSON.stringify(t("orders.payCancelled"))});
    return fetch('/api/plugins/brick-shop/payments/confirm', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ orderNo: no, provider: provider, providerTid: got.providerTid, amount: got.amount })
    }).then(function(r){ return r.json().then(function(dd){ return r.ok ? null : (dd.message || ${JSON.stringify(t("orders.payFail"))}); }); })
      .catch(function(){ return ${JSON.stringify(t("orders.payFail"))}; });
  }

  finishReturn().then(function(returnNote){
  load(false).then(function(d){ return d || load(true); }).then(function(d){
    if (!d) {
      body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.notFound"))} +
        '<br /><small>' + ${JSON.stringify(t("orders.guestHint"))} + '</small></p>';
      return;
    }
    var o = d.order;
    var items = (d.items || []).map(function(it){
      return '<tr><td>' + esc(it.product_name) + (it.option_name ? ' — ' + esc(it.option_name) : '') +
        ' × ' + it.quantity + '</td><td class="brick-o-total">' + fmt(it.line_total) + '</td></tr>';
    }).join('');
    var history = (d.events || []).map(function(ev){
      return '<li>' + new Date(ev.created_at).toLocaleString(TAG, DATE_OPTS) + ' — ' +
        esc(LABEL[ev.to_status] || ev.to_status) + (ev.note ? ' (' + esc(ev.note) + ')' : '') + '</li>';
    }).join('');
    body.innerHTML =
      '<h2>' + esc(o.order_no) + ' <span class="brick-o-status">' + esc(LABEL[o.status] || o.status) + '</span></h2>' +
      '<table><tbody>' + items + '</tbody></table>' +
      '<dl class="brick-o-meta">' +
      '<dt>' + ${JSON.stringify(t("orders.colTotal"))} + '</dt><dd><strong>' + fmt(o.total) + '</strong></dd>' +
      '<dt>' + ${JSON.stringify(t("orders.receiver"))} + '</dt><dd>' + esc(o.receiver_name || '') + ' ' + esc(o.receiver_phone || '') + '</dd>' +
      '<dt>' + ${JSON.stringify(t("orders.address"))} + '</dt><dd>(' + esc(o.postcode || '') + ') ' + esc(o.address1 || '') + ' ' + esc(o.address2 || '') + '</dd>' +
      (o.delivery_memo ? '<dt>' + ${JSON.stringify(t("orders.memo"))} + '</dt><dd>' + esc(o.delivery_memo) + '</dd>' : '') +
      // 입금대기 무통장 주문에만 계좌가 함께 온다 — 어디에 넣어야 하는지 이 화면이 말해야 한다
      (d.bankAccount
        ? '<dt>' + ${JSON.stringify(t("orders.bankAccount"))} + '</dt><dd><strong>' + esc(d.bankAccount) + '</strong>' +
          '<small class="brick-o-banknote">' + ${JSON.stringify(t("orders.bankNote"))} + '</small></dd>'
        : '') +
      '</dl>' +
      (history ? '<h3>' + ${JSON.stringify(t("orders.history"))} + '</h3><ul class="brick-o-history">' + history + '</ul>' : '') +
      '<div id="brick-ret-slot"></div>' +
      '<div id="brick-receipt-slot"></div>';
    /*
     * 결제 다시 하기 — **서버가 된다고 한 주문에만** 낸다(d.payable).
     *
     * 카드로 주문했는데 결제창에서 취소하거나 실패하면 주문은 결제대기로 남는다.
     * 그때 다시 결제할 자리가 없어서, 손님이 할 수 있는 일은 다시 주문하는 것
     * 뿐이었다 — 앞의 주문은 미결제로 남고, 사업자는 유령 주문을 떠안는다.
     */
    if (d.payable) {
      var payBox = document.createElement('p');
      payBox.className = 'brick-o-payagain';
      payBox.innerHTML = '<button type="button" class="brick-primary" data-pay-again>' +
        ${JSON.stringify(t("orders.payAgain"))} + '</button> <span class="brick-o-paymsg" role="alert"></span>';
      body.insertBefore(payBox, document.getElementById('brick-ret-slot'));
      var payMsg = payBox.querySelector('.brick-o-paymsg');
      payBox.querySelector('[data-pay-again]').addEventListener('click', function(){
        var pay = (window.brickPay || {})[o.payment_method];
        if (typeof pay !== 'function') { payMsg.textContent = ${JSON.stringify(t("orders.payUnavailable"))}; return; }
        this.disabled = true;
        payMsg.textContent = ${JSON.stringify(t("checkout.payRedirect"))};
        var back = location.origin + location.pathname + '?brickPay=' + encodeURIComponent(o.payment_method) +
          '&orderNo=' + encodeURIComponent(o.order_no);
        Promise.resolve(pay({ orderNo: o.order_no, amount: Number(o.total), orderName: d.orderName || o.order_no, returnUrl: back }))
          .catch(function(){ payMsg.textContent = ${JSON.stringify(t("checkout.payFail"))}; payBox.querySelector('[data-pay-again]').disabled = false; });
      });
    }
    // 취소·반품 신청 — 신청 가능한 주문일 때만 버튼을 낸다.
    // 청약철회(전자상거래법 제17조)는 손님의 권리이므로 화면이 있어야 한다.
    renderReturnSection(o.order_no);
    // 현금영수증 신청 — 부가가치세법 제32조의2 도 손님의 권리다.
    // 발급 라우트는 처음부터 있었는데 신청할 자리가 없었다.
    renderReceiptSection(o.order_no, d.cashReceipt);
    if (returnNote) {
      var note = document.createElement('p');
      note.className = 'brick-o-payagain is-error';
      note.setAttribute('role', 'alert');
      note.textContent = returnNote;
      body.insertBefore(note, body.firstChild);
    }
  });
  });
})();
</script>`;
