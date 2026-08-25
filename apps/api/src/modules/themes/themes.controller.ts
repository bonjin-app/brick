import { Controller, Get, Post, Param, Body } from "@nestjs/common";
import { ThemesService } from "./themes.service.js";

@Controller("api/themes")
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get()
  list() {
    return this.themes.discover();
  }

  /** Next.js 렌더 파이프라인이 호출: 슬롯 + 데이터 → 완성 HTML */
  @Post("render/:slot")
  render(@Param("slot") slot: string, @Body() body: { scope?: Record<string, unknown> }) {
    return this.themes.render(slot, body?.scope ?? {}).then((html) => ({ html }));
  }
}
