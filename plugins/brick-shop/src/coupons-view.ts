import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";

/**
 * 쿠폰함 화면.
 *
 * `GET /me/coupons` 는 처음부터 있었고 상태(`usable`/`used`/`expired`/`inactive`)까지
 * 계산해서 주고 있었다 — 그 코드의 주석은 "화면이 '왜 못 쓰는지'를 보여줘야 한다"고
 * 적고 있었다. 그런데 **그 화면이 없었다.** 블록도, 페이지도, 링크도 없었다.
 *
 * 그 사이 생일 쿠폰 스윕은 회원 쿠폰함에 쿠폰을 자동으로 넣고 있었다. 받은 사람은
 * 그것을 볼 방법이 없었다 — 주문서에서 코드를 직접 입력해야 쓸 수 있었고, 코드를
 * 알 길이 없었다.
 *
 * 내용이 회원별이므로 골격만 서버 렌더하고 목록은 클라이언트가 가져온다
 * (비로그인 렌더만 캐시되므로 남의 쿠폰이 캐시에 실릴 일은 없다).
 */
export function registerCouponsView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const couponsBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "my-coupons",
    displayName: "쿠폰함",
    render: async (_props, blockCtx) => {
      if (!blockCtx.user) {
        return `<div class="brick-coupons"><p class="brick-shop-empty">${
          escapeHtml(t("coupons.loginRequired"))
        } <a href="/login">${escapeHtml(t("coupons.login"))}</a></p></div>${COUPON_CSS}`;
      }
      return `
<div class="brick-coupons" id="brick-coupons">
  <div id="brick-coupons-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${couponScript(t)}${COUPON_CSS}`;
    },
  };
  ctx.registerBlock(couponsBlock);
  return { couponsBlock };
}

const COUPON_CSS = `
<style>
.brick-coupon-list { display: grid; gap: 12px; }
.brick-coupon {
  display: flex; gap: 16px; align-items: center; padding: 16px 18px;
  border: 1px solid var(--brick-border, #e5e5ea); border-radius: 12px;
}
.brick-coupon-amount { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; min-width: 96px; }
.brick-coupon-body { flex: 1; min-width: 0; }
.brick-coupon-body strong { display: block; font-size: 15.5px; }
.brick-coupon-body span { display: block; margin-top: 3px; font-size: 13px; color: var(--color-muted, #6c6c7a); }
.brick-coupon-code {
  font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; letter-spacing: 1px;
  background: var(--color-bg-soft, #f6f6f9); padding: 2px 7px; border-radius: 5px;
}
.brick-coupon-state { font-size: 12.5px; font-weight: 700; white-space: nowrap; }
/* 쓸 수 없는 쿠폰은 흐리게 — 목록에서 쓸 수 있는 것이 먼저 눈에 들어와야 한다 */
.brick-coupon.is-dead { opacity: .55; }
.brick-coupon.is-dead .brick-coupon-amount { font-weight: 600; }
.brick-coupon-state.usable { color: var(--brick-accent, #0a7); }
.brick-coupon-state.used, .brick-coupon-state.expired, .brick-coupon-state.inactive { color: var(--color-muted, #6c6c7a); }
</style>`;

const couponScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function () {
  var root = document.getElementById('brick-coupons');
  if (!root) return;
  var body = document.getElementById('brick-coupons-body');
  var LABEL = ${JSON.stringify({
    usable: t("coupons.usable"),
    used: t("coupons.used"),
    expired: t("coupons.expired"),
    inactive: t("coupons.inactive"),
  })};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function won(n) { return Number(n).toLocaleString('ko-KR') + ${JSON.stringify(t("common.won"))}; }

  fetch('/api/plugins/brick-shop/me/coupons')
    .then(function (r) { return r.ok ? r.json() : { items: [] }; })
    .then(function (d) {
      var items = d.items || [];
      if (!items.length) {
        body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("coupons.empty"))} + '</p>';
        return;
      }
      body.innerHTML = '<div class="brick-coupon-list">' + items.map(function (c) {
        // 정률은 %, 정액은 금액 — 손님이 "얼마 깎이는지"를 먼저 봐야 한다
        var amount = c.discountType === 'percent'
          ? Number(c.discountValue) + '%'
          : won(c.discountValue);
        var notes = [];
        if (c.minAmount > 0) notes.push(${JSON.stringify(t("coupons.minAmount", { amount: "__A__" }))}.replace('__A__', won(c.minAmount)));
        if (c.maxDiscount) notes.push(${JSON.stringify(t("coupons.maxDiscount", { amount: "__A__" }))}.replace('__A__', won(c.maxDiscount)));
        if (c.endsAt) notes.push(${JSON.stringify(t("coupons.until", { date: "__D__" }))}.replace('__D__', new Date(c.endsAt).toLocaleDateString()));
        if (c.status === 'used' && c.usedOrderNo) {
          notes.push(${JSON.stringify(t("coupons.usedOn", { orderNo: "__O__" }))}.replace('__O__', esc(c.usedOrderNo)));
        }
        return '<div class="brick-coupon' + (c.status === 'usable' ? '' : ' is-dead') + '">' +
          '<span class="brick-coupon-amount">' + amount + '</span>' +
          '<span class="brick-coupon-body"><strong>' + esc(c.name) + '</strong>' +
          '<span><span class="brick-coupon-code">' + esc(c.code) + '</span>' +
          (notes.length ? ' · ' + notes.join(' · ') : '') + '</span></span>' +
          '<span class="brick-coupon-state ' + esc(c.status) + '">' + (LABEL[c.status] || '') + '</span>' +
          '</div>';
      }).join('') + '</div>';
    })
    .catch(function () {
      body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("coupons.fail"))} + '</p>';
    });
})();
</script>`;
