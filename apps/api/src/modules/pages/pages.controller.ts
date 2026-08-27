import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject,
  NotFoundException, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { pages } from "@brick/database";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import { PageRenderService, type BlockNode } from "./page-render.service.js";
import { HookBus } from "@brick/core";
import { DB, HOOKS } from "../../runtime.module.js";

const SLUG_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;

interface PageDto {
  slug: string;
  title: string;
  blocks?: BlockNode[];
  status?: "draft" | "published" | "archived";
  seo?: { title?: string; description?: string };
}

@Controller("api")
export class PagesController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly renderer: PageRenderService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(HOOKS) private readonly hooks: HookBus,
  ) {}

  /**
   * 공개 렌더 파이프라인 — Next.js catch-all이 호출한다.
   *
   * 쿼리와 세션을 함께 넘긴다: 블록이 검색·페이지네이션·수정버튼을 처리해야 하고,
   * 렌더 캐시는 비로그인 요청에만 적용된다(사용자별 내용 유출 방지).
   */
  @Get("render/page")
  async renderPublic(@Query() query: Record<string, string>, @Req() req: FastifyRequest) {
    const { path, ...rest } = query ?? {};
    const user = await this.auth.resolveFromRequest(req);
    const result = await this.renderer.renderPath(path ?? "", {
      query: rest,
      user: user ? { id: user.id, role: user.role, displayName: user.displayName } : null,
    });

    /**
     * 방문 집계 훅.
     *
     * 응답을 기다리게 하지 않는다 — 집계는 렌더의 부수효과이고, 집계가 느리다고
     * 페이지가 늦게 뜨면 안 된다. HookBus가 플러그인 예외를 삼키므로
     * 처리되지 않은 rejection이 되지 않는다.
     *
     * 렌더 캐시가 적중한 요청에서도 이 훅은 발행된다 — 캐시된 페이지를 본 것도 방문이다.
     */
    void this.hooks.doAction("page.viewed", {
      path: path ?? "",
      userId: user?.id ?? null,
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
      referer: String(req.headers.referer ?? ""),
    });

    return result;
  }

  // ── 관리자 CRUD ──────────────────────────────────
  @Get("pages")
  @UseGuards(AdminGuard)
  async list() {
    return this.db
      .select({ id: pages.id, slug: pages.slug, title: pages.title, status: pages.status, updatedAt: pages.updatedAt })
      .from(pages)
      .orderBy(desc(pages.updatedAt));
  }

  @Get("pages/:id")
  @UseGuards(AdminGuard)
  async get(@Param("id") id: string) {
    const [row] = await this.db.select().from(pages).where(eq(pages.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post("pages")
  @UseGuards(AdminGuard)
  async create(@Body() dto: PageDto, @Req() req: FastifyRequest) {
    this.validate(dto);
    const id = uuidv7();
    try {
      await this.db.insert(pages).values({
        id,
        slug: dto.slug,
        title: dto.title,
        blocks: (dto.blocks ?? []) as never,
        plainText: await this.toPlainText(dto.blocks ?? []),
        status: dto.status ?? "draft",
        seo: (dto.seo ?? {}) as never,
        publishedAt: dto.status === "published" ? new Date() : null,
      });
    } catch (err) {
      if (String(err).includes("pages_slug_idx")) throw new ConflictException(`slug "${dto.slug}" already exists`);
      throw err;
    }
    await this.renderer.invalidate();
    await this.audit.fromRequest(req as never, {
      action: "page.create",
      targetType: "page",
      targetId: id,
      summary: `${dto.title} (/${dto.slug}, ${dto.status ?? "draft"})`,
    });
    return { id };
  }

  @Put("pages/:id")
  @UseGuards(AdminGuard)
  async update(@Param("id") id: string, @Body() dto: PageDto, @Req() req: FastifyRequest) {
    this.validate(dto);
    const [existing] = await this.db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, id)).limit(1);
    if (!existing) throw new NotFoundException();
    try {
      await this.db
        .update(pages)
        .set({
          slug: dto.slug,
          title: dto.title,
          blocks: (dto.blocks ?? []) as never,
          plainText: await this.toPlainText(dto.blocks ?? []),
          status: dto.status ?? "draft",
          seo: (dto.seo ?? {}) as never,
          updatedAt: new Date(),
        })
        .where(eq(pages.id, id));
    } catch (err) {
      if (String(err).includes("pages_slug_idx")) throw new ConflictException(`slug "${dto.slug}" already exists`);
      throw err;
    }
    // 전체 무효화: slug 변경, 다른 페이지에 포함된 블록 갱신 등을 안전하게 커버
    await this.renderer.invalidate();
    await this.audit.fromRequest(req as never, {
      action: "page.update",
      targetType: "page",
      targetId: id,
      summary:
        existing.slug === dto.slug
          ? `${dto.title} (/${dto.slug}, ${dto.status ?? "draft"})`
          : `슬러그 변경: ${existing.slug} → ${dto.slug}`,
    });
    return { ok: true };
  }

  @Delete("pages/:id")
  @UseGuards(AdminGuard)
  async remove(@Param("id") id: string, @Req() req: FastifyRequest) {
    const [target] = await this.db.select({ slug: pages.slug, title: pages.title })
      .from(pages).where(eq(pages.id, id)).limit(1);
    await this.db.delete(pages).where(eq(pages.id, id));
    await this.renderer.invalidate();
    await this.audit.fromRequest(req as never, {
      action: "page.delete",
      targetType: "page",
      targetId: id,
      summary: target ? `${target.title} (/${target.slug})` : id,
    });
    return { ok: true };
  }

  private validate(dto: PageDto): void {
    if (!SLUG_RE.test(dto?.slug ?? "")) {
      throw new BadRequestException("slug: 소문자/숫자/하이픈/슬래시만 허용");
    }
    if (dto.slug.includes("//") || dto.slug.endsWith("/")) throw new BadRequestException("invalid slug");
    if (!dto.title?.trim()) throw new BadRequestException("title required");
  }

  /** FTS 색인용 텍스트 — 블록을 렌더한 뒤 태그를 벗겨 저장 */
  private async toPlainText(blocks: BlockNode[]): Promise<string> {
    const html = await this.renderer.renderNodes(blocks);
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 10000);
  }
}
