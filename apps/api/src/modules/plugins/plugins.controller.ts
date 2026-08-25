import {
  All, BadRequestException, Body, Controller, Get, HttpException, NotFoundException,
  Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";

@Controller("api")
export class PluginsController {
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly auth: AuthService,
    private readonly installer: ExtensionInstallerService,
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
    return { ...result, reloaded: this.loader.isActive(result.name) };
  }

  @Post("plugins/:name/activate")
  @UseGuards(AdminGuard)
  async activate(@Param("name") name: string) {
    await this.loader.activate(name);
    return { ok: true };
  }

  @Post("plugins/:name/deactivate")
  @UseGuards(AdminGuard)
  async deactivate(@Param("name") name: string) {
    await this.loader.deactivate(name);
    return { ok: true };
  }

  /** 플러그인이 registerRoute로 등록한 라우트 디스패치 (":param" 지원, 세션 사용자 주입) */
  @All("plugins/:name/*")
  async dispatch(@Param("name") name: string, @Req() req: FastifyRequest, @Body() body: unknown) {
    const url = req.url.split("?")[0];
    const match = this.loader.matchRoute(req.method, url);
    if (!match) throw new NotFoundException();
    const user = await this.auth.resolveFromRequest(req);
    try {
      return await match.handler({
        params: match.params,
        query: req.query as Record<string, string>,
        body,
        user,
      });
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
