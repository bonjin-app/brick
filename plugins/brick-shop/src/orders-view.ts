import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";

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
      const base = tail && path.endsWith(tail)
        ? `/${path.slice(0, path.length - tail.length).replace(/\/+$/g, "")}`
        : `/${path || "shop"}`;
      const orderNo = String(props.orderNo ?? "").trim();

      if (orderNo) {
        // ── 상세 ──
        return `
<div class="brick-orders" id="brick-order-detail" data-base="${escapeHtml(base)}" data-order-no="${escapeHtml(orderNo)}">
  <p><a href="${escapeHtml(base)}/orders">← ${escapeHtml(t("orders.backToList"))}</a></p>
  <div id="brick-order-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${detailScript(t, statusLabels())}${ORDERS_CSS}`;
      }

      // ── 목록 (회원) / 주문번호 조회 (비회원) ──
      return `
<div class="brick-orders" id="brick-order-list" data-base="${escapeHtml(base)}">
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
  function fmt(n){ return Number(n).toLocaleString('ko-KR') + '원'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function guestForm(){
    body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.guestPrompt"))} + '</p>' +
      '<form class="brick-o-lookup"><input required placeholder="' + ${JSON.stringify(t("orders.orderNoPlaceholder"))} + '" />' +
      '<button class="brick-primary" type="submit">' + ${JSON.stringify(t("orders.lookup"))} + '</button></form>';
    body.querySelector('form').addEventListener('submit', function(e){
      e.preventDefault();
      var no = body.querySelector('input').value.trim();
      if (no) location.href = base + '/orders/' + encodeURIComponent(no);
    });
  }

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
      var rows = d.items.map(function(o){
        return '<tr>' +
          '<td>' + new Date(o.created_at).toLocaleDateString() + '</td>' +
          '<td><a href="' + base + '/orders/' + encodeURIComponent(o.order_no) + '">' + esc(o.order_no) + '</a><br />' +
          '<small>' + esc(o.items_summary || '') + '</small></td>' +
          '<td class="brick-o-total">' + fmt(o.total) + '</td>' +
          '<td><span class="brick-o-status">' + esc(LABEL[o.status] || o.status) + '</span></td>' +
        '</tr>';
      }).join('');
      body.innerHTML = '<table><thead><tr>' +
        '<th>' + ${JSON.stringify(t("orders.colDate"))} + '</th>' +
        '<th>' + ${JSON.stringify(t("orders.colItems"))} + '</th>' +
        '<th class="brick-o-total">' + ${JSON.stringify(t("orders.colTotal"))} + '</th>' +
        '<th>' + ${JSON.stringify(t("orders.colStatus"))} + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    })
    .catch(function(){ body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.notFound"))} + '</p>'; });
})();
</script>`;

/** 상세 화면 — 회원 쿠키로 시도, 실패하면 이 기기의 guestToken 으로 재시도 */
const detailScript = (t: (k: string) => string, labels: string) => `
<script>
(function(){
  var root = document.getElementById('brick-order-detail');
  if (!root) return;
  var body = document.getElementById('brick-order-body');
  var no = root.dataset.orderNo;
  var LABEL = ${labels};
  function fmt(n){ return Number(n).toLocaleString('ko-KR') + '원'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function load(withToken){
    var guest = localStorage.getItem('brick_shop_guest');
    var url = '/api/plugins/brick-shop/orders/' + encodeURIComponent(no) +
      (withToken && guest ? '?token=' + encodeURIComponent(guest) : '');
    return fetch(url).then(function(r){ return r.ok ? r.json() : null; });
  }

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
      return '<li>' + new Date(ev.created_at).toLocaleString() + ' — ' +
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
      '</dl>' +
      (history ? '<h3>' + ${JSON.stringify(t("orders.history"))} + '</h3><ul class="brick-o-history">' + history + '</ul>' : '');
  });
})();
</script>`;
