import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject,
  NotFoundException, Param, Post, Put, Query, UseGuards,
} from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { pages } from "@brick/database";
import { AdminGuard } from "../auth/auth.guard.js";
import { PageRenderService, type BlockNode } from "./page-render.service.js";
import { DB } from "../../runtime.module.js";

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
  ) {}

  /** 공개 렌더 파이프라인 — Next.js catch-all이 호출한다 */
  @Get("render/page")
  async renderPublic(@Query("path") path: string) {
    return this.renderer.renderPath(path ?? "");
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
  async create(@Body() dto: PageDto) {
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
    return { id };
  }

  @Put("pages/:id")
  @UseGuards(AdminGuard)
  async update(@Param("id") id: string, @Body() dto: PageDto) {
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
    return { ok: true };
  }

  @Delete("pages/:id")
  @UseGuards(AdminGuard)
  async remove(@Param("id") id: string) {
    await this.db.delete(pages).where(eq(pages.id, id));
    await this.renderer.invalidate();
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
