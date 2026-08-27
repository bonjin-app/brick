import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import type { SitemapUrl } from "@brick/core";
import { DB, ENV } from "../../runtime.module.js";
import type { loadEnv } from "../../config/env.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";

/**
 * sitemap.xml · robots.txt.
 *
 * SEO를 설계 전제로 내세우면서 사이트맵이 없는 것은 앞뒤가 맞지 않는다.
 * 특히 게시판이 있는 사이트는 색인해야 할 주소가 수만 개다 —
 * 링크를 따라가는 것만으로는 오래된 글에 닿지 못한다.
 *
 * 구조:
 *   /sitemap.xml        인덱스 (조각 목록)
 *   /sitemap-<n>.xml    조각 (최대 CHUNK_SIZE 개)
 *
 * 한 파일에 다 담지 않는 이유: 검색엔진 제한은 5만 개·50MB 지만,
 * 그누보드 사이트는 그것을 넘는 경우가 실제로 있고, 무엇보다 한 번에 다 읽으면
 * 메모리가 터진다. 조각을 나누면 페이지 단위로 스트리밍할 수 있다.
 */

/** 조각 하나에 담는 URL 수 — 검색엔진 제한(5만)보다 훨씬 작게 잡아 응답을 가볍게 유지한다 */
const CHUNK_SIZE = 2000;

interface Chunk {
  /** 이 조각이 담는 항목의 출처 */
  source: string;
  offset: number;
  limit: number;
}

@Injectable()
export class SeoService {
  private readonly log = new Logger("Seo");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(ENV) private readonly env: ReturnType<typeof loadEnv>,
    private readonly plugins: PluginLoaderService,
  ) {}

  private get base(): string {
    return this.env.siteUrl.replace(/\/+$/, "");
  }

  /**
   * 조각 목록을 계산한다.
   *
   * 코어 페이지가 항상 첫 조각이고, 그 뒤로 플러그인 공급자별 조각이 붙는다.
   * count() 가 실패하는 공급자는 건너뛴다 — 게시판 하나가 고장 나서
   * 사이트맵 전체가 사라지면 안 된다.
   */
  private async chunks(): Promise<Chunk[]> {
    const list: Chunk[] = [{ source: "pages", offset: 0, limit: CHUNK_SIZE }];

    const { rows } = await this.db.execute(sql`
      SELECT count(*) AS n FROM pages WHERE status = 'published'
    `);
    const pageCount = Number(rows[0]?.n ?? 0);
    for (let offset = CHUNK_SIZE; offset < pageCount; offset += CHUNK_SIZE) {
      list.push({ source: "pages", offset, limit: CHUNK_SIZE });
    }

    for (const source of this.plugins.sitemapSources) {
      try {
        const total = await source.count();
        for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
          list.push({ source: `${source.plugin}:${source.label}`, offset, limit: CHUNK_SIZE });
        }
      } catch (err) {
        this.log.warn(`사이트맵 개수 조회 실패 (${source.plugin}/${source.label}): ${String(err)}`);
      }
    }
    return list;
  }

  /** /sitemap.xml — 조각 목록 */
  async index(): Promise<string> {
    const list = await this.chunks();
    const now = new Date().toISOString();
    const entries = list
      .map(
        (_, i) =>
          `  <sitemap>\n    <loc>${escapeXml(`${this.base}/sitemap-${i + 1}.xml`)}</loc>\n` +
          `    <lastmod>${now}</lastmod>\n  </sitemap>`,
      )
      .join("\n");

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`
    );
  }

  /**
   * /sitemap-<n>.xml — 조각 하나.
   * @returns null 이면 그런 조각이 없다 (404)
   */
  async chunk(n: number): Promise<string | null> {
    const list = await this.chunks();
    const target = list[n - 1];
    if (!target) return null;

    let urls: SitemapUrl[] = [];

    if (target.source === "pages") {
      urls = await this.corePages(target.offset, target.limit);
      // 첫 조각에는 홈을 넣는다. 홈은 페이지 테이블에 없을 수도 있다(테마 기본 화면).
      if (target.offset === 0) {
        urls.unshift({ path: "/", changefreq: "daily", priority: 1.0 });
      }
    } else {
      const [plugin, label] = splitSource(target.source);
      const source = this.plugins.sitemapSources.find(
        (s) => s.plugin === plugin && s.label === label,
      );
      if (!source) return null;
      try {
        urls = await source.page({ offset: target.offset, limit: target.limit });
      } catch (err) {
        this.log.warn(`사이트맵 조회 실패 (${target.source}): ${String(err)}`);
        urls = [];
      }
    }

    const body = urls
      .map((u) => {
        const loc = u.path.startsWith("http") ? u.path : `${this.base}${normalizePath(u.path)}`;
        const parts = [`    <loc>${escapeXml(loc)}</loc>`];
        const lastmod = toIso(u.lastmod);
        if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
        if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
        if (typeof u.priority === "number") {
          parts.push(`    <priority>${clampPriority(u.priority)}</priority>`);
        }
        return `  <url>\n${parts.join("\n")}\n  </url>`;
      })
      .join("\n");

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
    );
  }

  /** 코어 페이지 — 발행된 것만 */
  private async corePages(offset: number, limit: number): Promise<SitemapUrl[]> {
    const { rows } = await this.db.execute(sql`
      SELECT slug, updated_at FROM pages
      WHERE status = 'published'
      ORDER BY created_at, id
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.map((r) => ({
      path: `/${String(r.slug)}`,
      lastmod: r.updated_at as Date,
      changefreq: "weekly" as const,
      priority: 0.7,
    }));
  }

  /**
   * robots.txt.
   *
   * 관리자·API·설치 경로를 막는다. 색인될 이유가 없고, 검색 결과에 로그인
   * 화면이 뜨는 것은 사이트가 관리되지 않는다는 신호로 읽힌다.
   *
   * 사이트가 아직 설치 전이거나 운영자가 검색 노출을 원하지 않으면
   * 전체를 막는다(site.seo_noindex 설정).
   */
  async robots(): Promise<string> {
    const { rows } = await this.db.execute(sql`
      SELECT value FROM site_settings WHERE key = 'site.seo_noindex' LIMIT 1
    `);
    const noindex = rows[0]?.value === true || rows[0]?.value === "true";

    if (noindex) {
      return [
        "# 검색 노출이 꺼져 있습니다 (관리자 → 설정 → SEO)",
        "User-agent: *",
        "Disallow: /",
        "",
      ].join("\n");
    }

    return [
      "User-agent: *",
      "Allow: /",
      "",
      "# 색인될 이유가 없는 경로",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /install",
      "Disallow: /login",
      "Disallow: /register",
      "Disallow: /reset-password",
      "Disallow: /forgot-password",
      "",
      `Sitemap: ${this.base}/sitemap.xml`,
      "",
    ].join("\n");
  }
}

/* ── 헬퍼 ──────────────────────────────────────────── */

/** `plugin:label` 을 되돌린다. label 에 콜론이 있을 수 있으므로 첫 콜론만 자른다 */
function splitSource(source: string): [string, string] {
  const i = source.indexOf(":");
  return i < 0 ? [source, ""] : [source.slice(0, i), source.slice(i + 1)];
}

function normalizePath(path: string): string {
  const p = String(path ?? "/");
  return p.startsWith("/") ? p : `/${p}`;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function clampPriority(n: number): string {
  return Math.min(1, Math.max(0, n)).toFixed(1);
}

/**
 * XML 이스케이프.
 *
 * slug 에는 보통 안전한 문자만 들어가지만, 사용자가 입력하는 값이므로
 * 앰퍼샌드 하나로 사이트맵 전체가 파싱 불가가 되는 것을 막는다.
 */
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
