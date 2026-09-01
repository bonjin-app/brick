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
.brick-ret { margin-top: 22px; border: 1px solid var(--color-line, #e7e7ec); border-radius: 10px; padding: 12px 16px; }
.brick-ret summary { cursor: pointer; font-weight: 600; }
.brick-ret h4 { margin: 14px 0 6px; font-size: 14px; }
.brick-ret-kinds { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
.brick-ret-kind { display: flex; gap: 6px; align-items: center; }
.brick-ret-form select, .brick-ret-form input[name=detail] { width: 100%; max-width: 420px; }
.brick-ret-note { font-size: 13px; color: var(--color-muted, #71717d); margin: 8px 0; }
.brick-ret-msg { margin-left: 10px; font-size: 13.5px; color: var(--color-danger, #c9342f); }
.brick-ret-done { padding: 14px; background: var(--color-bg-soft, #f7f7f9); border-radius: 10px; margin-top: 18px; }
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
const detailScript = (t: (k: string, p?: Record<string, string | number>) => string, labels: string) => `
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

  function renderReturnSection(orderNo){
    var slot = document.getElementById('brick-ret-slot');
    if (!slot) return;
    var guest = localStorage.getItem('brick_shop_guest');
    var q = guest ? ('?token=' + encodeURIComponent(guest)) : '';
    fetch('/api/plugins/brick-shop/orders/' + encodeURIComponent(orderNo) + '/returnable' + q)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(v){
        if (!v || !v.allowedKinds || !v.allowedKinds.length) return;
        var openable = (v.items || []).some(function(it){ return it.availableQty > 0; });
        if (!openable) return;

        var deadline = v.withdrawalDeadline
          ? '<p class="brick-ret-note">' + ${JSON.stringify(t("ret.withdrawalDeadline", { date: "__D__" }))}
              .replace('__D__', new Date(v.withdrawalDeadline).toLocaleDateString()) + '</p>'
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
            '" data-ret-qty="' + esc(it.orderItemId) + '" style="width:70px" /> / ' + it.availableQty + '</td></tr>';
        }).join('');

        slot.innerHTML =
          '<details class="brick-ret"><summary>' + ${JSON.stringify(t("ret.request"))} + '</summary>' +
          deadline + expired +
          '<form class="brick-ret-form">' +
          '<h4>' + ${JSON.stringify(t("ret.kind"))} + '</h4><div class="brick-ret-kinds">' + kinds + '</div>' +
          '<h4>' + ${JSON.stringify(t("ret.reason"))} + '</h4><select name="reason" required><option value="">—</option></select>' +
          '<h4>' + ${JSON.stringify(t("ret.reasonDetail"))} + '</h4><input name="detail" maxlength="500" />' +
          '<h4>' + ${JSON.stringify(t("ret.items"))} + '</h4>' +
          '<table><tbody>' + rows + '</tbody></table>' +
          '<p class="brick-ret-note" data-ret-payer></p>' +
          '<button type="submit" class="brick-primary">' + ${JSON.stringify(t("ret.submit"))} + '</button>' +
          '<span class="brick-ret-msg" role="status"></span>' +
          '</form></details>';

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
                  .replace('__A__', Number(v.returnShippingFee).toLocaleString('ko-KR'))
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
              slot.innerHTML = '<p class="brick-ret-done">' +
                ${JSON.stringify(t("ret.done", { no: "__N__" }))}.replace('__N__', esc(res.d.returnNo)) + '</p>';
            })
            .catch(function(){ btn.disabled = false; msg.textContent = ${JSON.stringify(t("ret.fail"))}; });
        });
      })
      .catch(function(){});
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
      (history ? '<h3>' + ${JSON.stringify(t("orders.history"))} + '</h3><ul class="brick-o-history">' + history + '</ul>' : '') +
      '<div id="brick-ret-slot"></div>';
    // 취소·반품 신청 — 신청 가능한 주문일 때만 버튼을 낸다.
    // 청약철회(전자상거래법 제17조)는 손님의 권리이므로 화면이 있어야 한다.
    renderReturnSection(o.order_no);
  });
})();
</script>`;
