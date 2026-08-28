import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, won, type Db, type ShopSettings } from "./types.js";
import { reviewSection } from "./reviews-view.js";
import { RELATED_LIMIT, listRelated, type RelatedProduct } from "./related.js";

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
        SELECT p.slug, p.name, p.price, p.list_price, p.image_url, p.status, p.stock,
               p.review_count, p.rating_sum
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
    ${Number(p.review_count) > 0 ? `<div class="brick-card-rating"><span class="brick-stars">${"★".repeat(Math.round(Number(p.rating_sum) / Number(p.review_count)))}</span> <span>(${Number(p.review_count)})</span></div>` : ""}
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
        SELECT id, slug, name, summary, description, image_url, images, price, list_price,
               stock, status, free_shipping, review_count, rating_sum, inquiry_count
        FROM shop_products WHERE slug = ${slug} AND status IN ('selling', 'soldout') LIMIT 1
      `);
      const p = rows[0];
      if (!p) return `<div class="brick-shop-empty">상품을 찾을 수 없습니다.</div>`;

      // 관련 상품 — 실패해도 상품 상세는 떠야 한다.
      // 추천은 부가 기능이고, 이것 때문에 상품을 못 팔면 안 된다.
      let relatedHtml = "";
      try {
        const related = await listRelated(db, String(p.id), RELATED_LIMIT);
        relatedHtml = relatedSection(related);
      } catch {
        relatedHtml = "";
      }

      const { rows: options } = await db.execute(sql`
        SELECT id, name, extra_price, stock FROM shop_product_options
        WHERE product_id = ${String(p.id)}::uuid AND is_active = true ORDER BY sort_order, name
      `);
      const s = await settings();
      const soldout = p.status === "soldout" || (p.stock !== null && Number(p.stock) <= 0);

      // 대표 이미지 + 추가 이미지 = 갤러리. 대표가 목록에 이미 있으면 중복을 걷어낸다
      const extra = Array.isArray(p.images) ? (p.images as string[]).map(String) : [];
      const gallery = [...new Set([p.image_url, ...extra].filter(Boolean) as string[])];
      const reviewCount = Number(p.review_count ?? 0);
      const ratingAvg = reviewCount > 0 ? Number(p.rating_sum) / reviewCount : 0;

      /**
       * 품절 옵션 — 재입고 알림 대상이다.
       *
       * **옵션 하나만 품절인 경우가 대부분이다**("M 사이즈만 품절"). 그때 상품은
       * 여전히 selling 이라 품절 화면이 뜨지 않으므로, 살 수 있는 상품에도
       * 품절 옵션이 있으면 알림 폼을 보여줘야 한다.
       */
      const soldoutOptions = options.filter((o) => o.stock !== null && Number(o.stock) <= 0);

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
        image: gallery.length ? gallery : undefined,
        offers: {
          "@type": "Offer",
          price: Number(p.price),
          priceCurrency: "KRW",
          availability: soldout ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
        },
        // 검색 결과에 별점을 노출시킨다 — 후기가 있을 때만 넣어야 유효한 마크업이 된다
        aggregateRating: reviewCount > 0
          ? { "@type": "AggregateRating", ratingValue: Math.round(ratingAvg * 10) / 10, reviewCount }
          : undefined,
      });

      return `
<div class="brick-product-detail">
  <div>
    <div class="brick-detail-media">
      ${gallery.length ? `<img id="brick-main-img" src="${escapeHtml(gallery[0])}" alt="${escapeHtml(p.name)}" />` : `<span class="brick-noimg">이미지 없음</span>`}
    </div>
    ${gallery.length > 1 ? `<div class="brick-gallery">${gallery.map((u, i) =>
      `<button type="button" class="${i === 0 ? "is-on" : ""}" data-src="${escapeHtml(u)}" aria-label="이미지 ${i + 1}"><img src="${escapeHtml(u)}" alt="" loading="lazy" /></button>`,
    ).join("")}</div>` : ""}
  </div>
  <div class="brick-detail-info">
    <h1>${escapeHtml(p.name)}</h1>
    ${reviewCount > 0 ? `<p class="brick-detail-rating"><span class="brick-stars">${"★".repeat(Math.round(ratingAvg))}${"☆".repeat(5 - Math.round(ratingAvg))}</span> <strong>${ratingAvg.toFixed(1)}</strong> <a href="#brick-reviews">후기 ${reviewCount}개</a></p>` : ""}
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
    ${soldout ? `<div class="brick-soldout-notice">
      <p>품절된 상품입니다.</p>
      ${restockForm(String(p.slug), soldoutOptions)}
    </div>` : `
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
${
  // 상품은 팔지만 일부 옵션이 품절인 경우 — 가장 흔한 상황이다
  !soldout && soldoutOptions.length
    ? `<div class="brick-partial-soldout">
        <p>품절된 옵션이 있습니다.</p>
        ${restockForm(String(p.slug), soldoutOptions)}
      </div>`
    : ""
}
${relatedHtml}
<a id="brick-reviews"></a>
${reviewSection({ id: String(p.id), reviewCount, ratingAvg, inquiryCount: Number(p.inquiry_count ?? 0) })}
<script type="application/ld+json">${jsonLd}</script>
${BUY_SCRIPT}${GALLERY_SCRIPT}${RESTOCK_SCRIPT}${STOREFRONT_CSS}`;
    },
  });

  // ── 관련 상품 (독립 블록) ──────────────────────────
  //
  // 상품 상세에 이미 붙지만, 테마가 위치를 직접 정하고 싶을 수 있다
  // (후기 위/아래, 사이드바 등).
  ctx.registerBlock({
    name: "related-products",
    displayName: "관련 상품",
    propsSchema: {
      type: "object",
      properties: {
        slug: { type: "string", title: "상품 slug", description: "비우면 주소의 마지막 경로를 씁니다." },
        limit: { type: "number", title: "표시 개수", default: RELATED_LIMIT },
        title: { type: "string", title: "제목", default: "관련 상품" },
      },
    },
    render: async (props) => {
      const slug = String(props.slug ?? props.__pathTail ?? "");
      if (!slug) return "";
      const { rows } = await db.execute(sql`
        SELECT id FROM shop_products WHERE slug = ${slug} AND status IN ('selling', 'soldout') LIMIT 1
      `);
      if (!rows[0]) return "";
      const limit = Number(props.limit ?? RELATED_LIMIT);
      const related = await listRelated(db, String(rows[0].id), limit);
      return relatedSection(related, String(props.title ?? "관련 상품"));
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

/**
 * 관련 상품 섹션.
 *
 * 추천이 없으면 **아무것도 내지 않는다.** "관련 상품이 없습니다" 를 띄우면
 * 빈 영역이 상세 페이지를 늘리기만 하고, 새 쇼핑몰에서는 모든 상품에
 * 그것이 붙는다.
 *
 * 함께 구매로 채워진 것에는 표시를 붙이지 않는다 — 손님에게 "이건 자동
 * 추천입니다"는 정보가 아니다. 운영자는 관리 화면에서 구분할 수 있다.
 */
function relatedSection(items: RelatedProduct[], title = "관련 상품"): string {
  if (!items.length) return "";
  const cards = items
    .map((r) => {
      const href = `/shop/${encodeURIComponent(r.slug)}`;
      const thumb = r.imageUrl
        ? `<img src="${escapeHtml(r.imageUrl)}" alt="${escapeHtml(r.name)}" loading="lazy" />`
        : `<span class="brick-noimg">이미지 없음</span>`;
      const soldout = r.status === "soldout" ? `<span class="brick-badge-soldout">품절</span>` : "";
      const list =
        r.listPrice && r.listPrice > r.price
          ? `<del>${won(r.listPrice)}</del> `
          : "";
      return `<a class="brick-product-card" href="${href}">
  <span class="brick-product-thumb">${thumb}${soldout}</span>
  <span class="brick-product-name">${escapeHtml(r.name)}</span>
  <span class="brick-product-price">${list}<strong>${won(r.price)}</strong></span>
</a>`;
    })
    .join("");
  return `<section class="brick-related">
  <h2>${escapeHtml(title)}</h2>
  <div class="brick-product-grid" style="--brick-cols:4">${cards}</div>
</section>`;
}

/**
 * 재입고 알림 신청 폼.
 *
 * 품절 옵션이 여럿이면 고르게 한다. 하나면 숨겨진 값으로 넣는다 — 선택지가
 * 하나뿐인 드롭다운은 누르게 만들 이유가 없다.
 */
function restockForm(
  slug: string,
  soldoutOptions: Array<Record<string, unknown>>,
): string {
  const picker =
    soldoutOptions.length > 1
      ? `<label class="brick-field">품절된 옵션
      <select name="optionId">
        ${soldoutOptions
          .map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`)
          .join("")}
      </select>
    </label>`
      : soldoutOptions.length === 1
        ? `<input type="hidden" name="optionId" value="${escapeHtml(soldoutOptions[0].id)}" />`
        : "";

  return `<form class="brick-restock-form" data-slug="${escapeHtml(slug)}">
    ${picker}
    <label class="brick-field">재입고 알림 받을 이메일
      <input type="email" name="email" placeholder="name@example.com" required />
    </label>
    <button type="button" data-act="restock">재입고 알림 신청</button>
    <p class="brick-restock-msg" role="status"></p>
    <p class="brick-restock-note">재입고되면 1회 알려드립니다. 광고 메일이 아닙니다.</p>
  </form>`;
}

/**
 * 재입고 알림 신청 스크립트.
 *
 * 품절 화면에서만 렌더되므로 항상 붙여도 부담이 없다.
 * 옵션이 있는 상품은 선택된 옵션을 함께 보낸다 — "M 사이즈만 품절"이 대부분이다.
 */
const RESTOCK_SCRIPT = `
<script>
(function () {
  // 폼이 둘일 수 있다 (품절 상품 + 품절 옵션). 각각 붙인다.
  Array.prototype.forEach.call(document.querySelectorAll(".brick-restock-form"), attach);

  function attach(form) {
  var btn = form.querySelector('[data-act="restock"]');
  var msg = form.querySelector(".brick-restock-msg");
  btn.addEventListener("click", function () {
    var email = form.querySelector('input[name="email"]').value.trim();
    if (!email) { msg.textContent = "이메일을 입력해주세요."; return; }
    // 옵션은 이 폼 안에서 읽는다 — 구매용 드롭다운을 읽으면 다른 옵션이 섞인다
    var opt = form.querySelector('[name="optionId"]');
    var body = { email: email };
    if (opt && opt.value) body.optionId = opt.value;
    btn.disabled = true;
    msg.textContent = "신청 중…";
    fetch("/api/plugins/brick-shop/products/" + encodeURIComponent(form.dataset.slug) + "/restock-alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        // 실패 이유를 그대로 보여준다 — "이미 신청했습니다"를 감추면 손님이 계속 누른다
        msg.textContent = res.ok
          ? "신청되었습니다. 재입고되면 " + res.d.email + " 으로 알려드립니다."
          : (res.d.message || "신청에 실패했습니다.");
        if (res.ok) form.querySelector('input[name="email"]').value = "";
      })
      .catch(function () { msg.textContent = "신청에 실패했습니다."; })
      .finally(function () { btn.disabled = false; });
  });
  }
})();
</script>`;

/* ── 스토어프론트 CSS ────────────────────────────────
   테마가 빌드를 타지 않으므로 블록이 자기 스타일을 함께 낸다.
   CSS 변수는 테마 토큰을 우선 사용해 테마 디자인과 어울리게 한다. */
const STOREFRONT_CSS = `
<style>
.brick-partial-soldout{margin-top:28px;padding:16px;background:var(--brick-surface,#f7f7fa);border-radius:10px}
.brick-partial-soldout>p{margin:0 0 4px;font-weight:600}
.brick-restock-form{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-width:360px}
.brick-restock-form button{padding:10px 16px;cursor:pointer;border-radius:8px;border:1px solid var(--brick-border,#ddd);background:#fff}
.brick-restock-msg{margin:0;font-size:13px;color:var(--brick-accent,#0a7)}
.brick-restock-note{margin:0;font-size:12px;color:#888}
.brick-related{margin:48px 0 0}
.brick-related h2{font-size:19px;margin:0 0 4px;padding-top:24px;border-top:1px solid var(--brick-border,#e5e5ea)}
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
.brick-detail-rating{display:flex;align-items:center;gap:7px;margin:0 0 10px;font-size:15px}
.brick-detail-rating a{color:#888;font-size:13px}
.brick-card-rating{margin-top:3px;font-size:13px;color:#888;display:flex;gap:4px;align-items:center}
.brick-stars{color:#f5a623;letter-spacing:1px}
</style>`;

/* ── 이미지 갤러리 (썸네일 클릭으로 대표 이미지 교체) ── */
const GALLERY_SCRIPT = `
<script>
(function(){
  var wrap = document.currentScript.parentNode.querySelector('.brick-gallery');
  var main = document.getElementById('brick-main-img');
  if (!wrap || !main) return;
  wrap.querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click', function(){
      main.src = btn.dataset.src;
      wrap.querySelectorAll('button').forEach(function(b){ b.classList.toggle('is-on', b === btn); });
    });
  });
})();
</script>`;

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
