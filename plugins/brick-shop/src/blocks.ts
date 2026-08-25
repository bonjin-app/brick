import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, won, type Db, type ShopSettings } from "./types.js";

/**
 * 스토어프론트 블록.
 *
 * 모두 서버 렌더(HTML 문자열)이므로 검색엔진이 상품을 그대로 읽는다 —
 * 커머스에서 SEO는 매출과 직결된다.
 * 장바구니 담기 같은 상호작용은 인라인 스크립트로 처리한다
 * (테마가 빌드를 타지 않으므로 프레임워크에 의존하지 않는다).
 */
export function registerStorefrontBlocks(
  ctx: PluginContext,
  db: Db,
  settings: () => Promise<ShopSettings>,
): void {
  // ── 상품 목록 ─────────────────────────────────────
  ctx.registerBlock({
    name: "product-list",
    displayName: "상품 목록",
    propsSchema: {
      type: "object",
      properties: {
        category: { type: "string", title: "분류 slug (비우면 전체)" },
        limit: { type: "number", title: "표시 개수", default: 8 },
        columns: { type: "number", title: "열 수", default: 4 },
        sort: { type: "string", title: "정렬 (recent | popular | price_asc | price_desc)", default: "recent" },
        title: { type: "string", title: "제목 (비우면 표시 안 함)" },
      },
    },
    render: async (props) => {
      const limit = Math.min(48, Math.max(1, Number(props.limit ?? 8)));
      const columns = Math.min(6, Math.max(1, Number(props.columns ?? 4)));
      const category = String(props.category ?? "");
      const order =
        props.sort === "popular" ? sql`p.sold_count DESC, p.created_at DESC`
        : props.sort === "price_asc" ? sql`p.price ASC`
        : props.sort === "price_desc" ? sql`p.price DESC`
        : sql`p.sort_order, p.created_at DESC`;

      const { rows } = await db.execute(sql`
        SELECT p.slug, p.name, p.price, p.list_price, p.image_url, p.status, p.stock
        FROM shop_products p
        LEFT JOIN shop_categories c ON c.id = p.category_id
        WHERE p.status IN ('selling', 'soldout') AND (${category} = '' OR c.slug = ${category})
        ORDER BY ${order}
        LIMIT ${limit}
      `);

      if (!rows.length) {
        return `<div class="brick-shop-empty">등록된 상품이 없습니다.</div>`;
      }

      const cards = rows.map((p) => {
        const soldout = p.status === "soldout" || (p.stock !== null && Number(p.stock) <= 0);
        const discount =
          p.list_price && Number(p.list_price) > Number(p.price)
            ? Math.round((1 - Number(p.price) / Number(p.list_price)) * 100)
            : 0;
        return `
  <a class="brick-product-card${soldout ? " is-soldout" : ""}" href="/shop/${encodeURIComponent(String(p.slug))}">
    <div class="brick-product-thumb">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" loading="lazy" />` : `<span class="brick-noimg">이미지 없음</span>`}
      ${soldout ? `<span class="brick-badge-soldout">품절</span>` : ""}
    </div>
    <div class="brick-product-name">${escapeHtml(p.name)}</div>
    <div class="brick-product-price">
      ${discount ? `<span class="brick-discount">${discount}%</span>` : ""}
      <strong>${won(Number(p.price))}</strong>
      ${discount ? `<del>${won(Number(p.list_price))}</del>` : ""}
    </div>
  </a>`;
      }).join("");

      const heading = props.title ? `<h2 class="brick-shop-heading">${escapeHtml(props.title)}</h2>` : "";
      return `${heading}<div class="brick-product-grid" style="--brick-cols:${columns}">${cards}\n</div>${STOREFRONT_CSS}`;
    },
  });

  // ── 상품 상세 ─────────────────────────────────────
  ctx.registerBlock({
    name: "product-detail",
    displayName: "상품 상세",
    propsSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          title: "상품 slug",
          description: "비우면 주소의 마지막 경로를 상품 slug로 사용합니다 (/shop/<slug>)",
        },
      },
    },
    render: async (props) => {
      const slug = String(props.slug ?? props.__pathTail ?? "");
      if (!slug) return `<div class="brick-shop-empty">상품을 지정해주세요.</div>`;

      const { rows } = await db.execute(sql`
        SELECT id, slug, name, summary, description, image_url, price, list_price, stock, status, free_shipping
        FROM shop_products WHERE slug = ${slug} AND status IN ('selling', 'soldout') LIMIT 1
      `);
      const p = rows[0];
      if (!p) return `<div class="brick-shop-empty">상품을 찾을 수 없습니다.</div>`;

      const { rows: options } = await db.execute(sql`
        SELECT id, name, extra_price, stock FROM shop_product_options
        WHERE product_id = ${String(p.id)}::uuid AND is_active = true ORDER BY sort_order, name
      `);
      const s = await settings();
      const soldout = p.status === "soldout" || (p.stock !== null && Number(p.stock) <= 0);

      const optionSelect = options.length
        ? `<label class="brick-field">옵션
    <select id="brick-opt">
      ${options.map((o) => {
        const oSoldout = o.stock !== null && Number(o.stock) <= 0;
        const extra = Number(o.extra_price) > 0 ? ` (+${won(Number(o.extra_price))})` : "";
        return `<option value="${escapeHtml(o.id)}"${oSoldout ? " disabled" : ""}>${escapeHtml(o.name)}${extra}${oSoldout ? " - 품절" : ""}</option>`;
      }).join("")}
    </select>
  </label>`
        : "";

      // JSON-LD: 검색엔진에 상품 정보를 구조화해 전달 (커머스 SEO)
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: p.name,
        description: p.summary ?? "",
        image: p.image_url ?? undefined,
        offers: {
          "@type": "Offer",
          price: Number(p.price),
          priceCurrency: "KRW",
          availability: soldout ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
        },
      });

      return `
<div class="brick-product-detail">
  <div class="brick-detail-media">
    ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" />` : `<span class="brick-noimg">이미지 없음</span>`}
  </div>
  <div class="brick-detail-info">
    <h1>${escapeHtml(p.name)}</h1>
    ${p.summary ? `<p class="brick-detail-summary">${escapeHtml(p.summary)}</p>` : ""}
    <div class="brick-detail-price">
      ${p.list_price && Number(p.list_price) > Number(p.price) ? `<del>${won(Number(p.list_price))}</del>` : ""}
      <strong>${won(Number(p.price))}</strong>
    </div>
    <dl class="brick-detail-meta">
      <dt>배송비</dt>
      <dd>${p.free_shipping ? "무료배송" : `${won(s.shippingFee)}${s.freeShippingOver > 0 ? ` (${won(s.freeShippingOver)} 이상 무료)` : ""}`}</dd>
      <dt>재고</dt>
      <dd>${p.stock === null ? "구매 가능" : soldout ? "품절" : `${Number(p.stock)}개 남음`}</dd>
    </dl>
    ${soldout ? `<div class="brick-soldout-notice">품절된 상품입니다.</div>` : `
    <form class="brick-buy-form" data-product="${escapeHtml(p.id)}">
      ${optionSelect}
      <label class="brick-field">수량
        <input id="brick-qty" type="number" value="1" min="1" max="999" />
      </label>
      <div class="brick-buy-actions">
        <button type="button" data-act="cart">장바구니</button>
        <button type="button" data-act="buy" class="brick-primary">바로 구매</button>
      </div>
      <p class="brick-buy-msg" role="status"></p>
    </form>`}
  </div>
</div>
<div class="brick-detail-description">${String(p.description ?? "")}</div>
<script type="application/ld+json">${jsonLd}</script>
${BUY_SCRIPT}${STOREFRONT_CSS}`;
    },
  });

  // ── 분류 목록 ─────────────────────────────────────
  ctx.registerBlock({
    name: "category-list",
    displayName: "상품 분류 목록",
    render: async () => {
      const { rows } = await db.execute(sql`
        SELECT c.slug, c.name,
               (SELECT count(*) FROM shop_products p WHERE p.category_id = c.id AND p.status = 'selling') AS n
        FROM shop_categories c WHERE c.is_visible = true ORDER BY c.sort_order, c.name
      `);
      if (!rows.length) return "";
      const items = rows
        .map((c) => `<a href="/shop?category=${encodeURIComponent(String(c.slug))}">${escapeHtml(c.name)} <span>${Number(c.n)}</span></a>`)
        .join("");
      return `<nav class="brick-category-list">${items}</nav>${STOREFRONT_CSS}`;
    },
  });

  // ── 장바구니 ──────────────────────────────────────
  ctx.registerBlock({
    name: "cart",
    displayName: "장바구니",
    render: async () => `
<div class="brick-cart" id="brick-cart">
  <p class="brick-cart-loading">장바구니를 불러오는 중…</p>
</div>
${CART_SCRIPT}${STOREFRONT_CSS}`,
  });
}

/* ── 스토어프론트 CSS ────────────────────────────────
   테마가 빌드를 타지 않으므로 블록이 자기 스타일을 함께 낸다.
   CSS 변수는 테마 토큰을 우선 사용해 테마 디자인과 어울리게 한다. */
const STOREFRONT_CSS = `
<style>
.brick-product-grid{display:grid;grid-template-columns:repeat(var(--brick-cols,4),1fr);gap:20px;margin:20px 0}
@media(max-width:900px){.brick-product-grid{grid-template-columns:repeat(2,1fr)}}
.brick-product-card{display:block;text-decoration:none;color:inherit}
.brick-product-thumb{position:relative;aspect-ratio:1;background:#f4f4f7;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.brick-product-thumb img{width:100%;height:100%;object-fit:cover}
.brick-noimg{color:#aaa;font-size:13px}
.brick-badge-soldout{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);color:#fff;font-weight:700}
.brick-product-card.is-soldout .brick-product-name{color:#999}
.brick-product-name{margin-top:10px;font-size:15px;line-height:1.4}
.brick-product-price{margin-top:4px;display:flex;align-items:baseline;gap:6px;font-size:15px}
.brick-product-price del{color:#aaa;font-size:13px}
.brick-discount{color:var(--color-primary,#d0402c);font-weight:700}
.brick-shop-heading{margin:8px 0 0;font-size:22px}
.brick-shop-empty{padding:40px;text-align:center;color:#999}
.brick-category-list{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.brick-category-list a{padding:7px 14px;border:1px solid #e3e3ea;border-radius:20px;text-decoration:none;color:inherit;font-size:14px}
.brick-category-list a span{color:#999;font-size:12px}
.brick-product-detail{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin:20px 0}
@media(max-width:800px){.brick-product-detail{grid-template-columns:1fr}}
.brick-detail-media{aspect-ratio:1;background:#f4f4f7;border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.brick-detail-media img{width:100%;height:100%;object-fit:cover}
.brick-detail-info h1{margin:0 0 8px;font-size:26px;line-height:1.3}
.brick-detail-summary{color:#666;margin:0 0 16px}
.brick-detail-price{display:flex;align-items:baseline;gap:8px;font-size:26px;margin-bottom:18px}
.brick-detail-price del{color:#aaa;font-size:16px}
.brick-detail-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14px;margin:0 0 20px;padding:16px 0;border-top:1px solid #eee;border-bottom:1px solid #eee}
.brick-detail-meta dt{color:#888}
.brick-detail-meta dd{margin:0}
.brick-field{display:block;margin-bottom:12px;font-size:14px}
.brick-field select,.brick-field input{display:block;width:100%;max-width:280px;padding:9px;margin-top:4px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box}
.brick-buy-actions{display:flex;gap:10px;margin-top:18px}
.brick-buy-actions button{flex:1;padding:14px;border:1px solid #ddd;border-radius:8px;background:#fff;font-size:15px;cursor:pointer}
.brick-buy-actions .brick-primary{background:var(--color-primary,#d0402c);color:#fff;border-color:transparent;font-weight:700}
.brick-buy-msg{min-height:20px;font-size:14px;margin:10px 0 0}
.brick-soldout-notice{padding:16px;background:#f4f4f7;border-radius:8px;text-align:center;color:#777}
.brick-detail-description{margin:40px 0;line-height:1.8}
.brick-cart table{width:100%;border-collapse:collapse;font-size:14px}
.brick-cart th,.brick-cart td{padding:12px 8px;border-bottom:1px solid #eee;text-align:left}
.brick-cart-total{margin-top:20px;padding:20px;background:#f8f8fb;border-radius:10px}
.brick-cart-total dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0}
.brick-cart-total dt{color:#666}
.brick-cart-total dd{margin:0;text-align:right}
.brick-cart-total .brick-grand{font-size:20px;font-weight:700;padding-top:10px;border-top:1px solid #e0e0e8}
.brick-cart-qty{width:64px;padding:6px;border:1px solid #ddd;border-radius:5px}
</style>`;

/* ── 장바구니 담기 / 바로 구매 스크립트 ──────────────
   비회원 장바구니 토큰은 localStorage에 보관한다. */
const BUY_SCRIPT = `
<script>
(function(){
  var form = document.currentScript.parentNode.querySelector('.brick-buy-form');
  if (!form) return;
  var msg = form.querySelector('.brick-buy-msg');
  function payload(){
    var opt = form.querySelector('#brick-opt');
    return {
      productId: form.dataset.product,
      optionId: opt ? opt.value : null,
      quantity: Number(form.querySelector('#brick-qty').value || 1),
      guestToken: localStorage.getItem('brick_shop_guest')
    };
  }
  form.querySelectorAll('button[data-act]').forEach(function(btn){
    btn.addEventListener('click', function(){
      msg.textContent = '처리 중…';
      fetch('/api/plugins/brick-shop/cart', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload())
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(res){
          if (!res.ok) { msg.textContent = res.d.message || '담기에 실패했습니다.'; return; }
          if (res.d.guestToken) localStorage.setItem('brick_shop_guest', res.d.guestToken);
          if (btn.dataset.act === 'buy') { location.href = '/cart'; return; }
          msg.textContent = '장바구니에 담았습니다.';
        })
        .catch(function(){ msg.textContent = '오류가 발생했습니다.'; });
    });
  });
})();
</script>`;

/* ── 장바구니 화면 스크립트 ─────────────────────────── */
const CART_SCRIPT = `
<script>
(function(){
  var root = document.getElementById('brick-cart');
  if (!root) return;
  var guest = localStorage.getItem('brick_shop_guest');
  var qs = guest ? '?guest=' + encodeURIComponent(guest) : '';

  function fmt(n){ return Number(n).toLocaleString('ko-KR') + '원'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function render(d){
    if (!d.items || !d.items.length) {
      root.innerHTML = '<p class="brick-shop-empty">장바구니가 비어 있습니다.</p>';
      return;
    }
    var rows = d.items.map(function(it){
      return '<tr data-item="' + esc(it.id) + '">' +
        '<td>' + esc(it.productName) + (it.optionName ? ' <small>(' + esc(it.optionName) + ')</small>' : '') + '</td>' +
        '<td>' + fmt(it.unitPrice) + '</td>' +
        '<td><input class="brick-cart-qty" type="number" min="1" max="999" value="' + Number(it.quantity) + '" /></td>' +
        '<td>' + fmt(it.lineTotal) + '</td>' +
        '<td><button data-remove>삭제</button></td></tr>';
    }).join('');

    root.innerHTML =
      '<table><thead><tr><th>상품</th><th>단가</th><th>수량</th><th>합계</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="brick-cart-total"><dl>' +
      '<dt>상품 금액</dt><dd>' + fmt(d.subtotal) + '</dd>' +
      (d.discount ? '<dt>할인</dt><dd>-' + fmt(d.discount) + '</dd>' : '') +
      '<dt>배송비</dt><dd>' + (d.shippingFee ? fmt(d.shippingFee) : '무료') + '</dd>' +
      '<dt class="brick-grand">결제 예정 금액</dt><dd class="brick-grand">' + fmt(d.total) + '</dd>' +
      '</dl><div class="brick-buy-actions"><a class="brick-primary" href="/checkout" ' +
      'style="flex:1;padding:14px;border-radius:8px;text-align:center;text-decoration:none">주문하기</a></div></div>';

    root.querySelectorAll('tr[data-item]').forEach(function(tr){
      var id = tr.dataset.item;
      tr.querySelector('.brick-cart-qty').addEventListener('change', function(e){
        send('PUT', id, { quantity: Number(e.target.value) });
      });
      tr.querySelector('[data-remove]').addEventListener('click', function(){ send('DELETE', id); });
    });
  }

  function send(method, id, body){
    fetch('/api/plugins/brick-shop/cart/' + id + qs, {
      method: method, headers: {'content-type':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    }).then(load);
  }

  function load(){
    fetch('/api/plugins/brick-shop/cart' + qs)
      .then(function(r){ return r.json(); })
      .then(render)
      .catch(function(){ root.innerHTML = '<p class="brick-shop-empty">장바구니를 불러올 수 없습니다.</p>'; });
  }
  load();
})();
</script>`;
