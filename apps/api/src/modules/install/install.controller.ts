import { Controller, Get, Post, Body, Inject, BadRequestException, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { BrickDb } from "@brick/database";
import { mediaFiles, siteSettings, users } from "@brick/database";
import { DB, STORAGE } from "../../runtime.module.js";
import type { StorageProvider } from "@brick/core";
import { ImageService } from "../images/image.service.js";
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
    @Inject(STORAGE) private readonly storage: StorageProvider,
    private readonly images: ImageService,
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
      addSampleImage: (name, svg) => this.addSampleImage(name, svg),
    });

    return { ok: true, starter: starterCode, applied };
  }

  /**
   * 샘플 이미지를 미디어에 넣는다 — 실제 업로드와 같은 경로(스토리지 + media_files)를 쓴다.
   * SVG 를 받아 PNG 로 굽는다: SVG 는 업로드 금지 형식이고(스크립트를 담을 수 있다),
   * 굽고 나면 썸네일까지 같은 파이프라인을 탄다. sharp 가 없으면 null — 사진 없는 상품이 된다.
   */
  private async addSampleImage(fileName: string, svg: string): Promise<{ url: string; thumbUrl: string | null } | null> {
    try {
      if (!(await this.images.isAvailable())) return null;
      const source = Buffer.from(svg, "utf8");
      /*
       * SVG 를 1000×1000 JPEG 으로 굽는다. optimize() 를 쓰지 않는 이유: 그것은 "결과가
       * 원본보다 크면 원본을 쓴다"는 정책이라 400바이트 SVG 를 그대로 돌려준다(맞는 정책이다,
       * 용도가 다르다). 굽는 일은 thumbnail(format: "jpeg") 이 한다 — 작은 원본도 키운다.
       */
      const baked = await this.images.thumbnail(source, "image/png", { width: 1000, height: 1000, format: "jpeg", quality: 88 });
      if (!baked) return null;
      const id = uuidv7();
      const now = new Date();
      const dir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
      const key = `${dir}/${id}.jpg`;
      const stored = await this.storage.put(key, baked.buffer, "image/jpeg");
      const thumb = await this.images.thumbnail(baked.buffer, "image/jpeg");
      let thumbKey: string | null = null;
      if (thumb) {
        thumbKey = `${dir}/${id}-thumb${thumb.ext ?? ".webp"}`;
        await this.storage.put(thumbKey, thumb.buffer, thumb.contentType);
      }
      await this.db.insert(mediaFiles).values({
        id,
        storageKey: key,
        fileName,
        contentType: "image/jpeg",
        size: String(stored.size),
        width: baked.width,
        height: baked.height,
        thumbKey,
        uploaderId: null,
      });
      // 목록은 썸네일을 쓴다 — 상품이 이 주소를 함께 저장한다
      return { url: stored.url, thumbUrl: thumbKey ? this.storage.publicUrl(thumbKey) : null };
    } catch (err) {
      this.logger.warn(`샘플 이미지 생성 실패 (${fileName}) — 사진 없이 진행합니다: ${String(err)}`);
      return null;
    }
  }
}
