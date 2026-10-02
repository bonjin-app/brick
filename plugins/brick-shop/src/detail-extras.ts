/**
 * 상품 상세의 덧붙이 — 경로(빵부스러기) · 구매 안내 · 섹션 이동 막대 · 수량 단추와 합계.
 *
 * 카페24 상품 상세와 나란히 놓고 본 빈자리들이다:
 *  - 상품이 어느 분류에 있는지 화면에 없었다 → 위로 올라갈 길이 헤더 메뉴뿐이었다.
 *  - **배송·교환·반품 안내가 없었다.** 전자상거래법 제13조는 청약철회의 기한·행사방법·효과를
 *    재화의 표시·광고에 담으라고 정한다. 법이 정한 문장은 설정값으로 만들 수 있으므로 운영자가
 *    빈칸을 채우지 않아도 나가야 한다 — 운영자는 자기 가게만의 사정(출고 시각·반품 주소)만 적는다.
 *  - 수량이 숫자 칸 하나였다(폰에서 키보드를 띄워야 2개를 산다), 몇 개를 고르면 얼마인지 없었다.
 *  - 설명·후기·문의가 한 줄로 길게 이어져, 후기를 보려면 설명을 다 내려야 했다.
 */
import { sql } from "drizzle-orm";
import { escapeHtml, won, type Db, type ShopSettings } from "./types.js";
import { t, moneyFnScript } from "./i18n.js";
import { WITHDRAWAL_DAYS } from "./returns.js";

/** 상품의 분류 경로 — 맨 위 분류부터 (숨긴 분류는 링크하지 않고 이름만 뺀다) */
export async function categoryTrail(db: Db, categoryId: string | null): Promise<Array<{ slug: string; name: string }>> {
  if (!categoryId) return [];
  const { rows } = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, slug, name, parent_id, is_visible, 0 AS depth FROM shop_categories WHERE id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id, c.slug, c.name, c.parent_id, c.is_visible, up.depth + 1
      FROM shop_categories c JOIN up ON c.id = up.parent_id
      WHERE up.depth < 8
    )
    SELECT slug, name FROM up WHERE is_visible = true ORDER BY depth DESC
  `);
  return rows.map((r) => ({ slug: String(r.slug), name: String(r.name) }));
}

/** 홈 › 쇼핑몰 › 분류… › 상품 */
export function breadcrumbHtml(shopBase: string, trail: Array<{ slug: string; name: string }>, productName: string): string {
  const items = [
    `<a href="/">${escapeHtml(t("crumb.home"))}</a>`,
    `<a href="${escapeHtml(shopBase)}">${escapeHtml(t("crumb.shop"))}</a>`,
    ...trail.map((c) => `<a href="${escapeHtml(shopBase)}?category=${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a>`),
    `<span aria-current="page">${escapeHtml(productName)}</span>`,
  ];
  return `<nav class="brick-crumbs" aria-label="${escapeHtml(t("crumb.label"))}">${items.join(`<span class="brick-crumb-sep" aria-hidden="true">›</span>`)}</nav>`;
}

/** 섹션 이동 막대 — 상품상세 · 구매안내 · 후기 n · 문의 n (손으로 내리는 동안 위에 붙는다) */
export function sectionNavHtml(reviewCount: number, inquiryCount: number): string {
  return `<nav class="brick-pd-jump" aria-label="${escapeHtml(t("jump.label"))}">
  <a href="#brick-pd-desc">${escapeHtml(t("jump.detail"))}</a>
  <a href="#brick-pd-guide">${escapeHtml(t("jump.guide"))}</a>
  <a href="#brick-reviews" data-open-tab="reviews">${escapeHtml(t("tab.reviews"))} <span>${reviewCount}</span></a>
  <a href="#brick-reviews" data-open-tab="inquiries">${escapeHtml(t("tab.inquiries"))} <span>${inquiryCount}</span></a>
</nav>`;
}

/**
 * 구매 안내 — 배송 · 교환/반품.
 *
 * 숫자는 설정에서, 문장은 법에서 온다. 반품 배송비가 "단순 변심이면 고객, 불량·오배송이면 판매자" 인 것은
 * 반품 계산(returns.ts 의 REASON_CODES)과 같은 규칙이다 — 안내와 실제 청구가 다르면 분쟁이 된다.
 */
export function purchaseGuideHtml(s: ShopSettings, freeShippingProduct: boolean): string {
  const shipping = freeShippingProduct
    ? t("guide.freeShipping")
    : s.freeShippingOver > 0
      ? t("guide.shippingFeeOver", { fee: won(s.shippingFee), over: won(s.freeShippingOver) })
      : t("guide.shippingFee", { fee: won(s.shippingFee) });
  const extra = (text: string | undefined) =>
    text && text.trim() ? `<p class="brick-guide-own">${escapeHtml(text.trim())}</p>` : "";
  return `<section id="brick-pd-guide" class="brick-pd-guide" aria-labelledby="brick-pd-guide-h">
  <h2 id="brick-pd-guide-h">${escapeHtml(t("jump.guide"))}</h2>
  <div class="brick-guide-grid">
    <div>
      <h3>${escapeHtml(t("guide.deliveryTitle"))}</h3>
      <ul>
        <li>${escapeHtml(shipping)}</li>
        <li>${escapeHtml(t("guide.zoneFee"))}</li>
      </ul>
      ${extra(s.deliveryGuide)}
    </div>
    <div>
      <h3>${escapeHtml(t("guide.returnTitle"))}</h3>
      <ul>
        <li>${escapeHtml(t("guide.withdrawal", { days: WITHDRAWAL_DAYS }))}</li>
        <li>${escapeHtml(s.returnShippingFee > 0 ? t("guide.returnFee", { fee: won(s.returnShippingFee) }) : t("guide.returnFeeFree"))}</li>
        <li>${escapeHtml(t("guide.sellerFault"))}</li>
      </ul>
      <p class="brick-guide-sub">${escapeHtml(t("guide.notAccepted"))}</p>
      <ul class="brick-guide-small">
        <li>${escapeHtml(t("guide.na1"))}</li>
        <li>${escapeHtml(t("guide.na2"))}</li>
        <li>${escapeHtml(t("guide.na3"))}</li>
        <li>${escapeHtml(t("guide.na4"))}</li>
      </ul>
      ${extra(s.returnGuide)}
    </div>
  </div>
</section>`;
}

/**
 * 수량 −/+ · 합계 · 섹션 이동 · "장바구니 보기".
 * 구매 폼의 기존 스크립트와 따로 돈다 — 그쪽은 수량 칸의 값을 읽기만 하므로 여기서 칸을 바꾸면 그대로 따라간다.
 */
export const DETAIL_EXTRAS_SCRIPT = () => `
<script>
(function(){
  var form = document.currentScript.parentNode.querySelector('.brick-buy-form');
  ${moneyFnScript("fmt")}
  if (form) {
    var qty = form.querySelector('#brick-qty');
    var opt = form.querySelector('#brick-opt');
    var total = form.querySelector('[data-total]');
    var max = Number(qty.getAttribute('max')) || 999;
    function clamp(n){ n = Math.floor(Number(n) || 1); return Math.min(max, Math.max(1, n)); }
    function refresh(){
      var n = clamp(qty.value);
      var unit = Number(form.dataset.price || 0);
      if (opt && opt.selectedOptions[0]) unit += Number(opt.selectedOptions[0].dataset.extra || 0);
      if (total) total.textContent = fmt(unit * n);
      var cnt = form.querySelector('[data-total-qty]');
      if (cnt) cnt.textContent = ${JSON.stringify(t("buy.totalQty"))}.replace('{n}', n);
      form.querySelectorAll('[data-step="-1"]').forEach(function(b){ b.disabled = n <= 1; });
      form.querySelectorAll('[data-step="1"]').forEach(function(b){ b.disabled = n >= max; });
    }
    form.querySelectorAll('[data-step]').forEach(function(b){
      b.addEventListener('click', function(){ qty.value = clamp(Number(qty.value) + Number(b.dataset.step)); refresh(); });
    });
    qty.addEventListener('input', refresh);
    qty.addEventListener('change', function(){ qty.value = clamp(qty.value); refresh(); });
    if (opt) opt.addEventListener('change', refresh);
    refresh();
  }
  // 섹션 이동 막대의 후기·문의 — 아래 탭도 그쪽으로 바꾼다
  document.querySelectorAll('.brick-pd-jump [data-open-tab]').forEach(function(a){
    a.addEventListener('click', function(){
      var tab = document.querySelector('.brick-pd-tabnav [data-tab="' + a.dataset.openTab + '"]');
      if (tab) tab.click();
    });
  });
})();
</script>`;

export const DETAIL_EXTRAS_CSS = `<style>
.brick-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:4px 0 18px 0;font-size:14px;color:var(--color-muted, #6c6c7a)}
/* 누르는 자리 28px 이상 — "홈" 한 글자는 폭이 11px 이라 폰에서 누르기 어려웠다(화면 점검이 잡았다) */
.brick-crumbs a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;min-height:28px;min-width:28px;padding:0 6px}
.brick-crumbs a:first-child{margin-left:-6px}
.brick-crumbs a:hover{color:var(--color-text, #17171c);text-decoration:underline}
.brick-crumbs [aria-current]{padding:0 6px;color:var(--color-text-soft, #45454f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}
.brick-buy-total{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:18px 0 0;padding-top:14px;border-top:1px solid var(--color-line, #e4e4ea);font-size:15px;color:var(--color-text-soft, #45454f)}
.brick-buy-total strong{font-size:22px;color:var(--color-text, #17171c);font-variant-numeric:tabular-nums}
.brick-buy-total span{color:var(--color-muted, #6c6c7a);font-size:13px;margin-left:6px}
.brick-buy-msg a{margin-left:8px;font-weight:600;color:var(--color-primary-text, #b63a2e)}
.brick-pd-jump{position:sticky;top:0;z-index:5;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:48px 0 0;background:var(--color-bg, #ffffff);border-bottom:1px solid var(--color-line-strong, #c9c9d3)}
.brick-pd-jump a{display:flex;align-items:center;justify-content:center;gap:6px;min-height:56px;font-size:16px;font-weight:600;color:var(--color-text-soft, #45454f);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.brick-pd-jump a:hover{color:var(--color-text, #17171c);border-bottom-color:var(--color-text, #17171c)}
.brick-pd-jump a span{font-weight:500;color:var(--color-muted, #6c6c7a)}
#brick-pd-desc,#brick-pd-guide,#brick-reviews{scroll-margin-top:64px}
.brick-pd-guide{margin:48px 0;padding:28px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 12px);background:var(--color-bg-soft, #f6f6f9)}
.brick-pd-guide h2{margin:0 0 18px;font-size:20px}
.brick-pd-guide h3{margin:0 0 10px;font-size:16.5px}
.brick-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}
.brick-pd-guide ul{margin:0;padding-left:18px;font-size:15px;line-height:1.75;color:var(--color-text-soft, #45454f)}
.brick-guide-sub{margin:14px 0 6px;font-size:13.5px;font-weight:600}
.brick-pd-guide .brick-guide-small{font-size:14px}
.brick-guide-own{margin:12px 0 0;padding:12px 14px;border-radius:var(--radius, 8px);background:var(--color-bg, #ffffff);font-size:14px;line-height:1.7;white-space:pre-line}
@media(max-width:640px){
  .brick-guide-grid{grid-template-columns:1fr;gap:20px}
  .brick-pd-guide{padding:20px 18px}
  .brick-pd-jump a{font-size:13.5px;min-height:48px}
}
</style>`;
