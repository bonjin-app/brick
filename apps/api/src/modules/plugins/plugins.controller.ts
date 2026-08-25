import {
  All, BadRequestException, Body, Controller, Get, HttpException, NotFoundException,
  Param, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isRawResponse, type PluginUploadedFile } from "@brick/core";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";
import { AuditService } from "../audit/audit.service.js";

@Controller("api")
export class PluginsController {
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly auth: AuthService,
    private readonly installer: ExtensionInstallerService,
    private readonly audit: AuditService,
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
  adminNav() {
    return {
      menus: this.loader.adminMenus,
      resources: this.loader.adminResources
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map((r) => ({
          plugin: r.plugin,
          name: r.name,
          title: r.title,
          itemLabel: r.itemLabel,
          order: r.order,
        })),
    };
  }

  /** 특정 리소스의 전체 스키마 — 관리자가 목록/폼 화면을 생성하는 데 쓴다 */
  @Get("admin/resources/:plugin/:name")
  @UseGuards(AdminGuard)
  adminResource(@Param("plugin") plugin: string, @Param("name") name: string) {
    const found = this.loader.adminResources.find((r) => r.plugin === plugin && r.name === name);
    if (!found) throw new NotFoundException(`unknown admin resource: ${plugin}/${name}`);
    return found;
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
  async renderBlock(@Body() body: { name: string; props?: Record<string, unknown> }) {
    const block = this.loader.blocks.get(body?.name ?? "");
    if (!block) throw new NotFoundException(`unknown block: ${body?.name}`);
    const html = await block.render(body?.props ?? {});
    return { html };
  }
}
