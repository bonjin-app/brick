import { Controller, Get, Post, Body, Inject, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { BrickDb } from "@brick/database";
import { siteSettings, users } from "@brick/database";
import { DB } from "../../runtime.module.js";

interface InstallDto {
  siteName: string;
  adminEmail: string;
  adminPassword: string;
}

/**
 * 설치 마법사 API.
 * DB 연결 정보는 여기서 받지 않는다 — DATABASE_URL은 docker-compose가 이미 넣어준다.
 * 사용자가 입력하는 것은 사이트명/관리자 계정뿐. (WordPress 5분 설치보다 짧게)
 */
@Controller("api/install")
export class InstallController {
  constructor(@Inject(DB) private readonly db: BrickDb) {}

  @Get("status")
  async status() {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "install.state")).limit(1);
    return { state: (row?.value as string) ?? "not_installed" };
  }

  @Post()
  async install(@Body() dto: InstallDto) {
    const { state } = await this.status();
    if (state === "installed") throw new BadRequestException("already installed");
    if (!dto?.siteName || !dto?.adminEmail || (dto?.adminPassword ?? "").length < 8) {
      throw new BadRequestException("siteName, adminEmail, adminPassword(8+) required");
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
    return { ok: true };
  }
}
