import { sql } from "drizzle-orm";
import { CAPTCHA_WIDGET_CSS, CAPTCHA_WIDGET_JS, captchaFieldHtml,
         type BlockRenderContext, type PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, won, type Db, type ShopSettings } from "./types.js";
import { bindI18n, t, moneyFnScript } from "./i18n.js";
import { reviewSection } from "./reviews-view.js";
import { RELATED_LIMIT, listRelated, type RelatedProduct } from "./related.js";
import { activeCollections, viewCollection } from "./collections.js";
import { registerCheckoutView } from "./checkout-view.js";
import { registerOrdersView } from "./orders-view.js";
import { registerWishlistView } from "./wishlist-view.js";
import { registerCouponsView } from "./coupons-view.js";

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
  bindI18n(ctx);
  // ── 상품 목록 ─────────────────────────────────────
  const productListBlock: Parameters<PluginContext["registerBlock"]>[0] = {
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
        sortable: { type: "boolean", title: "손님이 정렬을 바꿀 수 있게 (상품 목록 화면용)", default: false },
        paged: { type: "boolean", title: "페이지 나누기 (상품 목록 화면용)", default: false },
        priceFilter: { type: "boolean", title: "가격대로 좁히기 (상품 목록 화면용)", default: false },
        stockFilter: { type: "boolean", title: "품절 제외 토글 (상품 목록 화면용)", default: false },
      },
    },
    render: async (props, blockCtx) => {
      const limit = Math.min(48, Math.max(1, Number(props.limit ?? 8)));
      const columns = Math.min(6, Math.max(1, Number(props.columns ?? 4)));
      const category = String(props.category ?? "");

      /*
       * 정렬 — 운영자가 블록에 고정하거나(홈의 "인기 상품" 섹션), 손님이 고르게 할 수 있다.
       * `sortable` 이 켜져 있으면 **쿼리스트링이 이긴다**: 홈의 진열 섹션은 운영자가 정한 순서를
       * 지켜야 하고(그 자리에서 정렬을 바꿀 이유가 없다), 상품 목록 화면은 손님이 고르는 것이 맞다.
       */
      const SORTS = ["recent", "popular", "price_asc", "price_desc"] as const;
      const asked = String(blockCtx?.query?.sort ?? "");
      const sortable = props.sortable === true;
      const sort = sortable && (SORTS as readonly string[]).includes(asked) ? asked : String(props.sort ?? "recent");
      const order =
        sort === "popular" ? sql`p.sold_count DESC, p.created_at DESC`
        : sort === "price_asc" ? sql`p.price ASC`
        : sort === "price_desc" ? sql`p.price DESC`
        : sql`p.sort_order, p.created_at DESC`;

      /*
       * 가격대 좁히기 — `?min=&max=` 로 표현한다.
       *
       * 상한은 **미만**(<)이다. 가격대 버튼의 문구("30,000원 미만")와 실제 결과가 어긋나면
       * 개수와 목록이 서로 다른 말을 하게 되므로, 경계 하나를 두 곳에서 같은 뜻으로 쓴다.
       */
      const priceFilter = props.priceFilter === true;
      const askedNum = (v: unknown): number | null => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n >= 0 && String(v ?? "") !== "" ? n : null;
      };
      const qMin = (priceFilter ? askedNum(blockCtx?.query?.min) : null) ?? 0;
      const qMaxRaw = priceFilter ? askedNum(blockCtx?.query?.max) : null;
      // 뒤집힌 범위(min>max)는 결과가 항상 비므로 상한을 버린다 — 주소를 손으로 고친 경우
      const qMax = qMaxRaw !== null && qMaxRaw > qMin ? qMaxRaw : null;
      const priceCond =
        qMax !== null ? sql` AND p.price >= ${qMin} AND p.price < ${qMax}`
        : qMin > 0 ? sql` AND p.price >= ${qMin}`
        : sql.empty();

      /*
       * 품절 제외 — 기본은 **보여 주는** 쪽이다.
       *
       * 품절 상품은 진열대에 남겨두는 것이 한국 쇼핑몰의 관례다: 재입고 알림을 받고,
       * 그 물건이 잘 팔린다는 신호가 되고, 검색에서 들어온 주소가 404 가 되지 않는다.
       * 대신 "지금 살 수 있는 것만" 보려는 손님에게 스위치를 준다.
       */
      const stockFilter = props.stockFilter === true;
      const instock = stockFilter && String(blockCtx?.query?.instock ?? "") === "1";
      // 카드에 품절 표시를 붙이는 판단과 같은 식이어야 한다 — 다르면 목록과 카드가 어긋난다
      const SOLDOUT = sql`(p.status = 'soldout' OR (p.stock IS NOT NULL AND p.stock <= 0))`;
      const stockCond = instock ? sql` AND NOT ${SOLDOUT}` : sql.empty();

      /*
       * 정렬 막대 — 링크로 만든다(select + JS 가 아니라).
       *
       * 링크는 검색엔진이 따라가고, 손님이 새 탭으로 열 수 있고, 뒤로 가기가 자연스럽고,
       * 스크립트 없이 동작한다. 쇼핑몰에서 "낮은 가격순"은 공유되는 주소다.
       * 다른 쿼리(분류·페이지)는 유지해야 하므로 현재 쿼리를 복사해 sort 만 바꾼다.
       */
      /** 현재 쿼리를 유지하며 일부만 바꾼 주소 — 정렬 막대와 페이저가 같은 규칙을 쓴다 */
      const linkWith = (changes: Record<string, string | null>): string => {
        const params = new URLSearchParams(Object.entries(blockCtx?.query ?? {}));
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) params.delete(k);
          else params.set(k, v);
        }
        const qs = params.toString();
        return `${shopBaseOf(blockCtx)}${qs ? `?${qs}` : ""}`;
      };

      const sortBar = sortable
        ? `<div class="brick-sort" role="group" aria-label="${escapeHtml(t("sort.label"))}">${SORTS.map((key) => {
            const on = key === sort;
            // 정렬을 바꾸면 1페이지로 — 3페이지에서 정렬만 바꾸면 손님은 엉뚱한 곳에 있다
            return `<a href="${escapeHtml(linkWith({ sort: key, page: null }))}"${
              on ? ' class="is-on" aria-current="true"' : ""
            }>${escapeHtml(t(`sort.${key}`))}</a>`;
          }).join("")}</div>`
        : "";

      /*
       * 페이지 나누기 — 목록 화면에서만 켠다(홈의 진열 섹션은 limit 만큼 보여주고 끝이다).
       *
       * 이것이 없으면 **상품이 limit 를 넘는 순간 나머지를 볼 방법이 없다.** 기본 24 였으니
       * 25번째 상품부터는 사이트에 있어도 손님이 닿을 수 없었다 — 쇼핑몰에서 치명적이다.
       */
      const paged = props.paged === true;
      const page = paged ? Math.max(1, Math.floor(Number(blockCtx?.query?.page ?? 1)) || 1) : 1;

      /*
       * 집합을 두 단계로 나눈다.
       *
       * scopeBase(분류까지만) — 가격대 **눈금**과 품절 상품 유무를 여기서 본다. 눈금이
       *   품절 제외 여부에 따라 움직이면 스위치를 누를 때마다 구간이 바뀌어 손님이 길을 잃고,
       *   품절 유무를 좁힌 집합에서 보면 품절을 제외한 순간 스위치가 사라져 되돌릴 수 없다.
       * scope(+품절 제외) — 구간별 개수와 총 개수. 다른 축의 필터는 반영해야 맞다.
       *
       * 어느 쪽도 **가격대는 넣지 않는다**: 한 구간을 고른 순간 나머지 구간이 모두 0 이 되면
       * 되돌릴 길이 사라진다.
       */
      const scopeBase = sql`
        FROM shop_products p
        LEFT JOIN shop_categories c ON c.id = p.category_id
        WHERE p.status IN ('selling', 'soldout') AND (${category} = '' OR c.slug = ${category})`;
      const scope = sql`${scopeBase}${stockCond}`;

      let bands: PriceBand[] = [];
      let soldoutN = 0;
      if (priceFilter || stockFilter) {
        const { rows: span } = await db.execute(sql`
          SELECT min(p.price)::int AS lo, max(p.price)::int AS hi,
                 count(*) FILTER (WHERE ${SOLDOUT})::int AS soldout ${scopeBase}`);
        soldoutN = Number(span[0]?.soldout ?? 0);
        if (priceFilter) bands = priceBands(Number(span[0]?.lo ?? 0), Number(span[0]?.hi ?? 0));
      }

      let total = 0;
      const bandCounts: number[] = [];
      if (paged || bands.length) {
        const cols = [sql`count(*) FILTER (WHERE true ${priceCond})::int AS n`];
        bands.forEach((b, i) => {
          const cond = b.max === null ? sql`p.price >= ${b.min}` : sql`p.price >= ${b.min} AND p.price < ${b.max}`;
          cols.push(sql`count(*) FILTER (WHERE ${cond})::int AS ${sql.raw(`b${i}`)}`);
        });
        const { rows: aggRows } = await db.execute(sql`SELECT ${sql.join(cols, sql`, `)} ${scope}`);
        const agg = aggRows[0] ?? {};
        total = Number(agg.n ?? 0);
        bands.forEach((_b, i) => bandCounts.push(Number((agg as Record<string, unknown>)[`b${i}`] ?? 0)));
        // 비어 있는 구간은 지운다 — 눌러도 "상품이 없습니다"만 나오는 버튼은 손님을 속인다.
        // 남는 구간에는 개수를 붙인다: 몇 개가 걸릴지 보이면 헛클릭이 줄고, 어느 가격대에
        // 물건이 몰려 있는지가 그 자체로 정보다.
        bands = bands.map((b, i) => ({ ...b, count: bandCounts[i] })).filter((b) => (b.count ?? 0) > 0);
      }

      /*
       * 구간이 하나뿐이면 가격 눈금을 내지 않는다 — 전부 같은 가격대라면 좁힐 것이 없고,
       * 누를 수 있는 버튼이 하나인 필터는 화면만 차지한다.
       */
      const priceGroup = bands.length >= 2
        ? `<span class="brick-filter-label">${escapeHtml(t("filter.price"))}</span>` +
          // "전체"는 구간이 아니라 구간을 지우는 링크다 — 같은 map 에 섞으면 둘 다 어색해진다
          [{ band: null }, ...bands.map((band) => ({ band }))]
            .map(({ band }) => {
              const on = band === null ? qMin === 0 && qMax === null : band.min === qMin && band.max === qMax;
              const href = linkWith({
                min: band === null || band.min === 0 ? null : String(band.min),
                max: band === null || band.max === null ? null : String(band.max),
                page: null,
              });
              const label =
                band === null ? t("filter.all") : `${bandLabel(band)} (${band.count ?? 0})`;
              return `<a href="${escapeHtml(href)}"${on ? ' class="is-on" aria-current="true"' : ""}>${escapeHtml(label)}</a>`;
            })
            .join("")
        : "";

      // 품절이 하나도 없으면 스위치를 내지 않는다 — 아무것도 바꾸지 못하는 스위치다
      const stockToggle = stockFilter && soldoutN > 0
        ? `<a class="brick-filter-toggle${instock ? " is-on" : ""}" aria-pressed="${instock}" ` +
          `href="${escapeHtml(linkWith({ instock: instock ? null : "1", page: null }))}">${escapeHtml(t("filter.instock"))}</a>`
        : "";

      const priceBar = priceGroup || stockToggle
        ? `<div class="brick-filter" role="group" aria-label="${escapeHtml(t("filter.label"))}">${priceGroup}${stockToggle}</div>`
        : "";
      const totalPages = paged ? Math.max(1, Math.ceil(total / limit)) : 1;
      // 없는 페이지를 요청하면 마지막 페이지를 보여준다 — 빈 화면보다 낫다(주소를 손으로 고친 경우)
      const current = Math.min(page, totalPages);

      const { rows } = await db.execute(sql`
        -- 목록은 **썸네일**을 쓴다. 대표 사진(원본)을 64~300px 칸에 그리면 상품 24개가
        -- 깔린 첫 화면이 수 MB 가 된다. 썸네일이 없으면(외부 URL·GIF·SVG) 원본을 쓴다.
        SELECT p.slug, p.name, p.price, p.list_price, coalesce(p.thumb_url, p.image_url) AS image_url, p.status, p.stock,
               p.review_count, p.rating_sum, p.created_at, p.sold_count
        FROM shop_products p
        LEFT JOIN shop_categories c ON c.id = p.category_id
        WHERE p.status IN ('selling', 'soldout') AND (${category} = '' OR c.slug = ${category})${priceCond}${stockCond}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${(current - 1) * limit}
      `);

      if (!rows.length) {
        // 정렬을 바꿨다가 빈 결과가 나오면 되돌릴 수단이 화면에 있어야 한다 — 막대를 함께 낸다
        return `${props.title ? `<h2 class="brick-shop-heading">${escapeHtml(props.title)}</h2>` : ""}${priceBar}${sortBar}<div class="brick-shop-empty">${escapeHtml(t("list.empty"))}</div>${STOREFRONT_CSS}`;
      }

      /*
       * NEW·BEST 뱃지 — 쇼핑몰 진열대의 관례다.
       *
       * NEW 는 최근 14일에 등록된 상품. BEST 는 이 목록에서 가장 많이 팔린 상품 상위 3개인데,
       * **한 개라도 팔린 것만** 붙인다 — 아무도 안 산 상품에 BEST 가 붙으면 손님이 표시를
       * 믿지 않게 된다(그러면 뱃지가 전부 무의미해진다). 기준을 설정으로 열지 않은 이유는
       * 옵션이 늘면 아무도 안 만지고, 이 값이 한국 쇼핑몰의 통념에 가깝기 때문이다.
       */
      const NEW_DAYS = 14;
      const newerThan = Date.now() - NEW_DAYS * 24 * 60 * 60 * 1000;
      const bestSellers = new Set(
        rows
          .filter((p) => Number(p.sold_count) > 0)
          .sort((a, b) => Number(b.sold_count) - Number(a.sold_count))
          .slice(0, 3)
          .map((p) => String(p.slug)),
      );

      const cards = rows.map((p) => {
        const soldout = p.status === "soldout" || (p.stock !== null && Number(p.stock) <= 0);
        const discount =
          p.list_price && Number(p.list_price) > Number(p.price)
            ? Math.round((1 - Number(p.price) / Number(p.list_price)) * 100)
            : 0;
        const isNew = p.created_at ? new Date(String(p.created_at)).getTime() > newerThan : false;
        const isBest = bestSellers.has(String(p.slug));
        // 품절이면 뱃지를 겹치지 않는다 — 품절이 먼저 읽혀야 한다
        const badges = soldout
          ? ""
          : [
              isBest ? `<span class="brick-tag brick-tag-best">${escapeHtml(t("card.best"))}</span>` : "",
              isNew ? `<span class="brick-tag brick-tag-new">${escapeHtml(t("card.new"))}</span>` : "",
              discount ? `<span class="brick-tag brick-tag-sale">${discount}%</span>` : "",
            ].filter(Boolean).join("");
        return `
  <a class="brick-product-card${soldout ? " is-soldout" : ""}" href="/shop/${encodeURIComponent(String(p.slug))}">
    <div class="brick-product-thumb">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" loading="lazy" />` : `<span class="brick-noimg">${escapeHtml(t("common.noImage"))}</span>`}
      ${soldout ? `<span class="brick-badge-soldout">${escapeHtml(t("common.soldout"))}</span>` : ""}
      ${badges ? `<div class="brick-tags">${badges}</div>` : ""}
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


      // 페이저는 게시판과 같은 프리미티브(.brick-pager)를 쓴다 — 테마가 이미 모양을 갖고 있다
      const pager = paged && totalPages > 1 ? renderPager(current, totalPages, (n) => linkWith({ page: n === 1 ? null : String(n) })) : "";
      const totalNote = paged && total > 0 ? `<span class="brick-shop-total">${escapeHtml(t("list.total", { n: total }))}</span>` : "";

      return `${heading}${priceBar}${totalNote}${sortBar}<div class="brick-product-grid" style="--brick-cols:${columns}">${cards}\n</div>${pager}${STOREFRONT_CSS}`;
    },
  };
  ctx.registerBlock(productListBlock);

  // ── 상품 상세 ─────────────────────────────────────
  const productDetailBlock: Parameters<PluginContext["registerBlock"]>[0] = {
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
    render: async (props, blockCtx) => {
      const slug = String(props.slug ?? props.__pathTail ?? "");
      if (!slug) return `<div class="brick-shop-empty">${escapeHtml(t("detail.pickProduct"))}</div>`;

      const { rows } = await db.execute(sql`
        SELECT id, slug, name, summary, description, image_url, images, price, list_price,
               stock, status, free_shipping, review_count, rating_sum, inquiry_count
        FROM shop_products WHERE slug = ${slug} AND status IN ('selling', 'soldout') LIMIT 1
      `);
      const p = rows[0];
      if (!p) return `<div class="brick-shop-empty">${escapeHtml(t("detail.notFound"))}</div>`;

      /**
       * 이 화면의 제목·설명은 상품이다 — 상품 링크를 공유하면 상품명이 보여야
       * 하고, 검색엔진에 모든 상품이 "쇼핑몰"이라는 같은 제목으로 보이면 안 된다.
       */
      blockCtx.setSeo?.({
        title: String(p.name ?? ""),
        description: String(p.summary ?? p.description ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 155),
        // 상품명을 자기 h1 으로 그린다
        ownHeading: true,
      });

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
        ? `<label class="brick-field">${escapeHtml(t("detail.option"))}
    <select id="brick-opt">
      ${options.map((o) => {
        const oSoldout = o.stock !== null && Number(o.stock) <= 0;
        const extra = Number(o.extra_price) > 0 ? ` (+${won(Number(o.extra_price))})` : "";
        return `<option value="${escapeHtml(o.id)}"${oSoldout ? " disabled" : ""}>${escapeHtml(o.name)}${extra}${oSoldout ? escapeHtml(t("detail.optionSoldout")) : ""}</option>`;
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
      ${gallery.length ? `<img id="brick-main-img" src="${escapeHtml(gallery[0])}" alt="${escapeHtml(p.name)}" />` : `<span class="brick-noimg">${escapeHtml(t("common.noImage"))}</span>`}
    </div>
    ${gallery.length > 1 ? `<div class="brick-gallery">${gallery.map((u, i) =>
      `<button type="button" class="${i === 0 ? "is-on" : ""}" data-src="${escapeHtml(u)}" aria-label="${escapeHtml(t("detail.imageN", { n: i + 1 }))}"><img src="${escapeHtml(u)}" alt="" loading="lazy" /></button>`,
    ).join("")}</div>` : ""}
  </div>
  <div class="brick-detail-info">
    <h1>${escapeHtml(p.name)}</h1>
    ${reviewCount > 0 ? `<p class="brick-detail-rating"><span class="brick-stars">${"★".repeat(Math.round(ratingAvg))}${"☆".repeat(5 - Math.round(ratingAvg))}</span> <strong>${ratingAvg.toFixed(1)}</strong> <a href="#brick-reviews">${escapeHtml(t("detail.reviewsLink", { n: reviewCount }))}</a></p>` : ""}
    ${p.summary ? `<p class="brick-detail-summary">${escapeHtml(p.summary)}</p>` : ""}
    <div class="brick-detail-price">
      ${p.list_price && Number(p.list_price) > Number(p.price) ? `<del>${won(Number(p.list_price))}</del>` : ""}
      <strong>${won(Number(p.price))}</strong>
    </div>
    <dl class="brick-detail-meta">
      <dt>${escapeHtml(t("detail.shipping"))}</dt>
      <dd>${p.free_shipping ? escapeHtml(t("detail.freeShipping")) : `${won(s.shippingFee)}${s.freeShippingOver > 0 ? escapeHtml(t("detail.freeOver", { amount: won(s.freeShippingOver) })) : ""}`}</dd>
      <dt>${escapeHtml(t("detail.stock"))}</dt>
      <dd>${p.stock === null ? escapeHtml(t("detail.canBuy")) : soldout ? escapeHtml(t("common.soldout")) : escapeHtml(t("detail.stockLeft", { n: Number(p.stock) }))}</dd>
    </dl>
    ${soldout ? `<div class="brick-soldout-notice">
      <p>${escapeHtml(t("detail.soldoutNotice"))}</p>
      ${restockForm(String(p.slug), soldoutOptions, !blockCtx.user)}
    </div>` : `
    <form class="brick-buy-form" data-product="${escapeHtml(p.id)}">
      ${optionSelect}
      <label class="brick-field">${escapeHtml(t("detail.qty"))}
        <input id="brick-qty" type="number" value="1" min="1" max="999" />
      </label>
      <div class="brick-buy-actions">
        <button type="button" data-act="cart">${escapeHtml(t("detail.cartBtn"))}</button>
        <button type="button" data-act="buy" class="brick-primary">${escapeHtml(t("detail.buyBtn"))}</button>
      </div>
      <p class="brick-buy-msg" role="status"></p>
      ${/*
         모바일 하단 고정 구매 바.
         폼 **안**에 둔다 — 구매 스크립트가 폼 안의 button[data-act] 를 이미 묶으므로
         옵션·수량·오류 처리가 그대로 재사용된다. 밖에 두면 같은 논리를 두 벌 쓰게 되고,
         두 벌은 반드시 어긋난다.
       */ ""}
      <div class="brick-buybar" aria-hidden="true">
        <div class="brick-buybar-info">
          <strong>${won(Number(p.price))}</strong>
          <span class="brick-buybar-msg" role="status"></span>
        </div>
        <button type="button" data-act="cart">${escapeHtml(t("detail.cartBtn"))}</button>
        <button type="button" data-act="buy" class="brick-primary">${escapeHtml(t("detail.buyBtn"))}</button>
      </div>
    </form>`}
  </div>
</div>
<div class="brick-detail-description">${String(p.description ?? "")}</div>
${
  // 상품은 팔지만 일부 옵션이 품절인 경우 — 가장 흔한 상황이다
  !soldout && soldoutOptions.length
    ? `<div class="brick-partial-soldout">
        <p>${escapeHtml(t("detail.partialSoldout"))}</p>
        ${restockForm(String(p.slug), soldoutOptions, !blockCtx.user)}
      </div>`
    : ""
}
${relatedHtml}
<a id="brick-reviews"></a>
${reviewSection({ id: String(p.id), reviewCount, ratingAvg, inquiryCount: Number(p.inquiry_count ?? 0) })}
<script type="application/ld+json">${jsonLd}</script>
${buyScript(`${shopBaseOf(blockCtx)}/cart`)}${GALLERY_SCRIPT}${restockScript()}${STOREFRONT_CSS}`;
    },
  };
  ctx.registerBlock(productDetailBlock);

  // ── 스토어프론트 (URL 라우팅) ──────────────────────
  //
  // 'shop' 페이지 하나로 쇼핑몰 전체가 동작한다:
  //   /shop              → 분류 내비 + 상품 목록 (?category= 필터)
  //   /shop/cart         → 장바구니
  //   /shop/event        → 진행 중 기획전 목록
  //   /shop/event/<slug> → 기획전 상세
  //   /shop/<slug>       → 상품 상세
  //
  // 게시판(board 블록)과 같은 방식이다. 이것이 없으면 운영자가 화면마다
  // 페이지를 만들어야 하고, 스타터·메뉴가 가리키는 주소가 404 가 된다.
  ctx.registerBlock({
    name: "storefront",
    displayName: "쇼핑몰 (목록·상세·장바구니·기획전을 URL로 전환)",
    propsSchema: {
      type: "object",
      properties: {
        limit: { type: "number", title: "목록의 상품 수", default: 24 },
        columns: { type: "number", title: "열 수", default: 4 },
      },
    },
    render: async (props, blockCtx) => {
      const tail = String(blockCtx.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      const seg = tail.split("/").filter(Boolean);

      if (!tail) {
        // 목록 — 분류 내비 + 상품 그리드. ?category= 로 좁힌다.
        const category = String(blockCtx.query?.category ?? "");
        const nav = await categoryListBlock.render({}, blockCtx);
        // 목록 화면에서는 손님이 정렬을 고를 수 있다(홈의 진열 섹션과 달리)
        const list = await productListBlock.render(
          {
            limit: props.limit ?? 24,
            columns: props.columns ?? 4,
            category,
            sortable: true,
            paged: true,
            priceFilter: true,
            stockFilter: true,
          },
          blockCtx,
        );
        return `${nav}\n${list}`;
      }
      /**
       * 화면마다 제목을 선언한다 — 안 하면 라우터 페이지 제목("쇼핑몰")이
       * 장바구니·주문서·주문내역의 문서 제목이 되고, 테마도 그 제목을 h1 으로
       * 그려서 무슨 화면인지 알 수 없다.
       */
      if (seg[0] === "cart") {
        blockCtx.setSeo?.({ title: t("cart.title") });
        return cartBlock.render({}, blockCtx);
      }
      if (seg[0] === "checkout") {
        blockCtx.setSeo?.({ title: t("checkout.title") });
        return checkoutBlock.render({}, blockCtx);
      }
      if (seg[0] === "orders") {
        blockCtx.setSeo?.({ title: seg[1] ? t("orders.detailTitle") : t("orders.title") });
        return ordersBlock.render({ orderNo: seg[1] ?? "" }, blockCtx);
      }
      if (seg[0] === "wishlist") {
        blockCtx.setSeo?.({ title: t("wish.title") });
        return wishlistBlock.render({}, blockCtx);
      }
      if (seg[0] === "coupons") {
        blockCtx.setSeo?.({ title: t("coupons.title") });
        return couponsBlock.render({}, blockCtx);
      }
      if (seg[0] === "event") {
        if (!seg[1]) blockCtx.setSeo?.({ title: t("collection.index") });
        return seg[1] ? renderCollectionPage(seg[1], blockCtx) : renderCollectionIndex();
      }
      // 그 외는 상품 상세 — 상세 블록이 없는 slug 는 "찾을 수 없습니다"를 그린다
      return productDetailBlock.render({ slug: seg[0] }, blockCtx);
    },
  });

  /** 진행 중 기획전 목록 */
  async function renderCollectionIndex(): Promise<string> {
    const items = await activeCollections(db);
    if (!items.length) {
      return `<div class="brick-shop-empty">${escapeHtml(t("collection.empty"))}</div>${STOREFRONT_CSS}`;
    }
    const cards = items
      .map((c) => `<a class="brick-collection-card" href="/shop/event/${encodeURIComponent(c.slug)}">
  <strong>${escapeHtml(c.title)}</strong>
  ${c.description ? `<p>${escapeHtml(c.description)}</p>` : ""}
  <span>${escapeHtml(t("collection.products", { n: c.productCount }))}${c.endsAt ? escapeHtml(t("collection.until", { date: shortDateLocalized(c.endsAt) })) : ""}</span>
</a>`)
      .join("");
    return `<div class="brick-collection-list"><h1>${escapeHtml(t("collection.index"))}</h1>${cards}</div>${COLLECTION_CSS}${STOREFRONT_CSS}`;
  }

  /** 기획전 상세 — 종료돼도 404 대신 안내를 보여준다 (공유된 링크로 온 손님) */
  async function renderCollectionPage(slug: string, blockCtx?: BlockRenderContext): Promise<string> {
    const c = await viewCollection(db, slug);
    if (!c) return `<div class="brick-shop-empty">${escapeHtml(t("collection.notFound"))}</div>${STOREFRONT_CSS}`;

    const notice =
      c.state === "ended" ? `<p class="brick-collection-notice">${escapeHtml(t("collection.ended"))}</p>`
      : c.state === "upcoming" ? `<p class="brick-collection-notice">${escapeHtml(t("collection.upcoming"))}</p>`
      : "";
    const cards = c.products
      .map((p) => `<a class="brick-product-card" href="/shop/${encodeURIComponent(p.slug)}">
  <span class="brick-product-thumb">${
    p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy" />`
      : `<span class="brick-noimg">${escapeHtml(t("common.noImage"))}</span>`
  }${p.soldout ? `<span class="brick-badge-soldout">${escapeHtml(t("common.soldout"))}</span>` : ""}</span>
  <span class="brick-product-name">${escapeHtml(p.name)}</span>
  <span class="brick-product-price">${
    p.listPrice && p.listPrice > p.price ? `<del>${won(p.listPrice)}</del> ` : ""
  }<strong>${won(p.price)}</strong></span>
</a>`)
      .join("");
    blockCtx?.setSeo?.({ title: c.title, description: c.description ?? undefined, ownHeading: true });
    return `<div class="brick-collection">
  <h1>${escapeHtml(c.title)}</h1>
  ${c.description ? `<p class="brick-collection-desc">${escapeHtml(c.description)}</p>` : ""}
  ${notice}
  ${c.products.length
    ? `<div class="brick-product-grid" style="--brick-cols:4">${cards}</div>`
    : `<p class="brick-shop-empty">${escapeHtml(t("collection.noProducts"))}</p>`}
</div>${COLLECTION_CSS}${STOREFRONT_CSS}`;
  }

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
      return relatedSection(related, props.title ? String(props.title) : undefined);
    },
  });

  // ── 분류 목록 ─────────────────────────────────────
  const categoryListBlock: Parameters<PluginContext["registerBlock"]>[0] = {
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
  };
  ctx.registerBlock(categoryListBlock);

  // ── 장바구니 ──────────────────────────────────────
  const cartBlock: Parameters<PluginContext["registerBlock"]>[0] = {
    name: "cart",
    displayName: "장바구니",
    render: async (_props, blockCtx) => `
<div class="brick-cart" id="brick-cart">
  <p class="brick-cart-loading">${escapeHtml(t("cart.loading"))}</p>
</div>
${cartScript(shopBaseOf(blockCtx))}${STOREFRONT_CSS}`,
  };
  ctx.registerBlock(cartBlock);

  const checkoutBlock = registerCheckoutView(ctx, t);
  const ordersBlock = registerOrdersView(ctx, t);
  const { wishlistBlock } = registerWishlistView(ctx, t);
  const { couponsBlock } = registerCouponsView(ctx, t);

  /*
   * 화면 선언 — 쇼핑몰과 그 안의 회원 화면들.
   *
   * `shop` 을 선언해 두면 **페이지 없이도 쇼핑몰이 돌아간다** (스타터를 쓰지 않고
   * 플러그인만 켠 사이트에서도 장바구니 헤더 링크가 살아 있다). 스타터가 만든
   * shop 페이지가 있으면 그 페이지가 이기고, 결과는 같다 — 같은 블록을 그린다.
   *
   * 회원 화면 셋은 `/account` 의 "내 활동"에 링크로 나온다. 특히 쿠폰함은
   * 생일 쿠폰이 자동으로 들어오는 곳인데 그것을 볼 화면이 없었다.
   */
  ctx.registerScreen({ path: "shop", title: "쇼핑몰", block: "storefront" });
  ctx.registerScreen({ path: "shop/orders", title: "주문 내역", block: "orders", memberMenu: true, order: 10 });
  ctx.registerScreen({ path: "shop/coupons", title: "쿠폰함", block: "my-coupons", memberMenu: true, order: 15 });
  ctx.registerScreen({ path: "shop/wishlist", title: "위시리스트", block: "wishlist", memberMenu: true, order: 25 });
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
function relatedSection(items: RelatedProduct[], title?: string): string {
  const heading = title ?? t("related.title");
  if (!items.length) return "";
  const cards = items
    .map((r) => {
      const href = `/shop/${encodeURIComponent(r.slug)}`;
      const thumb = r.imageUrl
        ? `<img src="${escapeHtml(r.imageUrl)}" alt="${escapeHtml(r.name)}" loading="lazy" />`
        : `<span class="brick-noimg">${escapeHtml(t("common.noImage"))}</span>`;
      const soldout = r.status === "soldout" ? `<span class="brick-badge-soldout">${escapeHtml(t("common.soldout"))}</span>` : "";
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
  <h2>${escapeHtml(heading)}</h2>
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
  isGuest: boolean,
): string {
  const picker =
    soldoutOptions.length > 1
      ? `<label class="brick-field">${escapeHtml(t("restock.soldoutOption"))}
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
    <label class="brick-field">${escapeHtml(t("restock.email"))}
      <input type="email" name="email" placeholder="name@example.com" required />
    </label>
    ${isGuest ? captchaFieldHtml({
      label: t("captcha.label"), reload: t("captcha.reload"), placeholder: t("captcha.placeholder"),
    }) : ""}
    <button type="button" data-act="restock">${escapeHtml(t("restock.submit"))}</button>
    <p class="brick-restock-msg" role="status"></p>
    <p class="brick-restock-note">${escapeHtml(t("restock.note"))}</p>
  </form>`;
}

/**
 * 재입고 알림 신청 스크립트.
 *
 * 품절 화면에서만 렌더되므로 항상 붙여도 부담이 없다.
 * 옵션이 있는 상품은 선택된 옵션을 함께 보낸다 — "M 사이즈만 품절"이 대부분이다.
 */
const restockScript = () => `
<script>
${CAPTCHA_WIDGET_JS}
(function () {
  // 폼이 둘일 수 있다 (품절 상품 + 품절 옵션). 각각 붙인다.
  Array.prototype.forEach.call(document.querySelectorAll(".brick-restock-form"), attach);

  function attach(form) {
  var btn = form.querySelector('[data-act="restock"]');
  var msg = form.querySelector(".brick-restock-msg");
  btn.addEventListener("click", function () {
    var email = form.querySelector('input[name="email"]').value.trim();
    if (!email) { msg.textContent = ${JSON.stringify(t("restock.emailRequired"))}; return; }
    // 옵션은 이 폼 안에서 읽는다 — 구매용 드롭다운을 읽으면 다른 옵션이 섞인다
    var opt = form.querySelector('[name="optionId"]');
    var body = { email: email };
    if (opt && opt.value) body.optionId = opt.value;
    // 비회원은 캡차를 함께 보낸다 (칸이 없거나 캡차가 꺼져 있으면 빈 값)
    var cap = window.brickCaptcha.of(form);
    Object.keys(cap.fields).forEach(function (k) { body[k] = cap.fields[k]; });
    btn.disabled = true;
    msg.textContent = ${JSON.stringify(t("restock.submitting"))};
    fetch("/api/plugins/brick-shop/products/" + encodeURIComponent(form.dataset.slug) + "/restock-alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        // 실패 이유를 그대로 보여준다 — "이미 신청했습니다"를 감추면 손님이 계속 누른다
        // 토큰은 1회용이므로 실패하면 새 문제를 받아야 한다
        if (!res.ok) cap.reload();
        msg.textContent = res.ok
          ? ${JSON.stringify(t("restock.done"))}.replace("{email}", res.d.email)
          : (res.d.message || ${JSON.stringify(t("restock.fail"))});
        if (res.ok) form.querySelector('input[name="email"]').value = "";
      })
      .catch(function () { msg.textContent = ${JSON.stringify(t("restock.fail"))}; })
      .finally(function () { btn.disabled = false; });
  });
  }
})();
</script>`;

/** 기획전 카드용 짧은 날짜 — 형식도 언어를 따라간다 */
function shortDateLocalized(d: Date | string): string {
  const at = new Date(d);
  return t("date.short", { m: at.getMonth() + 1, d: at.getDate() });
}

const COLLECTION_CSS = `
<style>
.brick-collection-list h1,.brick-collection h1{font-size:24px;letter-spacing:-.5px}
.brick-collection-card{display:block;padding:20px;margin-bottom:12px;border:1px solid var(--brick-border,#e5e5ea);border-radius:12px;text-decoration:none;color:inherit}
.brick-collection-card strong{font-size:17px}
.brick-collection-card p{margin:6px 0 0;color:var(--color-muted, #6c6c7a);font-size:14px}
.brick-collection-card span{display:block;margin-top:8px;color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-collection-desc{color:var(--color-text-soft, #45454f)}
.brick-collection-notice{padding:10px 14px;background:var(--brick-surface,#f7f7fa);border-radius:8px;color:var(--color-danger, #c9342f);font-weight:600}
</style>`;

/* ── 스토어프론트 CSS ────────────────────────────────
   테마가 빌드를 타지 않으므로 블록이 자기 스타일을 함께 낸다.
   CSS 변수는 테마 토큰을 우선 사용해 테마 디자인과 어울리게 한다. */
const STOREFRONT_CSS = `
<style>
.brick-partial-soldout{margin-top:28px;padding:16px;background:var(--brick-surface,#f7f7fa);border-radius:10px}
.brick-partial-soldout>p{margin:0 0 4px;font-weight:600}
.brick-restock-form{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-width:360px}
.brick-restock-form button{padding:11px 16px;cursor:pointer;border-radius:var(--radius, 10px);border:1px solid var(--color-primary, #cf4437);background:var(--color-primary, #cf4437);color:var(--color-on-primary, #fff);font-weight:600}
.brick-restock-form button:hover{background:var(--color-primary-hover, #b63a2e);border-color:var(--color-primary-hover, #b63a2e)}
.brick-restock-msg{margin:0;font-size:13px;color:var(--brick-accent,#0a7)}
.brick-restock-note{margin:0;font-size:12px;color:var(--color-muted, #6c6c7a)}
.brick-related{margin:48px 0 0}
.brick-related h2{font-size:19px;margin:0 0 4px;padding-top:24px;border-top:1px solid var(--brick-border,#e5e5ea)}
.brick-product-grid{display:grid;grid-template-columns:repeat(var(--brick-cols,4),1fr);gap:20px;margin:20px 0}
@media(max-width:1024px){.brick-product-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}}
@media(max-width:640px){.brick-product-grid{grid-template-columns:repeat(2,1fr);gap:14px}}
.brick-product-card{display:block;text-decoration:none;color:inherit;transition:transform .16s ease}
.brick-product-card:hover{transform:translateY(-2px)}
.brick-product-card:hover .brick-product-name{color:var(--color-primary-text, #b63a2e)}
.brick-product-thumb{position:relative;aspect-ratio:1;background:var(--color-bg-soft, #f6f6f9);border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 14px);overflow:hidden;display:flex;align-items:center;justify-content:center;transition:border-color .16s ease}
.brick-product-card:hover .brick-product-thumb{border-color:var(--color-line-strong, #d0d0d9)}
.brick-product-thumb img{width:100%;height:100%;object-fit:cover}
.brick-noimg{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-noimg::before{
  content:"";opacity:.55;width:34px;height:28px;border:2px solid currentColor;border-radius:4px;
  background:
    radial-gradient(circle at 9px 9px, currentColor 2.5px, transparent 3px),
    linear-gradient(135deg, transparent 55%, currentColor 55%, currentColor 72%, transparent 72%);
}
.brick-shop-total{display:block;margin:12px 0 -4px;font-size:13.5px;color:var(--color-muted, #6c6c7a)}
.brick-sort{display:flex;flex-wrap:wrap;gap:2px;margin:14px 0 4px;align-items:center}
.brick-sort a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;font-size:13.5px;color:var(--color-muted, #6c6c7a);text-decoration:none;border-radius:var(--radius, 3px);transition:color .16s ease,background .16s ease}
.brick-sort a:hover{color:var(--color-text, #17171c);background:var(--color-bg-soft, #f6f6f9)}
.brick-sort a.is-on{color:var(--color-text, #17171c);font-weight:700;background:var(--color-bg-soft, #f6f6f9)}
.brick-filter{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:16px 0 2px;padding-bottom:14px;border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-filter-label{font-size:13px;font-weight:700;color:var(--color-muted, #6c6c7a);margin-right:4px}
.brick-filter a{display:inline-flex;align-items:center;min-height:34px;padding:0 13px;font-size:13.5px;color:var(--color-text-soft, #45454f);text-decoration:none;border:1px solid var(--color-line, #e4e4ea);border-radius:999px;transition:border-color .16s ease,color .16s ease,background .16s ease}
.brick-filter a:hover{border-color:var(--color-text-soft, #45454f);color:var(--color-text, #17171c)}
.brick-filter a.is-on{border-color:var(--color-text, #17171c);background:var(--color-text, #17171c);color:var(--color-bg, #ffffff);font-weight:600}
.brick-filter-toggle{margin-left:10px}
/* 체크는 항상 자리를 차지한다 (색만 감춘다) — 켜고 끌 때 글자가 밀리지 않게 */
.brick-filter-toggle::before{content:"✓";display:inline-grid;place-items:center;width:14px;height:14px;margin-right:7px;border:1px solid var(--color-line, #e4e4ea);border-radius:3px;font-size:10px;line-height:1;color:transparent}
.brick-filter-toggle.is-on::before{border-color:currentColor;color:currentColor}
.brick-tags{position:absolute;top:8px;left:8px;display:flex;flex-wrap:wrap;gap:4px;z-index:1}
.brick-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;font-size:11px;font-weight:700;letter-spacing:.02em;border-radius:var(--radius, 3px);color:#fff;background:#111318}
.brick-tag-new{background:#1f7a4d}
.brick-tag-best{background:#8a3ab0}
.brick-tag-sale{background:#c8322f}
.brick-badge-soldout{position:absolute;top:8px;left:8px;padding:4px 10px;border-radius:999px;background:rgba(20,20,28,.82);color:#fff;font-size:12px;font-weight:700;line-height:1.4}
.brick-product-card.is-soldout .brick-product-thumb img{opacity:.55}
.brick-product-card.is-soldout .brick-product-name{color:var(--color-muted, #6c6c7a)}
.brick-product-name{margin-top:10px;font-size:15px;line-height:1.4}
.brick-product-price{margin-top:4px;display:flex;align-items:baseline;gap:6px;font-size:15px}
.brick-product-price del{color:var(--color-muted, #6c6c7a);font-size:13px}
.brick-discount{color:var(--color-primary,#d0402c);font-weight:700}
.brick-shop-heading{margin:8px 0 0;font-size:22px}
.brick-shop-empty{padding:40px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-category-list{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.brick-category-list a{padding:7px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:20px;text-decoration:none;color:inherit;font-size:14px}
.brick-category-list a span{color:var(--color-muted, #6c6c7a);font-size:12px}
.brick-product-detail{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin:20px 0}
@media(max-width:640px){.brick-product-detail{grid-template-columns:1fr;gap:20px}}
.brick-detail-media{aspect-ratio:1;background:var(--color-bg-soft, #f6f6f9);border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 14px);overflow:hidden;display:flex;align-items:center;justify-content:center}
.brick-detail-media img{width:100%;height:100%;object-fit:cover}
.brick-detail-info h1{margin:0 0 8px;font-size:26px;line-height:1.3}
.brick-detail-summary{color:var(--color-text-soft, #45454f);margin:0 0 16px}
.brick-detail-price{display:flex;align-items:baseline;gap:8px;font-size:26px;margin-bottom:18px}
.brick-detail-price del{color:var(--color-muted, #6c6c7a);font-size:16px}
.brick-detail-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14px;margin:0 0 20px;padding:16px 0;border-top:1px solid var(--color-line, #e4e4ea);border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-detail-meta dt{color:var(--color-muted, #6c6c7a)}
.brick-detail-meta dd{margin:0}
.brick-field{display:block;margin-bottom:12px;font-size:14px}
.brick-field select,.brick-field input{display:block;width:100%;max-width:280px;padding:9px;margin-top:4px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;box-sizing:border-box}
.brick-buy-actions{display:flex;gap:10px;margin-top:18px}
.brick-buy-actions button{flex:1;padding:14px;border:1px solid var(--color-line, #e4e4ea);border-radius:8px;background:var(--color-bg, #ffffff);font-size:15px;cursor:pointer}
.brick-buy-actions .brick-primary{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent;font-weight:700}
.brick-buy-msg{min-height:20px;font-size:14px;margin:10px 0 0}
/* 하단 고정 구매 바 — 좁은 화면에서만. 넓은 화면은 원래 버튼이 늘 보인다 */
.brick-buybar{display:none}
@media(max-width:640px){
  .brick-buybar.is-on{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:60;gap:8px;align-items:center;
    padding:10px 12px;padding-bottom:max(10px, env(safe-area-inset-bottom));
    background:var(--color-bg, #ffffff);border-top:1px solid var(--color-line, #e4e4ea);box-shadow:0 -2px 12px rgba(0,0,0,.08)}
  .brick-buybar-info{flex:1;min-width:0;display:grid}
  .brick-buybar-info strong{font-size:16px;line-height:1.2}
  .brick-buybar-msg{font-size:11.5px;color:var(--color-muted, #6c6c7a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .brick-buybar button{flex:0 0 auto;min-height:44px;padding:0 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:8px;
    background:var(--color-bg, #ffffff);font-size:14px;cursor:pointer}
  .brick-buybar button.brick-primary{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent;font-weight:700}
  /* 바가 가리는 만큼 아래를 비운다. 테마의 고정 버튼도 위로 올린다 —
     .brick-quick 이 없는 테마에는 아무 일도 일어나지 않는다 */
  .brick-buybar-on body{padding-bottom:76px}
  .brick-buybar-on .brick-quick{bottom:84px}
}
.brick-soldout-notice{padding:16px;background:var(--color-line, #e4e4ea);border-radius:8px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-detail-description{margin:40px 0;line-height:1.8}
.brick-cart table{width:100%;border-collapse:collapse;font-size:14px}
.brick-cart th,.brick-cart td{padding:12px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);text-align:left}
.brick-cart-total{margin-top:20px;padding:20px;background:var(--color-bg-soft, #f6f6f9);border-radius:10px}
.brick-cart-total dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0}
.brick-cart-total dt{color:var(--color-text-soft, #45454f)}
.brick-cart-total dd{margin:0;text-align:right}
.brick-cart-total .brick-grand{font-size:20px;font-weight:700;padding-top:10px;border-top:1px solid var(--color-line, #e4e4ea)}
.brick-cart-qty{width:64px;padding:6px;border:1px solid var(--color-line, #e4e4ea);border-radius:5px}
.brick-detail-rating{display:flex;align-items:center;gap:7px;margin:0 0 10px;font-size:15px}
.brick-detail-rating a{color:var(--color-muted, #6c6c7a);font-size:13px}
.brick-card-rating{margin-top:3px;font-size:13px;color:var(--color-muted, #6c6c7a);display:flex;gap:4px;align-items:center}
.brick-stars{color:var(--color-warning, #96610a);letter-spacing:1px}
/* 캡차 위젯 — .brick-restock-form button 뒤에 와야 새로고침 버튼이 작게 남는다 */
${CAPTCHA_WIDGET_CSS}
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
/**
 * 이 블록이 놓인 페이지의 기준 경로. "바로 구매"가 이동할 장바구니 주소를
 * 만들 때 쓴다 — '/cart' 로 하드코딩하면 상점 페이지 slug 가 'shop' 일 때
 * 존재하지 않는 경로로 떨어진다 (장바구니는 <상점 페이지>/cart 로 라우팅된다).
 */
interface PriceBand {
  /** 하한 (포함) */
  min: number;
  /** 상한 (미만). null 이면 "이상" — 열린 구간 */
  max: number | null;
  /** 이 구간에 걸리는 상품 수 (개수 질의 뒤에 채워진다) */
  count?: number;
}

/**
 * 가격대 눈금을 상품 값에서 만든다.
 *
 * 고정 구간("1만원 미만 / 1만~3만 / …")은 5,000원짜리 소품만 파는 가게와 500만원짜리
 * 가구를 파는 가게에서 동시에 쓸모없다 — 전자는 모든 상품이 첫 칸에, 후자는 마지막 칸에
 * 몰린다. 그래서 실제 최저·최고가에서 구간을 뽑고, 경계는 1·2·5×10ⁿ 격자에 맞춘다:
 * "47,325원 미만" 같은 눈금은 계산해서 나온 값이어도 손님에게는 고장으로 보인다.
 */
function priceBands(lo: number, hi: number): PriceBand[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const step = niceStep((hi - lo) / 4);
  const bounds: number[] = [];
  for (let b = Math.floor(lo / step) * step + step; b < hi && bounds.length < 4; b += step) bounds.push(b);
  if (!bounds.length) return [];
  const bands: PriceBand[] = [{ min: 0, max: bounds[0] }];
  for (let i = 1; i < bounds.length; i++) bands.push({ min: bounds[i - 1], max: bounds[i] });
  bands.push({ min: bounds[bounds.length - 1], max: null });
  return bands;
}

/** 1·2·5×10ⁿ 중 x 이상인 가장 작은 값 — 사람이 읽는 눈금 */
function niceStep(x: number): number {
  const target = Math.max(1, x);
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5]) if (target <= mag * m) return mag * m;
  return mag * 10;
}

function bandLabel(b: PriceBand): string {
  if (b.max === null) return t("filter.over", { price: won(b.min) });
  if (b.min === 0) return t("filter.under", { price: won(b.max) });
  return t("filter.range", { from: won(b.min), to: won(b.max) });
}

/**
 * 페이지 번호 막대 — 게시판의 것과 같은 구조·클래스(.brick-pager)다.
 * 코드를 공유하지 않는 이유: 플러그인끼리 의존하면 하나를 끄면 다른 하나가 깨진다.
 * 클래스 계약만 공유하고(테마가 모양을 갖는다) 구현은 각자 둔다.
 */
function renderPager(current: number, totalPages: number, link: (n: number) => string): string {
  const window = 5;
  const start = Math.max(1, current - Math.floor(window / 2));
  const end = Math.min(totalPages, start + window - 1);
  const parts: string[] = [];
  if (current > 1) parts.push(`<a href="${escapeHtml(link(current - 1))}">&#8249; ${escapeHtml(t("pager.prev"))}</a>`);
  if (start > 1) parts.push(`<a href="${escapeHtml(link(1))}">1</a>${start > 2 ? "<span>&hellip;</span>" : ""}`);
  for (let n = start; n <= end; n++) {
    parts.push(n === current ? `<strong>${n}</strong>` : `<a href="${escapeHtml(link(n))}">${n}</a>`);
  }
  if (end < totalPages) {
    parts.push(`${end < totalPages - 1 ? "<span>&hellip;</span>" : ""}<a href="${escapeHtml(link(totalPages))}">${totalPages}</a>`);
  }
  if (current < totalPages) parts.push(`<a href="${escapeHtml(link(current + 1))}">${escapeHtml(t("pager.next"))} &#8250;</a>`);
  return `<nav class="brick-pager" aria-label="${escapeHtml(t("pager.label"))}">${parts.join("")}</nav>`;
}

function shopBaseOf(blockCtx?: { path?: string; pathTail?: string }): string {
  const path = String(blockCtx?.path ?? "").replace(/^\/+|\/+$/g, "");
  const tail = String(blockCtx?.pathTail ?? "").replace(/^\/+|\/+$/g, "");
  const base = tail && path.endsWith(tail)
    ? path.slice(0, path.length - tail.length).replace(/\/+$/g, "")
    : path;
  return `/${base || "shop"}`;
}

const buyScript = (cartPath: string) => `
<script>
(function(){
  var form = document.currentScript.parentNode.querySelector('.brick-buy-form');
  if (!form) return;
  var msg = form.querySelector('.brick-buy-msg');
  var barMsg = form.querySelector('.brick-buybar-msg');
  // 하단 바에서 누르면 폼의 안내문은 화면 밖이다 — 두 곳에 같은 말을 쓴다
  function say(text){ msg.textContent = text; if (barMsg) barMsg.textContent = text; }
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
      say(${JSON.stringify(t("buy.processing"))});
      fetch('/api/plugins/brick-shop/cart', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload())
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(res){
          if (!res.ok) { say(res.d.message || ${JSON.stringify(t("buy.addFail"))}); return; }
          if (res.d.guestToken) localStorage.setItem('brick_shop_guest', res.d.guestToken);
          if (btn.dataset.act === 'buy') { location.href = ${JSON.stringify(cartPath)}; return; }
          say(${JSON.stringify(t("buy.added"))});
        })
        .catch(function(){ say(${JSON.stringify(t("buy.error"))}); });
    });
  });

  /*
   * 하단 바는 **원래 버튼이 화면에서 사라졌을 때만** 나온다.
   * 늘 띄워두면 좁은 화면의 세로를 상시로 먹고, 버튼이 바로 위에 보이는데 아래에도
   * 있으면 어느 것을 눌러야 하는지 헷갈린다. IntersectionObserver 가 없는 브라우저에서는
   * 바를 내지 않는다 — 없어도 원래 버튼으로 살 수 있다.
   */
  var bar = form.querySelector('.brick-buybar');
  var anchor = form.querySelector('.brick-buy-actions');
  if (bar && anchor && 'IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      var gone = !entries[0].isIntersecting;
      bar.classList.toggle('is-on', gone);
      // 화면 낭독기에 같은 버튼이 두 벌 읽히지 않게
      if (gone) bar.removeAttribute('aria-hidden'); else bar.setAttribute('aria-hidden', 'true');
      // 테마가 고정 요소(맨 위로 버튼 등)를 비켜 놓을 수 있게 훅을 남긴다
      document.documentElement.classList.toggle('brick-buybar-on', gone);
    }, { rootMargin: '0px' }).observe(anchor);
  }
})();
</script>`;

/* ── 장바구니 화면 스크립트 ─────────────────────────── */
const cartScript = (shopBase: string) => `
<script>
(function(){
  var root = document.getElementById('brick-cart');
  if (!root) return;
  var guest = localStorage.getItem('brick_shop_guest');
  var qs = guest ? '?guest=' + encodeURIComponent(guest) : '';

  ${moneyFnScript("fmt")}
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function render(d){
    if (!d.items || !d.items.length) {
      // 빈 장바구니가 막다른 골목이 되지 않게 — 상점으로 가는 길을 함께 준다
      root.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("cart.empty"))} +
        ' <a href="' + ${JSON.stringify(shopBase)} + '">' + ${JSON.stringify(t("cart.goShop"))} + '</a></p>';
      return;
    }
    var rows = d.items.map(function(it){
      return '<tr data-item="' + esc(it.id) + '">' +
        '<td>' + esc(it.productName) + (it.optionName ? ' <small>(' + esc(it.optionName) + ')</small>' : '') + '</td>' +
        '<td>' + fmt(it.unitPrice) + '</td>' +
        '<td><input class="brick-cart-qty" type="number" min="1" max="999" value="' + Number(it.quantity) + '" /></td>' +
        '<td>' + fmt(it.lineTotal) + '</td>' +
        '<td><button data-remove>' + ${JSON.stringify(t("common.delete"))} + '</button></td></tr>';
    }).join('');

    root.innerHTML =
      '<p class="brick-cart-orders-link"><a href="' + ${JSON.stringify(shopBase)} + '/orders">' + ${JSON.stringify(t("orders.linkFromCart"))} + ' →</a></p>' +
      '<table><thead><tr><th>' + ${JSON.stringify(t("cart.colProduct"))} + '</th><th>' + ${JSON.stringify(t("cart.colUnit"))} + '</th><th>' + ${JSON.stringify(t("cart.colQty"))} + '</th><th>' + ${JSON.stringify(t("cart.colSum"))} + '</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="brick-cart-total"><dl>' +
      '<dt>' + ${JSON.stringify(t("cart.subtotal"))} + '</dt><dd>' + fmt(d.subtotal) + '</dd>' +
      (d.discount ? '<dt>' + ${JSON.stringify(t("cart.discount"))} + '</dt><dd>-' + fmt(d.discount) + '</dd>' : '') +
      '<dt>' + ${JSON.stringify(t("cart.shipping"))} + '</dt><dd>' + (d.shippingFee ? fmt(d.shippingFee) : ${JSON.stringify(t("cart.free"))}) + '</dd>' +
      '<dt class="brick-grand">' + ${JSON.stringify(t("cart.grand"))} + '</dt><dd class="brick-grand">' + fmt(d.total) + '</dd>' +
      '</dl><div class="brick-buy-actions"><a class="brick-primary" href="' + ${JSON.stringify(shopBase)} + '/checkout" ' +
      'style="flex:1;padding:14px;border-radius:8px;text-align:center;text-decoration:none">' + ${JSON.stringify(t("cart.order"))} + '</a></div></div>';

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
      .catch(function(){ root.innerHTML = '<p class="brick-shop-empty">' + ${JSON.stringify(t("cart.loadFail"))} + '</p>'; });
  }
  load();
})();
</script>`;
