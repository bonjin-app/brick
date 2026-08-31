import { Injectable, Inject } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { siteSettings } from "@brick/database";
import type { ThemeManifest } from "@brick/shared";
import { renderTemplate } from "@brick/theme-sdk";
import { DB } from "../../runtime.module.js";

/**
 * ThemesService — 빌드 없는 런타임 테마.
 * themes/<name>/ 의 템플릿 파일을 읽어 즉시 렌더한다. ZIP 업로드 = 즉시 적용.
 */
@Injectable()
export class ThemesService {
  private readonly themesDir = resolve(process.env.BRICK_THEMES_DIR ?? "themes");

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  async discover(): Promise<ThemeManifest[]> {
    const entries = await readdir(this.themesDir, { withFileTypes: true }).catch(() => []);
    const list: ThemeManifest[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = await this.readManifest(e.name).catch(() => null);
      if (m) list.push(m);
    }
    return list;
  }

  async activeThemeName(): Promise<string> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "theme.active")).limit(1);
    return (row?.value as string) ?? "default";
  }

  /** 슬롯(layout/home/page/...)을 렌더해 완성된 HTML 반환 */
  async render(slot: string, scope: Record<string, unknown>): Promise<string> {
    const name = await this.activeThemeName();
    const manifest = await this.readManifest(name);
    const tplPath = manifest.templates[slot] ?? manifest.templates.page;
    if (!tplPath) throw new Error(`theme "${name}": no template for slot "${slot}"`);

    const body = renderTemplate(await this.read(name, tplPath), scope);
    const layout = renderTemplate(await this.read(name, manifest.templates.layout), {
      ...scope,
      content: body,
      themeTokens: this.tokensToCss(manifest.tokens ?? {}),
      // 버전 쿼리 = 캐시버스터. 없으면 테마를 고쳐도(ZIP 업데이트 포함)
      // 손님 브라우저가 옛 style.css 를 계속 쓴다 — 버전을 올리면 깨진다.
      themeAssets: `/themes/${name}/${manifest.assets ?? "assets"}`,
      themeVersion: encodeURIComponent(manifest.version ?? "0"),
    });
    return layout;
  }

  private tokensToCss(tokens: Record<string, string>): string {
    const vars = Object.entries(tokens)
      .map(([k, v]) => `--${k}: ${v};`)
      .join(" ");
    return `:root { ${vars} }`;
  }

  private async read(theme: string, rel: string): Promise<string> {
    return readFile(join(this.themesDir, theme, rel), "utf8");
  }

  private async readManifest(name: string): Promise<ThemeManifest> {
    const raw = await readFile(join(this.themesDir, name, "brick.theme.json"), "utf8");
    return JSON.parse(raw) as ThemeManifest;
  }
}
