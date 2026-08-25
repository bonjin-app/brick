import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException,
  Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { installedThemes, siteSettings } from "@brick/database";
import { ThemesService } from "./themes.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";
import { DB } from "../../runtime.module.js";

@Controller("api/themes")
export class ThemesController {
  constructor(
    private readonly themes: ThemesService,
    private readonly installer: ExtensionInstallerService,
    @Inject(DB) private readonly db: BrickDb,
  ) {}

  @Get()
  async list() {
    const [themes, active] = await Promise.all([this.themes.discover(), this.themes.activeThemeName()]);
    return { themes, active };
  }

  /** theme.zip 업로드 설치 (관리자). 빌드 과정 없음 — 전개 즉시 사용 가능 */
  @Post("upload")
  @UseGuards(AdminGuard)
  async upload(@Req() req: FastifyRequest) {
    const file = await (req as FastifyRequest & { file: () => Promise<{ toBuffer(): Promise<Buffer> } | undefined> }).file();
    if (!file) throw new BadRequestException("multipart file required");
    return this.installer.installTheme(await file.toBuffer());
  }

  @Post(":name/activate")
  @UseGuards(AdminGuard)
  async activate(@Param("name") name: string) {
    const themes = await this.themes.discover();
    const target = themes.find((t) => t.name === name);
    if (!target) throw new NotFoundException(`theme "${name}" not found`);
    await this.db
      .insert(siteSettings)
      .values({ key: "theme.active", value: name as never })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value: name as never, updatedAt: new Date() } });
    await this.db.update(installedThemes).set({ isActive: false });
    await this.db.update(installedThemes).set({ isActive: true }).where(eq(installedThemes.name, name));
    return { ok: true, active: name };
  }

  /** Next.js 렌더 파이프라인이 호출: 슬롯 + 데이터 → 완성 HTML */
  @Post("render/:slot")
  render(@Param("slot") slot: string, @Body() body: { scope?: Record<string, unknown> }) {
    return this.themes.render(slot, body?.scope ?? {}).then((html) => ({ html }));
  }
}
