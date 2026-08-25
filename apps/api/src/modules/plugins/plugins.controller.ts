import { Controller, Get, Post, Param, Body, All, Req, NotFoundException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { PluginLoaderService } from "./plugin-loader.service.js";

@Controller("api")
export class PluginsController {
  constructor(private readonly loader: PluginLoaderService) {}

  @Get("plugins")
  async list() {
    return this.loader.discover();
  }

  @Post("plugins/:name/activate")
  async activate(@Param("name") name: string) {
    await this.loader.activate(name);
    return { ok: true };
  }

  @Post("plugins/:name/deactivate")
  async deactivate(@Param("name") name: string) {
    await this.loader.deactivate(name);
    return { ok: true };
  }

  /** 플러그인이 registerRoute로 등록한 라우트 디스패치 (":param" 지원) */
  @All("plugins/:name/*")
  async dispatch(@Param("name") name: string, @Req() req: FastifyRequest, @Body() body: unknown) {
    const url = req.url.split("?")[0];
    const match = this.loader.matchRoute(req.method, url);
    if (!match) throw new NotFoundException();
    return match.handler({
      params: match.params,
      query: req.query as Record<string, string>,
      body,
      user: null, // TODO: 세션 미들웨어 연결
    });
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
