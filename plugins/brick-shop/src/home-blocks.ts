/**
 * 홈·안내 페이지에 놓는 블록 — 진짜 후기 모음 · 구매 안내.
 *
 * 쇼핑몰 스타터의 홈에는 "먼저 써 본 분들의 이야기" 가 **지어낸 이름과 문장**으로 박혀 있었다
 * (core/testimonials 의 예시). 운영자가 지우지 않고 문을 열면 그것은 거짓 후기다 — 표시광고법이
 * 막는 일이다. 손님이 실제로 남긴 후기를 읽어 그리는 블록으로 바꾼다. 후기가 없으면 아무것도 그리지
 * 않는다(지어내서 채우지 않는다).
 *
 * 이용 안내 페이지는 "3만원 이상 무료배송" 을 글자로 적고 있었는데 설정의 기준은 5만원이었다. 같은 규칙을
 * 두 곳에 적으면 언젠가 어긋난다 — 상품 상세의 구매 안내(설정값과 법으로 만든다)를 그대로 블록으로 낸다.
 */
import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, type Db, type ShopSettings } from "./types.js";
import { t } from "./i18n.js";
import { DETAIL_EXTRAS_CSS, purchaseGuideHtml } from "./detail-extras.js";

/** 후기 본문에서 태그를 걷어 한 줄 요약으로 */
function excerpt(html: unknown, max = 90): string {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 사이트 안 경로나 http(s) 만 그림으로 싣는다 (서버 쪽 — 브라우저처럼 URL 로 푼다) */
function safeImage(u: unknown): string | null {
  const s = String(u ?? "").trim();
  if (!s) return null;
  try {
    const url = new URL(s, "https://site.invalid");
    return url.protocol === "https:" || url.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}

export function registerHomeBlocks(ctx: PluginContext, db: Db, settings: () => Promise<ShopSettings>, shopBase = "/shop"): void {
  ctx.registerBlock({
    name: "review-highlights",
    displayName: "베스트 후기",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string", title: "제목", default: "REVIEW" },
        subtitle: { type: "string", title: "부제", default: "손님이 직접 남긴 후기" },
        limit: { type: "number", title: "표시 개수", default: 4 },
      },
    },
    render: async (props) => {
      const limit = Math.min(12, Math.max(1, Number(props.limit ?? 4)));
      /*
       * 별점 4 이상 · 숨기지 않은 후기 · 판매 중인 상품. 사진 후기를 먼저(손님이 가장 먼저 찾는 것이 남의 사진이다),
       * 같은 상품의 후기가 줄을 다 채우지 않게 상품마다 하나씩.
       */
      const { rows } = await db.execute(sql`
        SELECT DISTINCT ON (r.product_id)
               r.id, r.rating, r.content, r.images, r.author_name, r.created_at,
               p.slug, p.name, coalesce(p.thumb_url, p.image_url) AS product_image
        FROM shop_reviews r JOIN shop_products p ON p.id = r.product_id
        WHERE r.is_visible = true AND r.rating >= 4 AND p.status IN ('selling', 'soldout') AND p.adult_only = false
        ORDER BY r.product_id, (jsonb_array_length(r.images) > 0) DESC, r.created_at DESC
      `);
      const picked = rows
        .sort((a, b) => Number(jsonLen(b.images) > 0) - Number(jsonLen(a.images) > 0) || String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
      if (!picked.length) return "";
      const cards = picked.map((r) => {
        const photo = safeImage(Array.isArray(r.images) && r.images.length ? (r.images as unknown[])[0] : r.product_image);
        const stars = Math.max(1, Math.min(5, Number(r.rating)));
        return `<a class="brick-rh-card" href="${escapeHtml(shopBase)}/${encodeURIComponent(String(r.slug))}#brick-reviews">
    <span class="brick-rh-photo">${photo ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy" />` : ""}</span>
    <span class="brick-rh-stars" aria-label="${escapeHtml(t("reviews.avgAria", { n: stars }))}">${"★".repeat(stars)}${"☆".repeat(5 - stars)}</span>
    <span class="brick-rh-text">${escapeHtml(excerpt(r.content))}</span>
    <span class="brick-rh-meta"><b>${escapeHtml(String(r.author_name ?? ""))}</b> · ${escapeHtml(String(r.name ?? ""))}</span>
  </a>`;
      }).join("");
      const title = String(props.title ?? "REVIEW");
      const sub = String(props.subtitle ?? "");
      return `<section class="brick-review-highlights">
  <div class="brick-shop-head"><div><h2 class="brick-shop-heading">${escapeHtml(title)}</h2>${sub ? `<p class="brick-shop-sub">${escapeHtml(sub)}</p>` : ""}</div></div>
  <div class="brick-rh-grid">${cards}</div>
</section>
<style>
.brick-review-highlights{margin:clamp(40px,6vw,72px) 0}
.brick-rh-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-top:20px}
.brick-rh-card{display:flex;flex-direction:column;gap:8px;padding:0 0 16px;border-radius:var(--radius-lg, 12px);background:var(--color-bg-soft, #f6f6f9);color:inherit;text-decoration:none;overflow:hidden}
.brick-rh-photo{display:block;aspect-ratio:1;background:var(--color-bg-sunken, #eef0f3)}
.brick-rh-photo img{width:100%;height:100%;object-fit:cover;display:block}
.brick-rh-stars{padding:4px 16px 0;color:var(--color-primary-text, #b63a2e);letter-spacing:1px;font-size:14px}
.brick-rh-text{padding:0 16px;font-size:15px;line-height:1.6;color:var(--color-text, #17171c);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.brick-rh-meta{padding:0 16px;font-size:13px;color:var(--color-muted, #6c6c7a)}
.brick-rh-card:hover .brick-rh-text{text-decoration:underline}
@media(max-width:860px){.brick-rh-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}
</style>`;
    },
  });

  ctx.registerBlock({
    name: "purchase-guide",
    displayName: "구매 안내 (배송·교환·반품)",
    render: async () => `${purchaseGuideHtml(await settings(), false)}${DETAIL_EXTRAS_CSS}`,
  });
}

function jsonLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
