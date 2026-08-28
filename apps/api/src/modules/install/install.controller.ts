import { Controller, Get, Post, Body, Inject, BadRequestException, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { BrickDb } from "@brick/database";
import { siteSettings, users } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { STARTERS, applyStarter, findStarter } from "./starters.js";

interface InstallDto {
  siteName: string;
  adminEmail: string;
  adminPassword: string;
  /** 사이트 유형 (starters.ts). 없거나 "blank" 면 빈 사이트 */
  starter?: string;
}

/**
 * 설치 마법사 API.
 * DB 연결 정보는 여기서 받지 않는다 — DATABASE_URL은 docker-compose가 이미 넣어준다.
 * 사용자가 입력하는 것은 사이트명/관리자 계정/사이트 유형뿐.
 *
 * 사이트 유형을 고르면 기본 구성(홈·페이지·게시판·메뉴·플러그인)이 함께
 * 만들어진다 — 설치가 끝나면 이미 돌아가는 사이트가 있다 (starters.ts).
 */
@Controller("api/install")
export class InstallController {
  private readonly logger = new Logger("Install");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly loader: PluginLoaderService,
  ) {}

  @Get("status")
  async status() {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "install.state")).limit(1);
    return { state: (row?.value as string) ?? "not_installed" };
  }

  /** 설치 화면이 유형 선택지를 그리는 데 쓴다 */
  @Get("starters")
  starters() {
    return {
      items: STARTERS.map((s) => ({
        code: s.code,
        label: s.label,
        description: s.description,
        creates: s.creates,
      })),
    };
  }

  @Post()
  async install(@Body() dto: InstallDto) {
    const { state } = await this.status();
    if (state === "installed") throw new BadRequestException("already installed");
    if (!dto?.siteName || !dto?.adminEmail || (dto?.adminPassword ?? "").length < 8) {
      throw new BadRequestException("siteName, adminEmail, adminPassword(8+) required");
    }
    // 모르는 유형은 조용히 빈 사이트로 만들지 않는다 — 오타를 알려줘야 한다
    const starterCode = String(dto.starter ?? "blank");
    if (!findStarter(starterCode)) {
      throw new BadRequestException(`unknown starter: ${starterCode}`);
    }

    await this.db.insert(users).values({
      id: uuidv7(),
      email: dto.adminEmail,
      passwordHash: await argon2.hash(dto.adminPassword),
      displayName: "Administrator",
      role: "admin",
    });

    const set = async (key: string, value: unknown) =>
      this.db
        .insert(siteSettings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value: value as never, updatedAt: new Date() } });

    await set("site.name", dto.siteName);
    await set("theme.active", "default");
    await set("install.state", "installed");

    // 스타터는 설치 성공 뒤에 적용한다 — 플러그인 활성화(마이그레이션 포함)가
    // 실패해도 설치 자체는 성공해야 한다. 반쯤 만들어진 기본 구성은 고칠 수
    // 있지만, 설치가 실패하면 처음부터다.
    const { applied } = await applyStarter(starterCode, {
      db: this.db,
      siteName: dto.siteName,
      activatePlugin: (name) => this.loader.activate(name),
      log: (m) => this.logger.warn(m),
    });

    return { ok: true, starter: starterCode, applied };
  }
}
