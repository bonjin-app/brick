import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { pages, siteSettings } from "@brick/database";
import type { CacheProvider } from "@brick/core";
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

  async renderPath(rawPath: string): Promise<RenderedPage> {
    const path = rawPath.replace(/^\/+|\/+$/g, "") || "home";
    const cacheKey = `render:page:${path}`;
    const cached = await this.cache.get<RenderedPage>(cacheKey);
    if (cached) return cached;

    const result = await this.compute(path);
    await this.cache.setWithTags(cacheKey, result, ["pages", `page:${path}`], 300);
    return result;
  }

  /** 페이지/테마/플러그인 변경 시 호출 — 렌더 캐시 무효화 */
  async invalidate(slug?: string): Promise<void> {
    await this.cache.invalidateTag(slug ? `page:${slug}` : "pages");
  }

  private async compute(path: string): Promise<RenderedPage> {
    const site = { name: await this.siteName() };
    const [page] = await this.db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, path), eq(pages.status, "published")))
      .limit(1);

    if (!page) {
      // 홈 페이지가 없으면 테마의 home 슬롯으로 폴백 (설치 직후 상태)
      if (path === "home") {
        const html = await this.themes.render("home", { site, pageTitle: site.name, seo: {} });
        return { html, status: 200 };
      }
      const html = await this.themes.render("page", {
        site,
        pageTitle: `페이지를 찾을 수 없습니다 — ${site.name}`,
        title: "페이지를 찾을 수 없습니다",
        blocksHtml: `<p>요청하신 주소(/${escapeHtml(path)})에 해당하는 페이지가 없습니다.</p>`,
        seo: {},
      });
      return { html, status: 404 };
    }

    const seo = (page.seo ?? {}) as { title?: string; description?: string };
    const blocksHtml = await this.renderNodes((page.blocks ?? []) as BlockNode[]);
    const html = await this.themes.render("page", {
      site,
      title: page.title,
      pageTitle: seo.title ?? `${page.title} — ${site.name}`,
      blocksHtml,
      seo,
    });
    return { html, status: 200 };
  }

  /** 블록 트리 렌더. 한 블록의 실패가 페이지 전체를 죽이지 않는다 */
  async renderNodes(nodes: BlockNode[]): Promise<string> {
    const parts: string[] = [];
    for (const node of nodes ?? []) {
      const def = this.loader.blocks.get(node.block);
      if (!def) {
        parts.push(`<!-- unknown block: ${escapeHtml(node.block)} -->`);
        continue;
      }
      try {
        const children = node.children?.length
          ? await Promise.all(node.children.map((c) => this.renderNodes([c])))
          : [];
        parts.push(await def.render(node.props ?? {}, children));
      } catch (err) {
        this.logger.warn(`block "${node.block}" render failed: ${String(err)}`);
        parts.push(`<!-- block "${escapeHtml(node.block)}" failed -->`);
      }
    }
    return parts.join("\n");
  }

  private async siteName(): Promise<string> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "site.name")).limit(1);
    return (row?.value as string) ?? "Brick";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
