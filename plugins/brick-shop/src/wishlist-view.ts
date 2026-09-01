import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml } from "@brick/plugin-sdk";

/**
 * 위시리스트 · 최근 본 상품 화면.
 *
 * 두 API(/wishlist, /recent-views)는 처음부터 있었지만 **화면이 없었다** —
 * 담아둔 상품을 다시 볼 방법이 없으니 담는 기능도 반쪽이었다.
 *
 * 비회원도 쓴다(주문 전에 담아두는 것이 위시리스트의 본질이므로) —
 * localStorage 의 guestToken 으로 조회하고, 로그인하면 이어받는다.
 * 그래서 골격만 서버 렌더하고 목록은 클라이언트가 가져온다.
 */
export function registerWishlistView(
  ctx: PluginContext,
  t: (k: string, p?: Record<string, string | number>) => string,
) {
  const shopBase = (blockCtx?: { path?: string; pathTail?: string }) => {
    const path = String(blockCtx?.path ?? "").replace(/^\/+|\/+$/g, "");
    const tail = String(blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
    return tail && path.endsWith(tail)
      ? `/${path.slice(0, path.length - tail.length).replace(/\/+$/g, "")}`
      : `/${path || "shop"}`;
  };

  const wishlistBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "wishlist",
    displayName: "위시리스트",
    render: async (_props, blockCtx) => `
<div class="brick-wish" id="brick-wish" data-base="${escapeHtml(shopBase(blockCtx))}">
  <div id="brick-wish-body"><p class="brick-shop-empty">${escapeHtml(t("orders.loading"))}</p></div>
</div>
${wishScript(t)}${WISH_CSS}`,
  };

  /** 최근 본 상품 — 홈이나 상세 아래에 놓는 위젯 성격 */
  const recentBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "recent-views",
    displayName: "최근 본 상품",
    propsSchema: {
      type: "object",
      properties: {
        limit: { type: "number", title: "표시 개수", default: 6 },
        title: { type: "string", title: "제목 (비우면 표시 안 함)" },
      },
    },
    render: async (props, blockCtx) => {
      const limit = Math.min(20, Math.max(1, Number(props.limit ?? 6)));
      const heading = props.title === undefined ? t("recent.title") : String(props.title);
      return `
<div class="brick-recent" id="brick-recent" data-base="${escapeHtml(shopBase(blockCtx))}" data-limit="${limit}"
     data-heading="${escapeHtml(heading)}">
  <div id="brick-recent-body"></div>
</div>
${recentScript(t)}${WISH_CSS}`;
    },
  };

  ctx.registerBlock(wishlistBlock);
  ctx.registerBlock(recentBlock);
  return { wishlistBlock, recentBlock };
}

const WISH_CSS = `
<style>
.brick-wish-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
.brick-wish-card { position: relative; }
.brick-wish-card a { text-decoration: none; color: inherit; display: block; }
.brick-wish-thumb { aspect-ratio: 1; background: var(--color-bg-soft, #f7f7f9); border-radius: 10px; overflow: hidden; display: grid; place-items: center; }
.brick-wish-thumb img { width: 100%; height: 100%; object-fit: cover; }
.brick-wish-name { margin: 8px 0 2px; font-size: 14px; line-height: 1.4; }
.brick-wish-price { font-weight: 700; font-size: 14.5px; }
.brick-wish-badge { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,.66); color: #fff; font-size: 12px; padding: 3px 8px; border-radius: 6px; }
.brick-wish-del { position: absolute; top: 6px; right: 6px; border: 0; background: rgba(255,255,255,.9); border-radius: 6px; font-size: 12px; padding: 4px 8px; cursor: pointer; }
.brick-wish-hint { font-size: 13px; color: var(--color-muted, #71717d); margin: 10px 0 0; }
.brick-recent h3 { font-size: 17px; margin: 30px 0 12px; }
</style>`;

/** 공용 카드 렌더 — 두 화면이 같은 모양을 쓴다 */
const cardHelpers = (t: (k: string, p?: Record<string, string | number>) => string) => `
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmt(n){ return Number(n).toLocaleString('ko-KR') + '원'; }
  function card(p, base, withDelete){
    var soldout = p.status === 'soldout' || p.stock === 0;
    var gone = p.status && p.status !== 'selling' && p.status !== 'soldout';
    var badge = gone ? ${JSON.stringify(t("wish.unavailable"))} : (soldout ? ${JSON.stringify(t("wish.soldout"))} : '');
    return '<div class="brick-wish-card">' +
      (withDelete ? '<button type="button" class="brick-wish-del" data-del="' + esc(p.product_id || p.productId) + '">' +
        ${JSON.stringify(t("wish.remove"))} + '</button>' : '') +
      '<a href="' + base + '/' + esc(p.slug) + '">' +
      '<div class="brick-wish-thumb">' +
      (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.name) + '" loading="lazy" />' : '') +
      (badge ? '<span class="brick-wish-badge">' + badge + '</span>' : '') +
      '</div>' +
      '<p class="brick-wish-name">' + esc(p.name) + '</p>' +
      '<p class="brick-wish-price">' + fmt(p.price) + '</p>' +
      '</a></div>';
  }`;

const wishScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-wish');
  if (!root) return;
  var body = document.getElementById('brick-wish-body');
  var base = root.dataset.base;
  var guest = localStorage.getItem('brick_shop_guest');
  var q = guest ? ('?guest=' + encodeURIComponent(guest)) : '';
${cardHelpers(t)}

  function load(){
    fetch('/api/plugins/brick-shop/wishlist' + q)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.items || !d.items.length) {
          body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("wish.empty"))} + '</p>';
          return;
        }
        body.innerHTML = '<div class="brick-wish-grid">' +
          d.items.map(function(p){ return card(p, base, true); }).join('') + '</div>' +
          (guest ? '<p class="brick-wish-hint">' + ${JSON.stringify(t("wish.loginHint"))} + '</p>' : '');
        body.querySelectorAll('[data-del]').forEach(function(btn){
          btn.addEventListener('click', function(e){
            e.preventDefault();
            fetch('/api/plugins/brick-shop/wishlist/' + encodeURIComponent(btn.dataset.del) + q,
              { method: 'DELETE' }).then(load);
          });
        });
      })
      .catch(function(){ body.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("orders.notFound"))} + '</p>'; });
  }
  load();
})();
</script>`;

const recentScript = (t: (k: string, p?: Record<string, string | number>) => string) => `
<script>
(function(){
  var root = document.getElementById('brick-recent');
  if (!root) return;
  var body = document.getElementById('brick-recent-body');
  var base = root.dataset.base;
  var heading = root.dataset.heading;
  var guest = localStorage.getItem('brick_shop_guest');
  var q = guest ? ('?guest=' + encodeURIComponent(guest) + '&limit=' + root.dataset.limit)
                : ('?limit=' + root.dataset.limit);
${cardHelpers(t)}

  fetch('/api/plugins/brick-shop/recent-views' + q)
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      // 최근 본 것이 없으면 **아무것도 그리지 않는다** — 빈 영역이 화면을
      // 늘리기만 하고, 새 손님에게는 항상 비어 있다
      if (!d || !d.items || !d.items.length) return;
      body.innerHTML = (heading ? '<h3>' + esc(heading) + '</h3>' : '') +
        '<div class="brick-wish-grid">' +
        d.items.map(function(p){ return card(p, base, false); }).join('') + '</div>';
    })
    .catch(function(){});
})();
</script>`;
