import {
  All, BadRequestException, Body, Controller, Get, HttpException, Inject, Logger,
  NotFoundException, Param, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { SITE_TZ, isRawResponse, type PluginUploadedFile } from "@brick/core";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";
import { ExtensionUpdaterService } from "../extensions/extension-updater.service.js";
import { AuditService } from "../audit/audit.service.js";
import { DB } from "../../runtime.module.js";

@Controller("api")
export class PluginsController {
  private readonly logger = new Logger(PluginsController.name);
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly auth: AuthService,
    private readonly installer: ExtensionInstallerService,
    private readonly updater: ExtensionUpdaterService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: BrickDb,
  ) {}

  @Get("plugins")
  async list() {
    const manifests = await this.loader.discover();
    return manifests.map((m) => ({ ...m, isActive: this.loader.isActive(m.name) }));
  }

  /** plugin.zip 업로드 설치 (관리자) */
  @Post("plugins/upload")
  @UseGuards(AdminGuard)
  async upload(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException("multipart file required");
    const result = await this.installer.installPlugin(await file.toBuffer());
    // 업데이트인 경우(이미 활성) 새 버전으로 자동 재적재 — 새 마이그레이션이 여기서 적용된다
    await this.loader.reload(result.name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.install",
      targetType: "plugin",
      targetId: result.name,
      summary: `${result.name}@${result.version} 업로드 설치`,
    });
    return { ...result, reloaded: this.loader.isActive(result.name) };
  }

  @Post("plugins/:name/activate")
  @UseGuards(AdminGuard)
  async activate(@Param("name") name: string, @Req() req: FastifyRequest) {
    await this.loader.activate(name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.activate", targetType: "plugin", targetId: name, summary: `${name} 활성화`,
    });
    return { ok: true };
  }

  @Post("plugins/:name/deactivate")
  @UseGuards(AdminGuard)
  async deactivate(@Param("name") name: string, @Req() req: FastifyRequest) {
    await this.loader.deactivate(name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.deactivate", targetType: "plugin", targetId: name, summary: `${name} 비활성화`,
    });
    return { ok: true };
  }

  /** 플러그인이 registerRoute로 등록한 라우트 디스패치 (":param" 지원, 세션 사용자 주입) */
  @All("plugins/:name/*")
  async dispatch(
    @Param("name") name: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const url = req.url.split("?")[0];
    const match = this.loader.matchRoute(req.method, url);
    if (!match) throw new NotFoundException();
    // ctx.t 가 읽는 사이트 언어 캐시를 갱신한다 (TTL 이라 사실상 공짜)
    await this.loader.refreshLocale();
    const user = await this.auth.resolveFromRequest(req);

    try {
      const result = await match.handler({
        params: match.params,
        query: req.query as Record<string, string>,
        body,
        user,
        ip: req.ip,
        // 지연 로딩: 업로드를 받지 않는 라우트는 본문을 읽지 않는다
        files: () => this.readFiles(req),
      });

      // 플러그인이 원본 응답(RSS 등)을 돌려주면 content-type을 지정해 그대로 보낸다
      if (isRawResponse(result)) {
        reply.status(result.status ?? 200).header("content-type", result.contentType);
        for (const [key, value] of Object.entries(result.headers ?? {})) reply.header(key, value);
        return result.body;
      }
      return result;
    } catch (err) {
      // 플러그인이 { status } 를 가진 에러를 던지면 HTTP 상태코드로 매핑한다
      const status = (err as { status?: number })?.status;
      if (status && status >= 400 && status < 600) {
        throw new HttpException((err as Error).message, status);
      }
      throw err;
    }
  }

  /**
   * multipart 파일을 모두 읽는다.
   * multipart 요청이 아니면 빈 배열 — 플러그인이 분기하지 않아도 되게 한다.
   */
  private async readFiles(req: FastifyRequest): Promise<PluginUploadedFile[]> {
    if (!req.isMultipart?.()) return [];
    const out: PluginUploadedFile[] = [];
    for await (const part of req.files()) {
      out.push({
        fileName: part.filename ?? "untitled",
        contentType: part.mimetype ?? "application/octet-stream",
        buffer: await part.toBuffer(),
      });
    }
    return out;
  }

  /**
   * 관리자 내비게이션 — 플러그인이 등록한 메뉴와 리소스.
   * 코어 관리자 셸이 이걸 읽어 사이드바를 구성한다.
   */
  @Get("admin/nav")
  @UseGuards(AdminGuard)
  async adminNav() {
    // 선언 라벨은 서빙 시점에 번역한다 (원문=키 — 로더 localizeAdminResource)
    await this.loader.refreshLocale();
    return {
      menus: this.loader.adminMenus.map((m) => this.loader.localizeAdminMenu(m)),
      resources: this.loader.adminResources
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map((r) => this.loader.localizeAdminResource(r.plugin, r))
        .map((r) => ({
          plugin: (r as { plugin: string }).plugin,
          name: r.name,
          title: r.title,
          itemLabel: r.itemLabel,
          order: r.order,
        })),
    };
  }

  /**
   * 관리자 대시보드 — "오늘의 사이트" 숫자들.
   *
   * 코어 통계(회원·페이지)와 플러그인 카드(registerDashboardCard)를 합친다.
   * 카드 하나가 실패해도 나머지는 나간다 — 플러그인 하나가 죽었다고
   * 대시보드 전체가 비면 운영자는 아무것도 볼 수 없다.
   */
  @Get("admin/dashboard")
  @UseGuards(AdminGuard)
  async adminDashboard() {
    const [core, cards] = await Promise.all([this.coreStats(), this.loader.collectDashboardCards()]);
    return { core, cards };
  }

  /**
   * 코어 통계 — 실패해도 카드처럼 격리한다 (null 반환). 잘못된
   * BRICK_TIMEZONE 하나로 대시보드 전체가 500 이 되면 정상 로드된
   * 플러그인 카드까지 전부 사라진다.
   *
   * "회원"의 정의는 members 모듈과 같아야 한다 (탈퇴·휴면 제외,
   * role='member') — 두 화면의 회원 수가 다르면 운영자는 어느 쪽도 믿지
   * 않는다. "오늘"의 경계는 판매 리포트와 같은 사이트 시간대(SITE_TZ)다.
   */
  private async coreStats(): Promise<{ members: number; membersToday: number; pages: number } | null> {
    try {
      const { rows } = await this.db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE withdrawn_at IS NULL AND dormant_at IS NULL AND role = 'member'
          ) AS members,
          count(*) FILTER (
            WHERE withdrawn_at IS NULL AND dormant_at IS NULL AND role = 'member'
              AND created_at >= (date_trunc('day', now() AT TIME ZONE ${SITE_TZ}) AT TIME ZONE ${SITE_TZ})
          ) AS members_today,
          (SELECT count(*) FROM pages WHERE status = 'published') AS pages
        FROM users
      `);
      return {
        members: Number(rows[0]?.members ?? 0),
        membersToday: Number(rows[0]?.members_today ?? 0),
        pages: Number(rows[0]?.pages ?? 0),
      };
    } catch (err) {
      this.logger.error(`대시보드 코어 통계 실패: ${String(err)}`);
      return null;
    }
  }

  /** 특정 리소스의 전체 스키마 — 관리자가 목록/폼 화면을 생성하는 데 쓴다 */
  @Get("admin/resources/:plugin/:name")
  @UseGuards(AdminGuard)
  async adminResource(@Param("plugin") plugin: string, @Param("name") name: string) {
    const found = this.loader.adminResources.find((r) => r.plugin === plugin && r.name === name);
    if (!found) throw new NotFoundException(`unknown admin resource: ${plugin}/${name}`);
    await this.loader.refreshLocale();
    return this.loader.localizeAdminResource(plugin, found);
  }

  /**
   * 업데이트 확인 — 설치된 확장의 업데이트 매니페스트를 조회한다.
   *
   * 자동으로 적용하지 않는다. 무엇이 바뀌는지 보여주고 운영자가 누른다 —
   * 자동 적용은 새벽에 사이트가 바뀌는 것이고, 그것을 원하는 운영자는 없다.
   */
  @Get("admin/updates")
  @UseGuards(AdminGuard)
  async checkUpdates() {
    return this.updater.check();
  }

  /** 업데이트 적용 — 서명 검증을 통과해야만 설치된다 (extension-updater.service.ts) */
  @Post("admin/updates/:kind/:name/apply")
  @UseGuards(AdminGuard)
  async applyUpdate(
    @Param("kind") kind: string,
    @Param("name") name: string,
    @Req() req: FastifyRequest,
  ) {
    if (kind !== "plugin" && kind !== "theme") {
      throw new BadRequestException("kind 는 plugin 또는 theme 이어야 합니다.");
    }
    const result = await this.updater.apply(kind, name);
    // 활성 플러그인이면 새 코드로 재적재 — 새 마이그레이션이 여기서 적용된다
    if (kind === "plugin" && this.loader.isActive(name)) {
      await this.loader.reload(name);
    }
    await this.audit.fromRequest(req as never, {
      action: "extension.update",
      targetType: kind,
      targetId: name,
      summary: `${name} ${result.from} → ${result.to} (원클릭 업데이트)`,
    });
    return { ...result, reloaded: kind === "plugin" && this.loader.isActive(name) };
  }

  /**
   * 레지스트리 목록 — 설치 가능한 확장과 설치 상태.
   * 레지스트리는 목록일 뿐, 신뢰는 서명이 결정한다 (ADR-74).
   */
  @Get("admin/registry")
  @UseGuards(AdminGuard)
  async registry() {
    return this.updater.listRegistry();
  }

  /** 레지스트리에서 설치 — 서명 검증을 통과해야만 설치된다 */
  @Post("admin/registry/:kind/:name/install")
  @UseGuards(AdminGuard)
  async installFromRegistry(
    @Param("kind") kind: string,
    @Param("name") name: string,
    @Body() body: { activate?: boolean } | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (kind !== "plugin" && kind !== "theme") {
      throw new BadRequestException("kind 는 plugin 또는 theme 이어야 합니다.");
    }
    const result = await this.updater.installFromRegistry(kind, name);
    // "몇 번의 클릭"을 줄인다 — 설치 화면에서 바로 켤 수 있게 (선택)
    if (kind === "plugin" && body?.activate === true) {
      await this.loader.activate(name);
    }
    await this.audit.fromRequest(req as never, {
      action: "extension.registry_install",
      targetType: kind,
      targetId: name,
      summary: `${name}@${result.version} 레지스트리 설치`,
    });
    return { ...result, activated: kind === "plugin" && this.loader.isActive(name) };
  }

  /** 페이지 빌더가 사용할 블록 카탈로그 */
  @Get("blocks")
  blocks() {
    return [...this.loader.blocks.values()].map(({ name, displayName, propsSchema }) => ({
      name,
      displayName,
      propsSchema,
    }));
  }

  /** 블록 서버 렌더 (Next.js가 페이지 조립 시 호출). 블록 이름에 "/"가 포함되므로 body로 받는다 */
  @Post("blocks/render")
  async renderBlock(
    @Body() body: {
      name: string;
      props?: Record<string, unknown>;
      path?: string;
      pathTail?: string;
      query?: Record<string, string>;
    },
    @Req() req: FastifyRequest,
  ) {
    const block = this.loader.blocks.get(body?.name ?? "");
    if (!block) throw new NotFoundException(`unknown block: ${body?.name}`);
    const user = await this.auth.resolveFromRequest(req);
    const html = await block.render(body?.props ?? {}, {
      children: [],
      path: body?.path ?? "",
      pathTail: body?.pathTail ?? "",
      query: body?.query ?? {},
      user: user ? { id: user.id, role: user.role, displayName: user.displayName } : null,
    });
    return { html };
  }
}
