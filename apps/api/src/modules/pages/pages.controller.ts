import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { pages } from "@brick/database";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import { PageRenderService, type BlockNode } from "./page-render.service.js";
import { PublishSchedulerService } from "./publish-scheduler.service.js";
import { RevisionsService } from "./revisions.service.js";
import { HookBus } from "@brick/core";
import { DB, HOOKS } from "../../runtime.module.js";
import { isUniqueViolation } from "@brick/core";
import { msg } from "../../common/localized-error.js";

const SLUG_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;

interface PageDto {
  slug: string;
  title: string;
  blocks?: BlockNode[];
  status?: PageStatus;
  seo?: { title?: string; description?: string };
  /**
   * 공개 시각 (ISO 8601).
   *
   * `status: "scheduled"` 일 때 **필수**다 — 언제 여는지가 곧 예약이다.
   * 다른 상태에서는 무시한다(공개 시각은 서버가 정한다).
   */
  publishedAt?: string | null;
  /** 이 저장에 붙일 한 줄 (되돌리기가 쓴다 — 사람은 보통 비워 둔다) */
  revisionNote?: string;
}

const PAGE_STATUS = ["draft", "scheduled", "published", "archived"] as const;
type PageStatus = (typeof PAGE_STATUS)[number];

@Controller("api")
export class PagesController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly renderer: PageRenderService,
    private readonly scheduler: PublishSchedulerService,
    private readonly revisions: RevisionsService,
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
  /**
   * 테마 미리보기 — 관리자만. 활성 테마를 바꾸지 않고 **내 사이트 내용**으로 그려 본다.
   * 워드프레스의 라이브 프리뷰와 같은 목적이다: 팔레트 견본만으로는 레이아웃을 알 수 없다.
   * 적용은 여전히 activate 뿐이고, 이 응답은 캐시되지 않는다(활성 테마 캐시를 오염시키지 않는다).
   */
  @Get("admin/render/preview")
  @UseGuards(AdminGuard)
  async renderPreview(@Query() query: Record<string, string>, @Req() req: FastifyRequest) {
    const { path, theme, ...rest } = query ?? {};
    if (!theme || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(theme)) {
      throw new BadRequestException("미리보기할 테마 이름이 올바르지 않습니다.");
    }
    const user = await this.auth.resolveFromRequest(req);
    /*
     * 미리보기는 대체 테마로 물러나지 않는다(그러면 미리보기가 거짓말을 한다).
     * 대신 **왜 안 되는지**를 그대로 전한다 — 500 "Internal server error" 만
     * 보면 올린 테마의 어디가 잘못됐는지 알 길이 없다.
     */
    try {
      return await this.renderer.renderPath(path ?? "", {
        query: rest,
        user: user ? { id: user.id, role: user.role, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null } : null,
        previewTheme: theme,
      });
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  @Get("render/page")
  async renderPublic(@Query() query: Record<string, string>, @Req() req: FastifyRequest) {
    const { path, ...rest } = query ?? {};
    const user = await this.auth.resolveFromRequest(req);
    const result = await this.renderer.renderPath(path ?? "", {
      query: rest,
      user: user ? { id: user.id, role: user.role, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null } : null,
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
      // publishedAt 도 준다 — 예약은 "언제" 가 곧 상태다 (목록에서 그대로 보여준다)
      .select({
        id: pages.id, slug: pages.slug, title: pages.title,
        status: pages.status, updatedAt: pages.updatedAt, publishedAt: pages.publishedAt,
      })
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

  /**
   * 때가 된 예약을 지금 확인한다 (관리자).
   *
   * 주기 확인(30초)과 **같은 코드**를 돈다 — 시험용 통로를 따로 만들면 시험이
   * 통과해도 실제로 도는 것은 검증되지 않는다(정기결제 스윕과 같은 판단).
   * 운영에서도 쓸 자리가 있다: "예약이 돌긴 하나" 를 그 자리에서 확인한다.
   */
  /**
   * 아직 공개되지 않은 페이지 미리보기 (관리자) — **완성된 HTML** 을 그대로 준다.
   *
   * 예약해 둔 페이지를 열기 전에 확인할 방법이 없었다. 자정 공개를 예약해 놓고
   * 자정에 처음 본다면, 오타 하나도 손님이 먼저 본다. 임시저장도 같다.
   *
   * JSON 이 아니라 HTML 로 주는 이유: 관리자가 새 탭으로 열어 **실제 화면 그대로**
   * 보는 것이 목적이기 때문이다(모달 안의 축소판이 아니라).
   * 캐시하지 않고, 검색엔진에도 올리지 않는다.
   */
  @Get("admin/pages/:id/preview")
  @UseGuards(AdminGuard)
  async preview(@Param("id") id: string, @Res() reply: FastifyReply) {
    const [row] = await this.db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    const result = await this.renderer.renderPath(row.slug === "home" ? "" : row.slug, {
      includeUnpublished: true,
    });
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex")
      .send(result.html);
  }

  // ── 이전 버전 (리비전) ───────────────────────────
  //
  // 덮어쓰면 되돌릴 길이 없었다. 블록 열 개를 지우고 저장한 뒤에야 잘못을
  // 알아채도 운영자가 할 수 있는 일은 기억을 더듬어 다시 만드는 것뿐이었다.

  /** 판 목록 (내용은 빼고) */
  @Get("pages/:id/revisions")
  @UseGuards(AdminGuard)
  async revisionList(@Param("id") id: string) {
    await this.mustExist(id);
    return { items: await this.revisions.list(id) };
  }

  /** 판 하나 — 내용까지. 편집기가 "이 판은 이랬다" 를 보여줄 때 쓴다 */
  @Get("pages/:id/revisions/:revNo")
  @UseGuards(AdminGuard)
  async revisionGet(@Param("id") id: string, @Param("revNo") revNo: string) {
    await this.mustExist(id);
    const rev = await this.revisions.get(id, Number(revNo));
    if (!rev) throw new NotFoundException(msg("err.revisionNotFound", { no: String(revNo) }));
    return rev;
  }

  /**
   * 이 판으로 되돌린다.
   *
   * 되돌리기도 **하나의 저장**이다 — 되돌린 내용이 새 판으로 남으므로 되돌리기를
   * 되돌릴 수 있다. 판을 지우거나 번호를 되감지 않는다.
   *
   * 주소(slug)와 공개 상태는 되돌리지 않는다. 주소를 되돌리면 그 사이에 걸어 둔
   * 링크·메뉴가 끊기고 다른 페이지가 그 주소를 가져갔으면 저장 자체가 실패한다.
   * 공개 상태는 내용이 아니다 — 본문을 되돌리는 일이 사이트를 공개하거나
   * 내려서는 안 된다.
   */
  @Post("pages/:id/revisions/:revNo/restore")
  @UseGuards(AdminGuard)
  async revisionRestore(@Param("id") id: string, @Param("revNo") revNo: string, @Req() req: FastifyRequest) {
    const page = await this.mustExist(id);
    const rev = await this.revisions.get(id, Number(revNo));
    if (!rev) throw new NotFoundException(msg("err.revisionNotFound", { no: String(revNo) }));

    await this.db
      .update(pages)
      .set({
        title: rev.title,
        blocks: rev.blocks as never,
        plainText: await this.toPlainText((rev.blocks ?? []) as BlockNode[]),
        seo: rev.seo as never,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id));

    const newRev = await this.revisions.snapshot({
      pageId: id,
      title: rev.title,
      slug: page.slug,
      blocks: rev.blocks,
      seo: rev.seo,
      status: page.status,
      authorId: (req as { user?: { id: string } }).user?.id ?? null,
      note: `${rev.revNo}판으로 되돌림`,
    });
    await this.renderer.invalidate();
    await this.audit.fromRequest(req as never, {
      action: "page.revision.restore",
      targetType: "page",
      targetId: id,
      summary: `${page.title} (/${page.slug}) — ${rev.revNo}판으로 되돌림`,
    });
    return { ok: true, restoredFrom: rev.revNo, revNo: newRev };
  }

  /** 있는 페이지인가 — 없는 페이지의 판을 묻는 것은 404 다 */
  private async mustExist(id: string) {
    const [row] = await this.db
      .select({ slug: pages.slug, title: pages.title, status: pages.status })
      .from(pages)
      .where(eq(pages.id, id))
      .limit(1);
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post("admin/pages/publish-due")
  @UseGuards(AdminGuard)
  async publishDue() {
    return { published: await this.scheduler.run() };
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
        // published 면 지금, scheduled 면 운영자가 고른 때, 나머지는 아직 없다
        publishedAt:
          dto.status === "published" ? new Date() : dto.status === "scheduled" ? this.scheduledAt(dto) : null,
      });
    } catch (err) {
      if (isUniqueViolation(err, "pages_slug")) throw new ConflictException(msg("err.slugTaken", { slug: String(dto.slug) }));
      throw err;
    }
    // 처음 만든 내용도 한 판이다 — 없으면 두 번째 저장 뒤에 원래 모습을 잃는다
    await this.revisions.snapshot({
      pageId: id,
      title: dto.title,
      slug: dto.slug,
      blocks: dto.blocks ?? [],
      seo: dto.seo ?? {},
      status: dto.status ?? "draft",
      authorId: (req as { user?: { id: string } }).user?.id ?? null,
    });
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
    const [existing] = await this.db
      .select({ slug: pages.slug, publishedAt: pages.publishedAt })
      .from(pages)
      .where(eq(pages.id, id))
      .limit(1);
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
          /*
           * 공개 시각.
           *
           * 예약이면 고른 때, 공개면 **처음 공개한 때를 지킨다**(다시 저장할
           * 때마다 오늘로 밀리면 그 값은 아무 뜻도 없어진다 — 예전에는 update 가
           * 이 칸을 아예 건드리지 않아서, 임시저장으로 만든 뒤 공개한 페이지는
           * 공개 시각이 영원히 비어 있었다). 임시저장·보관은 그대로 둔다.
           */
          publishedAt:
            dto.status === "scheduled"
              ? this.scheduledAt(dto)
              : dto.status === "published"
                ? (existing.publishedAt ?? new Date())
                : existing.publishedAt,
          updatedAt: new Date(),
        })
        .where(eq(pages.id, id));
    } catch (err) {
      if (isUniqueViolation(err, "pages_slug")) throw new ConflictException(msg("err.slugTaken", { slug: String(dto.slug) }));
      throw err;
    }
    await this.revisions.snapshot({
      pageId: id,
      title: dto.title,
      slug: dto.slug,
      blocks: dto.blocks ?? [],
      seo: dto.seo ?? {},
      status: dto.status ?? "draft",
      authorId: (req as { user?: { id: string } }).user?.id ?? null,
      note: dto.revisionNote,
    });
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
    if (dto.slug.includes("//") || dto.slug.endsWith("/")) throw new BadRequestException("주소는 영문 소문자·숫자·하이픈만 쓸 수 있습니다.");
    if (!dto.title?.trim()) throw new BadRequestException("제목을 입력해주세요.");
    /*
     * 상태는 아는 값만 받는다.
     *
     * 전에는 아무 문자열이나 저장됐다. 오타 하나면(`publishd`) 저장은 성공하는데
     * 페이지는 어디에도 나오지 않는다 — 공개 여부를 보는 곳은 전부 `published`
     * 하나를 보기 때문이다. 운영자는 "공개로 저장했는데 안 보인다" 를 겪는다.
     */
    const status = dto.status ?? "draft";
    if (!(PAGE_STATUS as readonly string[]).includes(status)) {
      throw new BadRequestException(msg("err.pageStatus", { status: String(status) }));
    }
    if (status === "scheduled") {
      const at = this.scheduledAt(dto);
      if (!at) throw new BadRequestException(msg("err.scheduleTime"));
      /*
       * 지난 시각은 거절한다.
       *
       * "지났으니 지금 공개" 로 처리할 수도 있지만, 그러면 연도를 잘못 적은
       * 예약이 **조용히 즉시 공개**된다 — 예약을 쓰는 이유가 그 반대다.
       */
      if (at.getTime() <= Date.now()) throw new BadRequestException(msg("err.schedulePast"));
    }
  }

  /** dto 의 예약 시각 — 읽을 수 없으면 null */
  private scheduledAt(dto: PageDto): Date | null {
    const raw = String(dto.publishedAt ?? "").trim();
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /** FTS 색인용 텍스트 — 블록을 렌더한 뒤 태그를 벗겨 저장 */
  /**
   * 검색 색인용 본문. 블록은 자기 CSS 를 <style> 로 함께 내놓으므로(게시판·상점 블록)
   * 태그만 벗기면 CSS 원문이 색인되어 "border-radius" 로 페이지가 검색되고 발췌문에 CSS 가 찍힌다.
   * style/script/template 은 내용까지 지우고, 자주 나오는 엔티티는 글자로 되돌린다.
   */
  private async toPlainText(blocks: BlockNode[]): Promise<string> {
    const html = await this.renderer.renderNodes(blocks);
    return html
      .replace(/<(style|script|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000);
  }
}
