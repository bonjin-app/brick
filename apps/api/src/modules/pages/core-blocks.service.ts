import { Injectable, OnModuleInit } from "@nestjs/common";
import { CORE_CATALOGS, makeTranslator } from "@brick/core";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { SearchService } from "../search/search.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { IdentityService, safeNext } from "../identity/identity.service.js";

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
    private readonly notifications: NotificationsService,
    private readonly identity: IdentityService,
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

    /**
     * 배너 슬라이드 — 쇼핑몰 홈의 첫 화면.
     *
     * 카페24·메이크샵 홈이 회전 배너로 시작하는 이유는 "지금 밀고 있는 것"이 계절마다 바뀌기
     * 때문이다. 정적 히어로(core/hero)로는 그것을 담을 수 없어 운영자가 홈을 매번 고쳐야 한다.
     *
     * 스크립트를 인라인으로 둔다(CSP 는 인라인을 허용한다 — ADR-96). 자동 회전은 사용자가
     * 마우스를 올리거나 키보드로 조작하면 멈추고, `prefers-reduced-motion` 을 존중한다 —
     * 멈출 수 없는 자동 회전은 접근성 위반이고, 읽는 중에 화면이 바뀌면 화가 난다.
     */
    b.set("core/banner-slider", {
      name: "core/banner-slider",
      displayName: "배너 슬라이드",
      propsSchema: {
        type: "object",
        properties: {
          items: {
            type: "string",
            title: "한 줄에 하나: 이미지 URL | 제목(선택) | 설명(선택) | 링크(선택)",
            format: "multiline",
          },
          height: { type: "number", title: "높이 px (기본 420, 0 이면 이미지 비율)", default: 420 },
          interval: { type: "number", title: "자동 넘김 초 (0 이면 자동 넘김 없음)", default: 5 },
          full: { type: "boolean", title: "화면 폭 꽉 채우기", default: false },
        },
      },
      render: async (props, ctx) => {
        const items = rows(props.items, 4)
          .map(([url, title, text, link]) => ({ url: safeUrl(url), title, text, link: safeUrl(link) }))
          .filter((it) => it.url);
        if (!items.length) return "";
        const height = Math.max(0, Math.min(900, Number(props.height ?? 420) || 0));
        const interval = Math.max(0, Math.min(30, Number(props.interval ?? 5) || 0));
        // 첫 배너의 제목을 화면 제목으로 쓴다 — 히어로와 같은 규칙(테마가 h1 을 생략한다)
        if (items[0].title) ctx.setSeo?.({ title: items[0].title, description: items[0].text || undefined, ownHeading: true });

        const slides = items
          .map((it, i) => {
            const caption =
              it.title || it.text
                ? `<div class="brick-slide-caption">${it.title ? `<strong>${esc(it.title)}</strong>` : ""}${it.text ? `<span>${esc(it.text)}</span>` : ""}</div>`
                : "";
            // 첫 장은 즉시, 나머지는 lazy — 첫 화면이 늦게 뜨면 안 된다
            const img = `<img src="${esc(it.url)}" alt="${esc(it.title)}"${i === 0 ? '' : ' loading="lazy"'} decoding="async" />`;
            const inner = img + caption;
            return `<li class="brick-slide${i === 0 ? " is-on" : ""}" role="group" aria-roledescription="slide" aria-label="${i + 1} / ${items.length}"${i === 0 ? "" : ' aria-hidden="true"'}>${
              it.link ? `<a href="${esc(it.link)}">${inner}</a>` : inner
            }</li>`;
          })
          .join("");

        const dots = items
          .map((_, i) => `<button type="button" class="${i === 0 ? "is-on" : ""}" data-go="${i}" aria-label="${i + 1}"></button>`)
          .join("");
        const nav =
          items.length > 1
            ? `<button type="button" class="brick-slide-prev" aria-label="이전" data-dir="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
              `<button type="button" class="brick-slide-next" aria-label="다음" data-dir="1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
              `<div class="brick-slide-dots">${dots}</div>`
            : "";

        /*
         * 높이를 인라인으로 넘긴다 — 좁은 화면용도 함께.
         *
         * 테마 다섯 벌 모두 `var(--slider-h-sm, 260px)` 로 모바일 높이를 읽는데
         * **아무도 그 값을 넣지 않았다.** 그래서 운영자가 높이를 600 으로 정해도
         * 데스크톱만 따르고 폰은 260 에 고정됐다 — 배너가 화면마다 다른 비율로
         * 잘려 보인다.
         *
         * 폰에서는 데스크톱의 62% 로 준다(가로가 3분의 1 이하로 줄어드는데 높이를
         * 그대로 두면 배너가 세로로 길어져 첫 화면을 다 먹는다). 180~420 으로 묶어
         * 너무 납작하거나 너무 긴 배너를 막는다.
         */
        const heightSm = height ? Math.max(180, Math.min(420, Math.round(height * 0.62))) : 0;
        const style = [
          height ? `--slider-h:${height}px` : "",
          heightSm ? `--slider-h-sm:${heightSm}px` : "",
        ].filter(Boolean).join(";");
        return (
          `<section class="brick-slider${props.full ? " is-full" : ""}${height ? "" : " is-auto"}"${style ? ` style="${style}"` : ""}` +
          ` data-interval="${interval}" aria-roledescription="carousel" aria-label="배너">` +
          `<ul class="brick-slides">${slides}</ul>${nav}</section>` +
          (items.length > 1 ? SLIDER_SCRIPT : "")
        );
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
     * 알림함 — 내게 온 알림 목록.
     *
     * 알림은 지금까지 메일 한 통로뿐이었고, SMTP 미설정은 설치 직후의 기본값이라
     * 기본 사이트에서는 댓글도 주문 안내도 조용히 사라졌다. 이 화면이 그 두 번째
     * 통로다 — 메일이 안 되어도 로그인한 사람은 여기서 본다.
     *
     * **목록을 연 순간이 곧 읽은 순간이다.** 따로 "읽음" 버튼을 두면 자바스크립트가
     * 필요하고(이 블록은 서버에서 그린다), 버튼을 누르지 않은 사람의 머리에는
     * 배지가 영원히 남는다. 대신 이번에 새로 온 것은 표시해서 보여준 뒤 읽음으로
     * 넘긴다 — 무엇이 새것이었는지 모른 채 사라지지 않게.
     */
    b.set("core/notifications", {
      name: "core/notifications",
      displayName: "알림함",
      propsSchema: {
        type: "object",
        properties: { limit: { type: "number", title: "표시 개수", default: 30 } },
      },
      render: async (props, ctx) => {
        const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
        ctx.setSeo?.({ title: t("noti.title") });
        if (!ctx.user) return `<p>${esc(t("noti.loginRequired"))}</p>`;

        /*
         * `before` 로 이어 읽는다 — 서른 건이 넘는 사람이 옛 알림에 닿을 길이
         * 있어야 한다(자바스크립트 없이 링크 하나로).
         */
        const limit = Number(props.limit) || 30;
        const beforeRaw = String(ctx.query?.before ?? "").trim();
        const items = await this.notifications.list(ctx.user.id, {
          limit,
          // id(uuid) 로 이어 읽는다 — 형식이 아니면 처음부터
          before: /^[0-9a-f-]{36}$/i.test(beforeRaw) ? beforeRaw : undefined,
        });
        if (!items.length) return `<p>${esc(t("noti.empty"))}</p>`;

        /*
         * **한 항목 전체가 누르는 자리다.**
         *
         * 제목만 링크로 두었더니 폰에서 높이가 19px 이었다 — 손가락으로 누르기에
         * 얇다(저장소의 화면 점검 도구가 28px 미만을 잡는다). 알림함은 "눌러서
         * 가는 것" 이 전부인 화면이라, 줄 전체를 링크로 만들고 여백으로 키운다.
         */
        const rows = items
          .map((n) => {
            const when = n.createdAt instanceof Date ? n.createdAt.toISOString().slice(0, 16).replace("T", " ") : "";
            const inner = `
      <span class="brick-noti-head">${esc(n.title)}${
        // 표시는 CSS 없이도 보여야 한다 — 테마는 이 목록을 꾸미지 않는다
        n.read ? "" : ` <strong class="brick-noti-new">${esc(t("noti.new"))}</strong>`
      }</span>
      ${n.body ? `<span class="brick-noti-body">${esc(n.body)}</span>` : ""}
      <time class="brick-noti-time">${esc(when)}</time>`;
            return `
    <li class="brick-noti-item${n.read ? "" : " is-new"}">
      ${n.url ? `<a class="brick-noti-link" href="${esc(n.url)}">${inner}\n      </a>` : inner}
    </li>`;
          })
          .join("");

        /*
         * 보여준 뒤에 읽음으로 넘긴다 — 순서가 바뀌면 "새 알림" 표시가 한 번도 안 보인다.
         *
         * **화면에 보여준 것만** 넘긴다. 전에는 안 읽은 것을 전부 읽음 처리했는데,
         * 서른 건만 보여주므로 서른다섯 건이 쌓여 있으면 다섯 건은 보지도 못한 채
         * 사라졌다(주문이 몰리는 사이트에서 바로 일어난다).
         */
        await this.notifications.markRead(ctx.user.id, items.filter((n) => !n.read).map((n) => n.id));

        // 더 있으면 이어 읽는 길을 준다 (마지막 것보다 오래된 것들)
        const oldest = items[items.length - 1]?.id;
        const more =
          items.length === limit && oldest
            ? `<p class="brick-noti-more"><a href="?before=${esc(oldest)}">${esc(t("noti.older"))}</a></p>`
            : "";
        return `<ul class="brick-noti-list">${rows}</ul>${more}
<style>
.brick-noti-list { list-style: none; padding: 0; margin: 0; }
.brick-noti-item { border-bottom: 1px solid var(--color-line, #e4e4ea); }
/* 줄 전체가 누르는 자리 — 폰에서 제목 한 줄만 누르게 두면 19px 이다 */
.brick-noti-link, .brick-noti-item > .brick-noti-head {
  display: block; padding: 14px 4px; text-decoration: none; color: inherit;
}
.brick-noti-link:hover { background: var(--color-bg-soft, #f6f6f9); }
.brick-noti-head { display: block; font-weight: 600; line-height: 1.5; }
.brick-noti-link .brick-noti-head { color: var(--color-primary-text, #b63a2e); }
/* 안 읽은 것은 왼쪽 선으로도 알린다 — 색과 글자 둘 다에 기대지 않는다 */
.brick-noti-item.is-new { border-left: 3px solid var(--color-primary, #cf4437); }
.brick-noti-item.is-new .brick-noti-link { padding-left: 12px; }
.brick-noti-new {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 11.5px; font-weight: 700; vertical-align: 2px;
  background: var(--color-primary-soft, #fdeeec); color: var(--color-primary-text, #b63a2e);
}
.brick-noti-body {
  display: block; margin: 4px 0 0; color: var(--color-text-soft, #45454f);
  font-size: 14px; line-height: 1.6; white-space: pre-line;
}
.brick-noti-time { display: block; margin-top: 6px; color: var(--color-muted, #6c6c7a); font-size: 12.5px; }
.brick-noti-more { margin: 16px 0 0; }
</style>`;
      },
    });

    /**
     * 본인인증 — 인증 상태와 공급자 인증창.
     *
     * 테마 안에서 그려진다. 공급자 SDK(포트원 등)는 외부 스크립트라 플러그인이 선언한 CSP 가
     * 필요한데, 회원 정보 화면(`/account`)은 고정 CSP 라 받지 않기 때문이다. 렌더러가
     * `/identity` 를 이 블록으로 폴백한다.
     *
     * 인증창에서 돌아오면(`?provider=…&…`) 스크립트가 공급자의 readReturn 으로 인증 ID 를
     * 꺼내 서버에 확인을 맡긴다. 결과(이름·생년월일)는 화면을 거치지 않는다.
     */
    b.set("core/identity", {
      name: "core/identity",
      displayName: "본인인증",
      propsSchema: { type: "object", properties: {} },
      render: async (_props, ctx) => {
        const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
        ctx.setSeo?.({ title: t("identity.title") });
        const next = safeNext(ctx.query?.next);
        /*
         * 가입 전 본인인증 — 손님이 가입 양식에서 왔다(`?signup=1`). 요청은 회원 대신 이 브라우저에 묶이고
         * (서버의 쿠키), 끝나면 가입 양식으로 돌아간다. 이미 마쳤는지는 쿠키를 봐야 하므로 스크립트가 묻는다 —
         * 손님 화면은 렌더 캐시에 들어가므로 서버가 사람마다 다르게 그리면 안 된다.
         */
        const signup = !ctx.user && String(ctx.query?.signup ?? "") === "1";
        if (signup) ctx.setSeo?.({ title: t("identity.signupTitle") });
        if (!ctx.user && !signup) {
          const self = next ? `/identity?next=${encodeURIComponent(next)}` : "/identity";
          return `<div class="brick-identity"><p>${esc(t("identity.loginRequired"))}</p>
<p><a class="brick-btn brick-btn-primary" href="/login?next=${esc(encodeURIComponent(self))}">${esc(t("identity.login"))}</a></p></div>`;
        }
        const status = ctx.user
          ? await this.identity.status(ctx.user.id)
          : { verified: false, adult: false, verifiedAt: null as Date | null };
        const providers = await this.identity.readyProviders();
        const back = signup ? next || "/register" : next;
        const cont = next ? `<p><a class="brick-btn brick-btn-primary" href="${esc(next)}">${esc(t("identity.continue"))}</a></p>` : "";
        const when = status.verifiedAt ? status.verifiedAt.toISOString().slice(0, 10) : "";
        const state = status.verified
          ? `<p class="brick-id-state is-done"><strong>${esc(t("identity.verified"))}</strong> <span>${esc(t("identity.verifiedAt", { date: when }))}</span></p>
<p class="brick-id-adult">${esc(status.adult ? t("identity.adult") : t("identity.notAdult"))}</p>${cont}`
          : `<p class="brick-id-intro">${esc(t(signup ? "identity.signupIntro" : "identity.intro"))}</p>`;
        /*
         * 이미 인증했으면 인증창을 다시 열 이유가 없다 — 인증은 건당 요금이 나간다.
         * (명의를 바꾸는 것은 막혀 있다: 서버가 다른 명의를 거절한다)
         */
        const actions = status.verified
          ? ""
          : providers.length
            ? `<div class="brick-id-actions">${providers
                .map(({ plugin, provider: p }) => `<button type="button" class="brick-btn brick-btn-primary" data-provider="${esc(p.name)}">${esc(this.loader.trCatalog(plugin, p.displayName))}</button>`)
                .join("")}</div>`
            : `<p class="brick-id-none">${esc(t("identity.none"))}</p>`;
        const T = {
          opening: t("identity.opening"), working: t("identity.working"),
          done: t(signup ? "identity.signupDone" : "identity.done"),
          cancelled: t("identity.cancelled"), failed: t("identity.failed"),
          back: t("identity.signupBack"),
        };
        const api = signup
          ? { start: "/api/identity/signup/start", complete: "/api/identity/signup/complete", state: "/api/identity/signup" }
          : { start: "/api/me/identity/start", complete: "/api/me/identity/complete", state: "" };
        // 인증창이 끝나고 돌아올 곳에서만 스크립트가 필요하다 — 이미 인증했어도 돌아온 처리는 해야 한다
        const scripts = providers.map(({ provider: p }) => p.clientScript).join("\n");
        return `<div class="brick-identity" data-next="${esc(back)}" data-signup="${signup ? "1" : ""}" data-api="${esc(JSON.stringify(api))}" data-t="${esc(JSON.stringify(T))}">
${state}
${actions}
<p class="brick-id-msg" role="alert"></p>
</div>
${scripts}
<script>
(function(){
  var root = document.querySelector('.brick-identity');
  if (!root) return;
  var T = JSON.parse(root.getAttribute('data-t') || '{}');
  var API = JSON.parse(root.getAttribute('data-api') || '{}');
  var next = root.getAttribute('data-next') || '';
  var signup = root.getAttribute('data-signup') === '1';
  var msg = root.querySelector('.brick-id-msg');
  function say(text, err){ msg.textContent = text; msg.classList.toggle('is-error', !!err); }
  function post(url, body){
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ return { ok: r.ok, d: d }; }); });
  }
  function returnUrl(provider){
    var u = new URL(location.pathname, location.href);
    u.searchParams.set('provider', provider);
    if (signup) u.searchParams.set('signup', '1');
    if (next) u.searchParams.set('next', next);
    return u.toString();
  }
  // 돌아온 주소의 인증 값은 한 번 쓰고 지운다 — 새로고침·공유로 다시 보내지 않게
  function cleanUrl(){
    var u = new URL(location.pathname, location.href);
    if (signup) u.searchParams.set('signup', '1');
    if (next) u.searchParams.set('next', next);
    history.replaceState(null, '', u.toString());
  }
  // 가입 전 인증을 이미 마친 브라우저 — 인증창을 다시 열 이유가 없다(건당 요금)
  if (signup && API.state) {
    fetch(API.state).then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.verified) return;
      var acts = root.querySelector('.brick-id-actions');
      if (acts) acts.innerHTML = '<a class="brick-btn brick-btn-primary" href="' + next.replace(/"/g, '') + '">' + T.back + '</a>';
    }).catch(function(){});
  }
  var q = new URLSearchParams(location.search);
  var back = q.get('provider');
  var impl = back && window.brickIdentity && window.brickIdentity[back];
  if (impl && impl.readReturn) {
    var id = impl.readReturn(q);
    var why = q.get('message');
    cleanUrl();
    if (!id) { say(T.cancelled + (why ? ' (' + why + ')' : ''), true); }
    else {
      say(T.working);
      post(API.complete, { requestId: id }).then(function(x){
        if (!x.ok) { say(x.d.message || T.failed, true); return; }
        say(T.done);
        if (next) location.href = next; else location.reload();
      }).catch(function(){ say(T.failed, true); });
    }
  }
  root.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('[data-provider]') : null;
    if (!b) return;
    var p = b.getAttribute('data-provider');
    var run = window.brickIdentity && window.brickIdentity[p];
    if (!run) { say(T.failed, true); return; }
    b.disabled = true;
    say(T.opening);
    post(API.start, { provider: p }).then(function(x){
      if (!x.ok) throw new Error(x.d.message || T.failed);
      return run({ requestId: x.d.requestId, returnUrl: returnUrl(p) });
    }).catch(function(err){ say((err && err.message) || T.failed, true); b.disabled = false; });
  });
})();
</script>
<style>
.brick-identity { max-width: 560px; }
.brick-id-intro, .brick-id-adult { color: var(--color-text-soft, #45454f); line-height: 1.7; }
.brick-id-state.is-done strong { color: var(--color-success, #1d7a46); }
.brick-id-state span { color: var(--color-muted, #6c6c7a); font-size: 13px; margin-left: 6px; }
.brick-id-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.brick-id-actions .brick-btn { min-height: 44px; }
.brick-id-msg.is-error { color: var(--color-danger, #c8322f); font-weight: 600; }
</style>`;
      },
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
          /*
           * 사진은 **그룹 단위**로 켠다.
           *
           * 상품처럼 글자만으로 고를 수 없는 결과에는 사진이 있어야 하고(제목 열 줄에서
           * 머그컵을 고를 수는 없다), 공지·문의처럼 사진이 없는 대상은 지금 모양이 맞다.
           * 항목마다 켜면 한 목록 안에서 줄 높이가 달라져 들쭉날쭉해지므로, 그룹에 사진이
           * 하나라도 있으면 그 그룹 전체를 사진 목록으로 그리고 없는 항목은 빈 칸을 둔다.
           */
          const withThumbs = g.items.some((it) => it.thumbnail);
          const items = g.items.map((it) => `
    <li>
      ${withThumbs
        ? `<span class="brick-search-thumb">${
            it.thumbnail
              ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy" decoding="async" />`
              : ""
          }</span>`
        : ""}
      <span class="brick-search-body">
      <a href="${esc(it.path)}">${esc(it.title)}</a>
      ${it.meta ? `<span class="brick-search-meta">${esc(it.meta)}</span>` : ""}
      ${it.excerpt ? `<p class="brick-search-excerpt">${esc(it.excerpt)}</p>` : ""}
      </span>
    </li>`).join("");
          // 분류를 좁히지 않았을 때는 그룹마다 "더보기"로 그 분류 검색으로 안내한다
          const more = !scope && g.total > g.items.length
            ? ` · <a href="${qs({ scope: g.code, page: 1 })}">${esc(t("search.more"))}</a>`
            : "";
          return `
  <section class="brick-search-group">
    <h2>${esc(g.label)} <small>${esc(t("search.groupTotal", { total: g.total }))}${more}</small></h2>
    <ul${withThumbs ? ' class="has-thumbs"' : ""}>${items}</ul>
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
/* 제목은 이제 .brick-search-body 안에 있다 (사진과 나란히 놓기 위한 감싸개) */
/* flex:1 로 남는 폭을 받고, min-width:0 으로 긴 단어가 칸을 밀어내지 않게 한다 */
.brick-search-body { display: block; flex: 1 1 auto; min-width: 0; }
/* 손가락으로 누를 수 있어야 한다 — 줄 높이만으로는 19px 이었다 */
.brick-search-body > a { display: inline-block; min-height: 28px; line-height: 1.7;
  font-size: 16px; font-weight: 600; color: var(--color-text, #17171c); text-decoration: none; }
.brick-search-body > a:hover { color: var(--color-primary-text, #b63a2e); text-decoration: underline; }
/* 사진이 있는 그룹만 가로 배치. 사진 없는 항목은 빈 칸을 둔다 — 줄 높이가 흔들리지 않게 */
.brick-search-group ul.has-thumbs li { display: flex; gap: 14px; align-items: flex-start; }
.brick-search-thumb { flex: 0 0 auto; display: block; width: 64px; height: 64px; overflow: hidden;
  border-radius:var(--radius, 8px); background: var(--color-bg-soft, #f6f6f9); }
.brick-search-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.brick-search-meta { margin-left: 8px; font-size: 12.5px; color: var(--color-muted, #6c6c7a); }
.brick-search-excerpt { margin: 5px 0 0; font-size: 14px; line-height: 1.6; color: var(--color-text-soft, #45454f); }
.brick-search-pager { display: flex; gap: 16px; margin-top: 22px; }
</style></div>`;
      },
    });
  }
}

/**
 * 배너 슬라이드 동작. 블록마다 한 번씩 나오지만 `data-brick-slider-init` 로 한 번만 붙는다
 * (한 페이지에 슬라이드가 둘 있어도 스크립트는 한 벌만 일한다).
 *
 * 접근성: 자동 회전은 마우스·포커스·터치에서 멈추고, prefers-reduced-motion 이면 시작하지
 * 않는다. 좌우 화살표 키로 넘길 수 있고, 보이지 않는 슬라이드는 aria-hidden 이다.
 */
const SLIDER_SCRIPT = `<script>
(function () {
  if (window.__brickSlider) { window.__brickSlider(); return; }
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function setup(root) {
    if (root.dataset.brickSliderInit) return;
    root.dataset.brickSliderInit = "1";
    var slides = [].slice.call(root.querySelectorAll(".brick-slide"));
    var dots = [].slice.call(root.querySelectorAll(".brick-slide-dots button"));
    if (slides.length < 2) return;
    var at = 0, timer = null, held = false;   // held: 손님이 보고 있는 중(마우스·초점·손가락)
    var interval = Number(root.dataset.interval || 0) * 1000;

    function show(next) {
      at = (next + slides.length) % slides.length;
      slides.forEach(function (s, i) {
        var on = i === at;
        s.classList.toggle("is-on", on);
        if (on) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
      });
      dots.forEach(function (d, i) { d.classList.toggle("is-on", i === at); });
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() {
      stop();
      // 마우스가 올라와 있는 동안에는 다시 돌지 않는다 — 버튼을 누르면 start() 가 불리는데,
      // 그때 포인터는 이미 배너 위이므로 mouseenter 가 다시 오지 않아 회전이 살아나 버렸다.
      if (held || !interval || reduce) return;
      timer = setInterval(function () { show(at + 1); }, interval);
    }
    function hold() { held = true; stop(); }
    function release() { held = false; start(); }

    root.addEventListener("click", function (e) {
      var dir = e.target.closest("[data-dir]");
      if (dir) { show(at + Number(dir.dataset.dir)); start(); return; }
      var go = e.target.closest("[data-go]");
      if (go) { show(Number(go.dataset.go)); start(); }
    });
    // 읽는 중에 바뀌지 않게 — 마우스를 올리거나 안쪽에 초점이 있으면 멈춘다
    root.addEventListener("mouseenter", hold);
    root.addEventListener("mouseleave", release);
    root.addEventListener("focusin", hold);
    root.addEventListener("focusout", release);
    root.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { show(at - 1); start(); }
      if (e.key === "ArrowRight") { show(at + 1); start(); }
    });
    // 손가락으로 넘기기 — 쇼핑몰 손님의 절반 이상이 휴대폰이다
    var x0 = null;
    root.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; stop(); }, { passive: true });
    // 손가락을 뗀 뒤에는 다시 돌아도 된다 (아래 touchend 에서 start)
    root.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) show(at + (dx < 0 ? 1 : -1));
      x0 = null; start();
    });
    start();
  }
  window.__brickSlider = function () {
    [].slice.call(document.querySelectorAll(".brick-slider")).forEach(setup);
  };
  window.__brickSlider();
})();
</script>`;
