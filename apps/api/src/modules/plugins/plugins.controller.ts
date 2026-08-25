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
    const file = await (req as FastifyRequest & { file: () => Promise<{ toBuffer(): Promise<Buffer> } | undefined> }).file();
    if (!file) throw new BadRequestException("multipart file required");
    return this.installer.installPlugin(await file.toBuffer());
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
