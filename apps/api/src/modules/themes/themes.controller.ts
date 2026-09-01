import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException,
  Param, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { installedThemes, siteSettings } from "@brick/database";
import { ThemesService } from "./themes.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { CacheProvider } from "@brick/core";
import { CACHE, DB } from "../../runtime.module.js";

@Controller("api/themes")
export class ThemesController {
  constructor(
    private readonly themes: ThemesService,
    private readonly installer: ExtensionInstallerService,
    @Inject(DB) private readonly db: BrickDb,
    @Inject(CACHE) private readonly cache: CacheProvider,
    private readonly audit: AuditService,
  ) {}

  /**
   * 활성 테마 팔레트 (CSS). 인증이 필요 없다 — 색은 공개 정보이고,
   * 로그인 화면 자체가 이걸 필요로 한다.
   */
  @Get("tokens.css")
  async tokensCss(@Res() reply: FastifyReply) {
    const { css, version } = await this.themes.activeTokensCss();
    return reply
      .header("content-type", "text/css; charset=utf-8")
      // 짧게 캐시한다 — 관리자가 색을 바꾸면 곧 반영되어야 하지만,
      // 모든 화면이 부르는 파일이라 매번 디스크를 읽을 이유는 없다
      .header("cache-control", "public, max-age=60")
      .header("x-theme-version", version)
      .send(css);
  }

  @Get()
  async list() {
    const [themes, active] = await Promise.all([this.themes.discover(), this.themes.activeThemeName()]);
    return { themes, active };
  }

  /** theme.zip 업로드 설치 (관리자). 빌드 과정 없음 — 전개 즉시 사용 가능 */
  @Post("upload")
  @UseGuards(AdminGuard)
  async upload(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException("multipart file required");
    const result = await this.installer.installTheme(await file.toBuffer());
    await this.audit.fromRequest(req as never, {
      action: "theme.install", targetType: "theme", targetId: result.name,
      summary: `${result.name}@${result.version} 업로드 설치`,
    });
    return result;
  }

  @Post(":name/activate")
  @UseGuards(AdminGuard)
  async activate(@Param("name") name: string, @Req() req: FastifyRequest) {
    const themes = await this.themes.discover();
    const target = themes.find((t) => t.name === name);
    if (!target) throw new NotFoundException(`theme "${name}" not found`);
    await this.db
      .insert(siteSettings)
      .values({ key: "theme.active", value: name as never })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value: name as never, updatedAt: new Date() } });
    await this.db.update(installedThemes).set({ isActive: false });
    await this.db.update(installedThemes).set({ isActive: true }).where(eq(installedThemes.name, name));
    await this.cache.invalidateTag("pages"); // 모든 페이지가 새 테마로 다시 렌더되어야 한다
    await this.audit.fromRequest(req as never, {
      action: "theme.activate", targetType: "theme", targetId: name, summary: `테마 적용: ${name}`,
    });
    return { ok: true, active: name };
  }

  /** Next.js 렌더 파이프라인이 호출: 슬롯 + 데이터 → 완성 HTML */
  @Post("render/:slot")
  render(@Param("slot") slot: string, @Body() body: { scope?: Record<string, unknown> }) {
    return this.themes.render(slot, body?.scope ?? {}).then((html) => ({ html }));
  }
}
