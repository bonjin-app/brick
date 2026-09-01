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
.brick-search-note { color: var(--color-muted, #71717d); }
.brick-search-group h2 small { font-weight: 400; font-size: 13px; color: var(--color-muted, #71717d); }
.brick-search-group ul { list-style: none; padding: 0; margin: 0 0 8px; }
.brick-search-group li { padding: 10px 0; border-bottom: 1px solid var(--color-line, #e7e7ec); }
.brick-search-meta { margin-left: 8px; font-size: 12.5px; color: var(--color-muted, #71717d); }
.brick-search-excerpt { margin: 4px 0 0; font-size: 13.5px; color: var(--color-muted, #71717d); }
.brick-search-pager { display: flex; gap: 16px; margin-top: 18px; }
</style></div>`;
      },
    });
  }
}
