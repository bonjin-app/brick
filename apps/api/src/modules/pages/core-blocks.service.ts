import { Injectable, OnModuleInit } from "@nestjs/common";
import { CORE_CATALOGS, makeTranslator } from "@brick/core";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { SearchService } from "../search/search.service.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * 코어 블록 — 플러그인 없이 기본 제공되는 페이지 빌더 재료.
 * "core/" 네임스페이스는 예약되어 있으며 비활성화되지 않는다.
 */
@Injectable()
export class CoreBlocksService implements OnModuleInit {
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    const b = this.loader.blocks;

    b.set("core/heading", {
      name: "core/heading",
      displayName: "제목",
      propsSchema: {
        type: "object",
        properties: {
          text: { type: "string", title: "내용" },
          level: { type: "number", title: "크기 (1-3)", default: 2 },
        },
      },
      render: async (props) => {
        const level = Math.min(3, Math.max(1, Number(props.level ?? 2)));
        return `<h${level}>${esc(props.text)}</h${level}>`;
      },
    });

    b.set("core/paragraph", {
      name: "core/paragraph",
      displayName: "문단",
      propsSchema: {
        type: "object",
        properties: { text: { type: "string", title: "내용", format: "multiline" } },
      },
      render: async (props) => `<p>${esc(props.text).replace(/\n/g, "<br />")}</p>`,
    });

    b.set("core/rich-text", {
      name: "core/rich-text",
      displayName: "HTML",
      propsSchema: {
        type: "object",
        properties: { html: { type: "string", title: "HTML", format: "multiline" } },
      },
      // 관리자만 페이지를 편집할 수 있으므로 raw HTML을 신뢰한다 (WordPress custom HTML 블록과 동일한 신뢰 모델)
      render: async (props) => String(props.html ?? ""),
    });

    b.set("core/image", {
      name: "core/image",
      displayName: "이미지",
      propsSchema: {
        type: "object",
        properties: {
          src: { type: "string", title: "이미지 URL" },
          alt: { type: "string", title: "대체 텍스트" },
        },
      },
      render: async (props) =>
        `<figure><img src="${esc(props.src)}" alt="${esc(props.alt)}" style="max-width:100%" /></figure>`,
    });

    b.set("core/columns", {
      name: "core/columns",
      displayName: "다단 레이아웃",
      acceptsChildren: true,
      propsSchema: {
        type: "object",
        properties: { gap: { type: "number", title: "간격(px)", default: 24 } },
      },
      render: async (props, ctx) => {
        const gap = Number(props.gap ?? 24);
        const children = ctx.children ?? [];
        const cells = children.map((c) => `<div>${c}</div>`).join("");
        return `<div style="display:grid;grid-template-columns:repeat(${children.length || 1},1fr);gap:${gap}px">${cells}</div>`;
      },
    });

    /**
     * ── 랜딩 재료 ─────────────────────────────────────
     *
     * 소개 페이지·홈을 "문단 + 여백"으로만 만들면 사이트가 문서처럼 보인다.
     * 랜딩에 필요한 최소 재료(히어로·특징·CTA·FAQ)를 코어가 가진다 — 이걸
     * 플러그인에 두면 게시판만 쓰는 사이트는 랜딩을 못 만든다.
     *
     * **스타일은 블록이 아니라 테마가 소유한다.** 블록은 테마 프리미티브
     * 클래스(.brick-hero/.brick-btn/.brick-card/.brick-notice)만 쓰고 CSS 를
     * 싣지 않는다 — 블록이 색과 여백을 들고 다니면 테마를 바꿔도 안 바뀐다.
     *
     * 목록형 props 는 **한 줄에 하나, `|` 로 칸을 나눈다**. 관리자 블록
     * 편집기가 다루는 타입이 string/number/boolean/multiline 이라 배열
     * 편집기가 없다 — JSON 을 손으로 쓰게 하는 것보다 이 형식이 덜 깨진다.
     */
    /**
     * 이미지 주소 — http(s) 또는 사이트 상대 경로만.
     * CSS `url()` 과 `src` 양쪽에 들어가므로, url() 을 닫거나 규칙을 열 수 있는
     * 문자(인용부호·괄호·중괄호·세미콜론·공백·꺾쇠)가 하나라도 있으면 **주소 전체를
     * 버린다.** 걷어내고 남기면 "https://x/a.jpg body{display:none" 같은 조각이
     * 스타일에 실린다 — 정상 URL 에는 그런 문자가 없으니 버려도 잃는 것이 없다.
     */
    const safeUrl = (raw: unknown): string => {
      const u = String(raw ?? "").trim();
      if (!/^(https?:\/\/|\/)/i.test(u) || /["'(){};<>\\\s]/.test(u)) return "";
      return u.slice(0, 2000);
    };

    const rows = (raw: unknown, cols: number): string[][] =>
      String(raw ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|").map((s) => s.trim());
          return Array.from({ length: cols }, (_, i) => parts[i] ?? "");
        });

    b.set("core/hero", {
      name: "core/hero",
      displayName: "히어로 (큰 제목 영역)",
      propsSchema: {
        type: "object",
        properties: {
          eyebrow: { type: "string", title: "작은 위 라벨" },
          title: { type: "string", title: "제목" },
          text: { type: "string", title: "설명", format: "multiline" },
          ctaLabel: { type: "string", title: "버튼 1 문구" },
          ctaUrl: { type: "string", title: "버튼 1 링크" },
          altLabel: { type: "string", title: "버튼 2 문구" },
          altUrl: { type: "string", title: "버튼 2 링크" },
          plain: { type: "boolean", title: "배경 없이 (글자만)", default: false },
          image: { type: "string", title: "배경 이미지 URL (있으면 그 위에 글자를 얹는다)" },
        },
      },
      render: async (props, ctx) => {
        const eyebrow = String(props.eyebrow ?? "").trim();
        const title = String(props.title ?? "").trim();
        const text = String(props.text ?? "").trim();
        const image = safeUrl(props.image);
        /**
         * 히어로가 이 화면의 제목이다 — 문서 제목(<title>)도 여기서 나오고,
         * 테마는 페이지 제목 h1 을 생략한다(같은 말이 두 번 크게 적히지 않게).
         * 제목을 비운 히어로는 아무것도 주장하지 않는다.
         */
        if (title) ctx.setSeo?.({ title, description: text || undefined, ownHeading: true });
        const cta = [
          [props.ctaLabel, props.ctaUrl, "brick-btn-primary"],
          [props.altLabel, props.altUrl, ""],
        ]
          .filter(([label, url]) => String(label ?? "").trim() && String(url ?? "").trim())
          .map(
            ([label, url, cls]) =>
              `<a class="brick-btn brick-btn-lg ${cls}" href="${esc(url)}">${esc(label)}</a>`,
          )
          .join("");
        // 이미지 위 글자는 테마가 어둡게 깔고 흰 글자로 그린다(has-image) — 사진 밝기와 무관하게 읽힌다
        return `<section class="brick-hero${props.plain ? " brick-hero-plain" : ""}${image ? " has-image" : ""}"${image ? ` style="--hero-image: url(${image})"` : ""}>
${eyebrow ? `  <span class="brick-eyebrow">${esc(eyebrow)}</span>\n` : ""}${title ? `  <h1>${esc(title)}</h1>\n` : ""}${text ? `  <p>${esc(text).replace(/\n/g, "<br />")}</p>\n` : ""}${cta ? `  <div class="brick-hero-actions">${cta}</div>\n` : ""}</section>`;
      },
    });

    b.set("core/features", {
      name: "core/features",
      displayName: "특징 카드",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "묶음 제목 (비우면 표시 안 함)" },
          items: {
            type: "string",
            title: "카드 — 한 줄에 하나: 제목 | 설명 | 링크(선택) | 아이콘(선택: truck, shield, chat, clock, star, check, heart, pin, mail, phone, image, cart, user, bell)",
            format: "multiline",
          },
        },
      },
      render: async (props) => {
        const cards = rows(props.items, 4)
          .map(([title, body, url, icon]) => {
            // 아이콘은 테마 스프라이트의 심볼 이름 — 없는 이름이면 테마가 아무것도 그리지 않는다
            const ico = /^[a-z][a-z0-9-]{0,30}$/.test(icon)
              ? `<span class="brick-card-icon"><svg class="brick-ico" aria-hidden="true"><use href="#i-${esc(icon)}"></use></svg></span>`
              : "";
            const inner = `${ico}<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ""}`;
            return url
              ? `<a class="brick-card" href="${esc(url)}">${inner}</a>`
              : `<div class="brick-card">${inner}</div>`;
          })
          .join("");
        if (!cards) return "";
        const heading = String(props.title ?? "").trim();
        return `<section class="brick-features">${heading ? `<h2>${esc(heading)}</h2>` : ""}<div class="brick-grid">${cards}</div></section>`;
      },
    });

    b.set("core/cta", {
      name: "core/cta",
      displayName: "행동 유도 배너",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "제목" },
          text: { type: "string", title: "설명" },
          buttonLabel: { type: "string", title: "버튼 문구" },
          buttonUrl: { type: "string", title: "버튼 링크" },
        },
      },
      render: async (props) => {
        const label = String(props.buttonLabel ?? "").trim();
        const url = String(props.buttonUrl ?? "").trim();
        const text = String(props.text ?? "").trim();
        return `<section class="brick-cta">
  <div>
    <h2>${esc(props.title)}</h2>
    ${text ? `<p>${esc(text)}</p>` : ""}
  </div>
  ${label && url ? `<a class="brick-btn brick-btn-primary brick-btn-lg" href="${esc(url)}">${esc(label)}</a>` : ""}
</section>`;
      },
    });

    b.set("core/faq", {
      name: "core/faq",
      displayName: "자주 묻는 질문",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "묶음 제목 (비우면 표시 안 함)" },
          items: { type: "string", title: "한 줄에 하나: 질문 | 답변", format: "multiline" },
        },
      },
      // details/summary — 접고 펴는 데 JS 가 필요 없고, 검색엔진도 답을 읽는다
      render: async (props) => {
        const items = rows(props.items, 2)
          .filter(([q]) => q)
          .map(
            ([q, a]) =>
              `<details class="brick-faq-item"><summary>${esc(q)}</summary><div>${esc(a)}</div></details>`,
          )
          .join("");
        if (!items) return "";
        const heading = String(props.title ?? "").trim();
        return `<section class="brick-faq">${heading ? `<h2>${esc(heading)}</h2>` : ""}${items}</section>`;
      },
    });

    b.set("core/notice", {
      name: "core/notice",
      displayName: "알림 박스",
      propsSchema: {
        type: "object",
        properties: {
          text: { type: "string", title: "내용", format: "multiline" },
          tone: { type: "string", title: "색 (info/success/warning/danger)", default: "info" },
        },
      },
      render: async (props) => {
        const tone = ["info", "success", "warning", "danger"].includes(String(props.tone))
          ? String(props.tone)
          : "info";
        return `<div class="brick-notice brick-notice-${tone}">${esc(props.text).replace(/\n/g, "<br />")}</div>`;
      },
    });

    /**
     * 이미지 + 글 분할 — 프리미엄 템플릿의 기본 리듬. 사진 한 장과 문단 하나가
     * 번갈아 나오는 것이 "문서"와 "랜딩"을 가르는 가장 큰 차이다.
     * 이미지가 없으면 글만 그린다(깨진 자리를 남기지 않는다).
     */
    b.set("core/media-text", {
      name: "core/media-text",
      displayName: "이미지 + 글",
      propsSchema: {
        type: "object",
        properties: {
          image: { type: "string", title: "이미지 URL" },
          alt: { type: "string", title: "이미지 설명(대체 텍스트)" },
          eyebrow: { type: "string", title: "작은 위 라벨" },
          title: { type: "string", title: "제목" },
          text: { type: "string", title: "본문", format: "multiline" },
          ctaLabel: { type: "string", title: "버튼 문구" },
          ctaUrl: { type: "string", title: "버튼 링크" },
          reverse: { type: "boolean", title: "이미지를 오른쪽에", default: false },
        },
      },
      render: async (props) => {
        const image = safeUrl(props.image);
        const eyebrow = String(props.eyebrow ?? "").trim();
        const title = String(props.title ?? "").trim();
        const text = String(props.text ?? "").trim();
        const label = String(props.ctaLabel ?? "").trim();
        const url = String(props.ctaUrl ?? "").trim();
        return `<section class="brick-media-text${props.reverse ? " is-reverse" : ""}${image ? "" : " no-media"}">
${image ? `  <div class="brick-media"><img src="${esc(image)}" alt="${esc(props.alt)}" loading="lazy" /></div>
` : ""}  <div class="brick-media-body">
${eyebrow ? `    <span class="brick-eyebrow">${esc(eyebrow)}</span>
` : ""}${title ? `    <h2>${esc(title)}</h2>
` : ""}${text ? `    <p>${esc(text).replace(/\n/g, "<br />")}</p>
` : ""}${label && url ? `    <a class="brick-btn brick-btn-primary" href="${esc(url)}">${esc(label)}</a>
` : ""}  </div>
</section>`;
      },
    });

    /** 숫자 강조 — "누적 주문 12,000건 · 만족도 98%". 한 줄에 하나: 숫자 | 라벨 */
    b.set("core/stats", {
      name: "core/stats",
      displayName: "숫자 강조",
      propsSchema: {
        type: "object",
        properties: {
          items: { type: "string", title: "한 줄에 하나: 숫자 | 라벨", format: "multiline" },
        },
      },
      render: async (props) => {
        const items = rows(props.items, 2).filter(([n]) => n);
        if (!items.length) return "";
        return `<section class="brick-stats">${items
          .map(([n, label]) => `<div class="brick-stat"><strong>${esc(n)}</strong>${label ? `<span>${esc(label)}</span>` : ""}</div>`)
          .join("")}</section>`;
      },
    });

    /** 고객 후기 — 한 줄에 하나: 인용문 | 이름 | 소속(선택) */
    b.set("core/testimonials", {
      name: "core/testimonials",
      displayName: "고객 후기",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "묶음 제목 (비우면 표시 안 함)" },
          items: { type: "string", title: "한 줄에 하나: 인용문 | 이름 | 소속(선택)", format: "multiline" },
        },
      },
      render: async (props) => {
        const items = rows(props.items, 3).filter(([q]) => q);
        if (!items.length) return "";
        const heading = String(props.title ?? "").trim();
        return `<section class="brick-testimonials">${heading ? `<h2>${esc(heading)}</h2>` : ""}<div class="brick-grid">${items
          .map(([quote, name, org]) => `<figure class="brick-quote"><blockquote>${esc(quote)}</blockquote>${name ? `<figcaption><strong>${esc(name)}</strong>${org ? `<span>${esc(org)}</span>` : ""}</figcaption>` : ""}</figure>`)
          .join("")}</div></section>`;
      },
    });

    /** 이미지 갤러리 — 한 줄에 하나: 이미지 URL | 캡션(선택) | 링크(선택) */
    b.set("core/image-gallery", {
      name: "core/image-gallery",
      displayName: "이미지 갤러리",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "묶음 제목 (비우면 표시 안 함)" },
          items: { type: "string", title: "한 줄에 하나: 이미지 URL | 캡션 | 링크(선택)", format: "multiline" },
          columns: { type: "number", title: "열 수 (2~5)", default: 3 },
        },
      },
      render: async (props) => {
        const items = rows(props.items, 3).map(([u, cap, link]) => [safeUrl(u), cap, link]).filter(([u]) => u);
        if (!items.length) return "";
        const cols = Math.min(5, Math.max(2, Number(props.columns ?? 3) || 3));
        const heading = String(props.title ?? "").trim();
        return `<section class="brick-image-gallery">${heading ? `<h2>${esc(heading)}</h2>` : ""}<div class="brick-image-grid" style="--cols:${cols}">${items
          .map(([u, cap, link]) => {
            const fig = `<figure><img src="${esc(u)}" alt="${esc(cap)}" loading="lazy" />${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`;
            return link ? `<a href="${esc(link)}">${fig}</a>` : fig;
          })
          .join("")}</div></section>`;
      },
    });

    b.set("core/divider", {
      name: "core/divider",
      displayName: "구분선",
      propsSchema: { type: "object", properties: {} },
      render: async () => `<hr />`,
    });

    b.set("core/spacer", {
      name: "core/spacer",
      displayName: "여백",
      propsSchema: {
        type: "object",
        properties: { height: { type: "number", title: "높이(px)", default: 40 } },
      },
      render: async (props) => `<div style="height:${Number(props.height ?? 40)}px"></div>`,
    });

    /**
     * 통합검색 — 검색 폼과 결과를 서버에서 그린다.
     *
     * 검색은 공개 화면이라 SSR 이 맞다(SEO·JS 불필요). 결과는 로그인
     * 여부에 따라 다르지만(권한 필터) 렌더 캐시가 비로그인 요청에만,
     * 쿼리스트링 포함 키로 적용되므로 새지 않는다. 페이지 없이도 동작한다 —
     * 렌더러가 /search 를 이 블록으로 폴백한다 (테마 헤더의 검색폼이
     * 어느 사이트에서든 404 로 떨어지지 않게).
     */
    b.set("core/search", {
      name: "core/search",
      displayName: "통합검색",
      propsSchema: { type: "object", properties: {} },
      render: async (_props, ctx) => {
        const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
        const q = String(ctx.query?.q ?? "").trim();
        const scope = String(ctx.query?.scope ?? "").trim();
        const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);

        const form = `
<form class="brick-search-form" method="get" action="">
  <input type="text" name="q" value="${esc(q)}" placeholder="${esc(t("search.placeholder"))}"
         minlength="2" required aria-label="${esc(t("search.placeholder"))}" />
  <button type="submit" class="brick-primary">${esc(t("search.button"))}</button>
</form>`;

        if (!q) return `<div class="brick-search">${form}</div>`;

        const result = await this.search.search({
          raw: q,
          scope: scope || undefined,
          page,
          viewer: ctx.user ? { id: ctx.user.id, role: ctx.user.role } : null,
        });

        if (result.tooShort) {
          return `<div class="brick-search">${form}<p class="brick-search-note">${esc(t("search.tooShort"))}</p></div>`;
        }

        const head = result.total === 0
          ? `<p class="brick-search-note">${esc(t("search.empty", { query: q }))}</p>`
          : `<p class="brick-search-note">${esc(t("search.total", { query: q, total: result.total }))}</p>`;
        const replaced = result.replacedFrom
          ? `<p class="brick-search-note">${esc(t("search.replaced", { from: result.replacedFrom, to: result.normalized }))}</p>`
          : "";

        const qs = (extra: Record<string, string | number>) => {
          const params = new URLSearchParams({ q, ...(scope ? { scope } : {}) });
          for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
          return `?${params.toString()}`;
        };

        // 0건 그룹은 그리지 않는다 — "페이지 0건" 줄은 정보가 아니라 소음이다
        const groups = result.groups.filter((g) => g.total > 0).map((g) => {
          const items = g.items.map((it) => `
    <li>
      <a href="${esc(it.path)}">${esc(it.title)}</a>
      ${it.meta ? `<span class="brick-search-meta">${esc(it.meta)}</span>` : ""}
      ${it.excerpt ? `<p class="brick-search-excerpt">${esc(it.excerpt)}</p>` : ""}
    </li>`).join("");
          // 분류를 좁히지 않았을 때는 그룹마다 "더보기"로 그 분류 검색으로 안내한다
          const more = !scope && g.total > g.items.length
            ? ` · <a href="${qs({ scope: g.code, page: 1 })}">${esc(t("search.more"))}</a>`
            : "";
          return `
  <section class="brick-search-group">
    <h2>${esc(g.label)} <small>${esc(t("search.groupTotal", { total: g.total }))}${more}</small></h2>
    <ul>${items}</ul>
  </section>`;
        }).join("");

        // 분류를 좁힌 검색만 페이지를 나눈다 (전체 검색은 그룹별 상위 결과)
        let pager = "";
        if (scope) {
          const last = Math.max(1, Math.ceil(result.total / result.pageSize));
          const prev = page > 1 ? `<a href="${qs({ page: page - 1 })}">← ${esc(t("search.prev"))}</a>` : "";
          const next = page < last ? `<a href="${qs({ page: page + 1 })}">${esc(t("search.next"))} →</a>` : "";
          const all = `<a href="${qs({ page: 1, scope: "" }).replace("scope=&", "").replace(/[?&]scope=$/, "")}">${esc(t("search.all"))}</a>`;
          pager = `<nav class="brick-search-pager">${prev} ${all} ${next}</nav>`;
        }

        return `<div class="brick-search">${form}${replaced}${head}${groups}${pager}
<style>
.brick-search-form { display: flex; gap: 8px; max-width: 560px; }
.brick-search-form input { flex: 1; }
.brick-search-note { color: var(--color-muted, #6c6c7a); font-size: 14px; margin: 10px 0 0; }
/*
 * 그룹 제목이 결과 제목보다 크면 무엇이 결과인지 흐려진다 — 제목은 분류
 * 라벨이므로 작게, 결과는 누를 것이므로 크고 굵게.
 */
.brick-search-group { margin-top: 30px; }
.brick-search-group h2 { font-size: 15px; margin: 0 0 6px; letter-spacing: 0; color: var(--color-muted, #6c6c7a); font-weight: 600; }
.brick-search-group h2 small { font-weight: 400; font-size: 13px; color: var(--color-muted, #6c6c7a); }
.brick-search-group ul { list-style: none; padding: 0; margin: 0; }
.brick-search-group li { padding: 14px 0; border-bottom: 1px solid var(--color-line, #e4e4ea); }
.brick-search-group li:last-child { border-bottom: 0; }
.brick-search-group li > a { font-size: 16px; font-weight: 600; color: var(--color-text, #17171c); text-decoration: none; }
.brick-search-group li > a:hover { color: var(--color-primary-text, #b63a2e); text-decoration: underline; }
.brick-search-meta { margin-left: 8px; font-size: 12.5px; color: var(--color-muted, #6c6c7a); }
.brick-search-excerpt { margin: 5px 0 0; font-size: 14px; line-height: 1.6; color: var(--color-text-soft, #45454f); }
.brick-search-pager { display: flex; gap: 16px; margin-top: 22px; }
</style></div>`;
      },
    });
  }
}
