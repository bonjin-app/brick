import { Inject, Injectable, Logger } from "@nestjs/common";
// 이스케이프는 코어의 것을 쓴다 — null 안전하고, 구현이 갈라지면 안 된다
import {
  CORE_CATALOGS, CORE_MESSAGE_KEYS, catalogToTree, escapeHtml, makeTranslator, normalizeLocale,
  type Locale,
} from "@brick/core";
import { and, eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { menus, pages, siteSettings } from "@brick/database";
import {
  EMPTY_BUSINESS_INFO, toTemplateVars, type BusinessInfo,
} from "../site/business-info.js";
import type { BlockRenderContext, CacheProvider } from "@brick/core";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { ThemesService } from "../themes/themes.service.js";
import { DB, CACHE } from "../../runtime.module.js";

/** 페이지 빌더 저장 단위: 블록 트리 노드 */
export interface BlockNode {
  block: string; // 예: "core/heading", "brick-board/latest-posts"
  props?: Record<string, unknown>;
  children?: BlockNode[];
}

export interface RenderedPage {
  html: string;
  status: number;
  /** 실제로 매칭된 페이지 slug (하위 경로 매칭 시 요청 경로와 다르다) */
  slug?: string;
}

/** 렌더를 요청한 사용자 — 블록에 전달된다 */
export interface RequestUser {
  id: string;
  role: string;
  displayName: string;
}

/**
 * 공개 페이지 렌더 파이프라인.
 *
 *   slug → published 페이지 조회 → 블록 트리 서버 렌더 → 테마 템플릿 주입 → 완성 HTML
 *
 * 결과는 태그 캐시에 저장된다:
 *   - "pages" 태그: 어떤 페이지든 변경 시 전체 무효화 (테마 교체, 플러그인 토글 포함)
 *   - "page:<slug>" 태그: 해당 페이지만 무효화
 */
@Injectable()
export class PageRenderService {
  private readonly logger = new Logger("PageRender");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(CACHE) private readonly cache: CacheProvider,
    private readonly loader: PluginLoaderService,
    private readonly themes: ThemesService,
  ) {}

  async renderPath(
    rawPath: string,
    opts: { query?: Record<string, string>; user?: RequestUser | null } = {},
  ): Promise<RenderedPage> {
    const path = rawPath.replace(/^\/+|\/+$/g, "") || "home";
    const query = opts.query ?? {};
    const user = opts.user ?? null;

    /**
     * 캐시 정책 — 유출을 막는 것이 성능보다 우선이다.
     *
     *  - 로그인 사용자에게는 캐시를 쓰지 않는다. 렌더 결과에 "수정" 버튼이나
     *    비밀글 본문처럼 사용자별 내용이 들어갈 수 있고, 그것이 캐시되면
     *    다른 사용자에게 새어 나간다.
     *  - 쿼리스트링을 키에 포함한다. 검색·페이지네이션 결과가 섞이면 안 된다.
     */
    const cacheable = !user;
    const queryKey = Object.keys(query).length
      ? `?${new URLSearchParams(Object.entries(query).sort()).toString()}`
      : "";
    const cacheKey = `render:page:${path}${queryKey}`;

    if (cacheable) {
      const cached = await this.cache.get<RenderedPage>(cacheKey);
      if (cached) return cached;
    }

    const result = await this.compute(path, query, user);
    // 페이지 slug 기준으로 태그를 달아야 무효화가 정확하다 (하위 경로 포함)
    if (cacheable) {
      await this.cache.setWithTags(cacheKey, result, ["pages", `page:${result.slug ?? path}`], 300);
    }
    return result;
  }

  /** 페이지/테마/플러그인 변경 시 호출 — 렌더 캐시 무효화 */
  async invalidate(slug?: string): Promise<void> {
    await this.cache.invalidateTag(slug ? `page:${slug}` : "pages");
  }

  private async compute(
    path: string,
    query: Record<string, string>,
    user: RequestUser | null,
  ): Promise<RenderedPage> {
    const [site, nav] = await Promise.all([this.siteInfo(), this.menu("header")]);
    // 블록 렌더 중에 플러그인이 ctx.t 를 부른다 — 언어 캐시를 갱신해 둔다
    await this.loader.refreshLocale();

    // 다국어 — locale 은 사이트 설정이고, 테마는 t 로 라벨을 받는다.
    // siteInfo 가 매 렌더마다 설정을 읽으므로 locale 변경은 즉시 반영된다
    // (렌더 캐시는 설정 저장 시 무효화된다).
    const t = makeTranslator({
      locale: site.locale,
      catalogs: CORE_CATALOGS,
      onMissing: (key, locale) => this.logger.warn(`번역 없음: ${key} (${locale})`),
    });
    const themeCommon = {
      locale: site.locale,
      t: catalogToTree(t, CORE_MESSAGE_KEYS),
      /**
       * 헤더 유틸(로그인/로그아웃)용. 로그인 렌더는 캐시되지 않으므로
       * (위 cacheable 정책) 사용자별 내용이 다른 사람에게 새지 않는다.
       * 템플릿 엔진에 else 가 없어 비로그인 분기는 guest 로 준다.
       */
      user: user ? { displayName: user.displayName, isAdmin: user.role === "admin" } : null,
      guest: !user,
    };

    /**
     * 경로 매칭: 정확히 일치하는 페이지가 없으면 상위 경로를 순서대로 시도한다.
     *
     * 예: 요청 "board/free/01a0..." → "board/free/01a0..." → "board/free" → "board"
     * 매칭된 나머지("01a0...")를 pathTail로 블록에 넘긴다.
     * 게시판 상세처럼 URL에 식별자가 들어가는 화면을 페이지 하나로 처리할 수 있다.
     */
    const segments = path.split("/").filter(Boolean);
    let page: typeof pages.$inferSelect | undefined;
    let pathTail = "";
    for (let i = segments.length; i >= 1; i--) {
      const candidate = segments.slice(0, i).join("/");
      const [found] = await this.db
        .select()
        .from(pages)
        .where(and(eq(pages.slug, candidate), eq(pages.status, "published")))
        .limit(1);
      if (found) {
        page = found;
        pathTail = segments.slice(i).join("/");
        break;
      }
    }

    const blockCtx = { path, pathTail, query, user };

    if (!page) {
      // 홈 페이지가 없으면 테마의 home 슬롯으로 폴백 (설치 직후 상태)
      if (path === "home") {
        const html = await this.themes.render("home", { ...themeCommon, site, menu: nav, pageTitle: site.name, seo: {} });
        return { html, status: 200, slug: "home" };
      }
      // /search 는 페이지가 없어도 통합검색으로 폴백한다 — 테마 헤더의
      // 검색폼이 어느 사이트에서든 404 로 떨어지지 않게. search slug 로
      // 페이지를 만들면 그 페이지가 우선한다 (운영자가 화면을 가질 수 있다).
      if (path === "search") {
        const title = t("search.title");
        const blocksHtml = await this.renderNodes(
          [{ block: "core/search", props: {} }],
          blockCtx,
        );
        const html = await this.themes.render("page", {
          ...themeCommon, site, menu: nav,
          title, pageTitle: `${title} — ${site.name}`, blocksHtml, seo: {},
        });
        return { html, status: 200, slug: "search" };
      }
      const html = await this.themes.render("page", {
        ...themeCommon,
        site,
        menu: nav,
        pageTitle: `${t("page.notFoundTitle")} — ${site.name}`,
        title: t("page.notFoundTitle"),
        blocksHtml: `<p>${escapeHtml(t("page.notFoundBody", { path }))}</p>`,
        seo: {},
      });
      return { html, status: 404 };
    }

    const seo = (page.seo ?? {}) as { title?: string; description?: string };
    const blocksHtml = await this.renderNodes((page.blocks ?? []) as BlockNode[], blockCtx);
    const html = await this.themes.render("page", {
      ...themeCommon,
      site,
      menu: nav,
      title: page.title,
      pageTitle: seo.title ?? `${page.title} — ${site.name}`,
      blocksHtml,
      seo,
    });
    return { html, status: 200, slug: page.slug };
  }

  /** 블록 트리 렌더. 한 블록의 실패가 페이지 전체를 죽이지 않는다 */
  async renderNodes(
    nodes: BlockNode[],
    ctx: Omit<BlockRenderContext, "children"> = { path: "", pathTail: "", query: {}, user: null },
  ): Promise<string> {
    const parts: string[] = [];
    for (const node of nodes ?? []) {
      const def = this.loader.blocks.get(node.block);
      if (!def) {
        parts.push(`<!-- unknown block: ${escapeHtml(node.block)} -->`);
        continue;
      }
      try {
        const children = node.children?.length
          ? await Promise.all(node.children.map((c) => this.renderNodes([c], ctx)))
          : [];
        parts.push(await def.render(node.props ?? {}, { ...ctx, children }));
      } catch (err) {
        this.logger.warn(`block "${node.block}" render failed: ${String(err)}`);
        parts.push(`<!-- block "${escapeHtml(node.block)}" failed -->`);
      }
    }
    return parts.join("\n");
  }

  private async siteInfo(): Promise<{
    name: string;
    description: string;
    /**
     * 사업자정보 — 값이 하나도 없으면 null.
     *
     * 테마 푸터가 `{{#if site.business}}` 로 감싸 렌더한다. 법적 표시 의무이므로
     * 테마가 아니라 사이트가 값을 갖는다 — 테마를 바꿀 때마다 다시 입력하게
     * 만들면 빠뜨린다 (docs/business-info.md).
     */
    business: Record<string, string> | null;
    /** 사이트 언어 (site.locale) — 테마 lang 속성과 t 가 이것을 따른다 */
    locale: Locale;
  }> {
    const rows = await this.db.select().from(siteSettings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const stored = (map.get("site.business_info") as Partial<BusinessInfo>) ?? {};
    return {
      name: (map.get("site.name") as string) ?? "Brick",
      description: (map.get("site.description") as string) ?? "",
      business: toTemplateVars({ ...EMPTY_BUSINESS_INFO, ...stored }),
      locale: normalizeLocale(map.get("site.locale")),
    };
  }

  /** 테마 템플릿이 {{#each menu}}로 순회할 내비게이션 */
  private async menu(location: string): Promise<Array<{ label: string; url: string }>> {
    const [row] = await this.db.select().from(menus).where(eq(menus.location, location)).limit(1);
    return (row?.items ?? []) as Array<{ label: string; url: string }>;
  }
}


