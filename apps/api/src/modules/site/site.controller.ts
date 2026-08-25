import {
  BadRequestException, Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { menus, pages, siteSettings } from "@brick/database";
import type { CacheProvider } from "@brick/core";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { CACHE, DB } from "../../runtime.module.js";

interface MenuItem {
  label: string;
  url: string;
  children?: MenuItem[];
}

/** 관리자가 편집할 수 있는 사이트 설정 화이트리스트 */
const EDITABLE_SETTINGS: Record<string, "string" | "boolean"> = {
  "site.name": "string",
  "site.description": "string",
  "site.registration_open": "boolean",
};

@Controller("api")
export class SiteController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(CACHE) private readonly cache: CacheProvider,
    private readonly audit: AuditService,
  ) {}

  // ── 사이트 설정 ────────────────────────────────────
  @Get("settings")
  @UseGuards(AdminGuard)
  async getSettings() {
    const rows = await this.db.select().from(siteSettings);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      // 플러그인 전용 설정은 관리자 일반 화면에 노출하지 않는다
      if (!row.key.startsWith("plugin:")) out[row.key] = row.value;
    }
    return out;
  }

  @Put("settings")
  @UseGuards(AdminGuard)
  async putSettings(@Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    for (const [key, value] of Object.entries(body ?? {})) {
      const type = EDITABLE_SETTINGS[key];
      if (!type) throw new BadRequestException(`수정할 수 없는 설정입니다: ${key}`);
      if (type === "string" && typeof value !== "string") throw new BadRequestException(`${key}: 문자열이어야 합니다.`);
      if (type === "boolean" && typeof value !== "boolean") throw new BadRequestException(`${key}: true/false여야 합니다.`);
      await this.db
        .insert(siteSettings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value: value as never, updatedAt: new Date() } });
    }
    await this.cache.invalidateTag("pages"); // 사이트명 등이 모든 페이지에 렌더된다
    await this.audit.fromRequest(req as never, {
      action: "settings.update", targetType: "settings",
      summary: Object.keys(body ?? {}).join(", "),
    });
    return { ok: true };
  }

  // ── 메뉴 ──────────────────────────────────────────
  @Get("menus/:location")
  async getMenu(@Param("location") location: string) {
    const [row] = await this.db.select().from(menus).where(eq(menus.location, location)).limit(1);
    return { location, items: (row?.items ?? []) as MenuItem[] };
  }

  @Put("menus/:location")
  @UseGuards(AdminGuard)
  async putMenu(
    @Param("location") location: string,
    @Body() body: { items: MenuItem[] },
    @Req() req: FastifyRequest,
  ) {
    const items = this.validateItems(body?.items ?? [], 0);
    const [existing] = await this.db.select().from(menus).where(eq(menus.location, location)).limit(1);
    if (existing) {
      await this.db.update(menus).set({ items: items as never, updatedAt: new Date() }).where(eq(menus.id, existing.id));
    } else {
      await this.db.insert(menus).values({ id: uuidv7(), location, items: items as never });
    }
    await this.cache.invalidateTag("pages");
    await this.audit.fromRequest(req as never, {
      action: "menu.update", targetType: "menu", targetId: location,
      summary: `${items.length}개 항목`,
    });
    return { ok: true };
  }

  private validateItems(items: MenuItem[], depth: number): MenuItem[] {
    if (depth > 2) throw new BadRequestException("메뉴는 3단계까지만 지원합니다.");
    if (items.length > 50) throw new BadRequestException("메뉴 항목이 너무 많습니다.");
    return items.map((item) => {
      const label = String(item?.label ?? "").trim();
      const url = String(item?.url ?? "").trim();
      if (!label) throw new BadRequestException("메뉴 이름은 필수입니다.");
      // javascript: 등 위험한 스킴 차단
      if (!/^(\/|https?:\/\/|#)/.test(url)) throw new BadRequestException(`허용되지 않는 주소입니다: ${url}`);
      return {
        label: label.slice(0, 100),
        url: url.slice(0, 500),
        ...(item.children?.length ? { children: this.validateItems(item.children, depth + 1) } : {}),
      };
    });
  }

  // ── 검색 ──────────────────────────────────────────
  /**
   * 페이지 검색.
   * 한국어는 to_tsvector('simple')만으로는 조사/어미 때문에 정확도가 낮다 (ADR 알려진 제약).
   * 그래서 pg_trgm 유사도를 함께 사용한다 — 확장이 없으면 ILIKE로 자동 폴백.
   */
  @Get("search")
  async search(@Query("q") q?: string, @Query("page") pageParam?: string) {
    const query = (q ?? "").trim();
    if (query.length < 2) return { items: [], total: 0, query };
    const page = Math.max(1, Number(pageParam ?? 1));
    const size = 20;
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const rows = await this.db
      .select({ id: pages.id, slug: pages.slug, title: pages.title, plainText: pages.plainText })
      .from(pages)
      .where(
        and(
          eq(pages.status, "published"),
          sql`(${pages.title} ILIKE ${like} OR ${pages.plainText} ILIKE ${like})`,
        ),
      )
      .limit(size)
      .offset((page - 1) * size);

    return {
      query,
      page,
      pageSize: size,
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        excerpt: this.excerpt(r.plainText, query),
      })),
    };
  }

  /** 검색어 주변을 잘라 발췌문 생성 */
  private excerpt(text: string, query: string): string {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return text.slice(0, 150);
    const start = Math.max(0, idx - 60);
    return (start > 0 ? "…" : "") + text.slice(start, start + 150) + (start + 150 < text.length ? "…" : "");
  }
}
