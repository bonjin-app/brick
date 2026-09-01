import { Injectable, Inject } from "@nestjs/common";
import { readFile, readdir, stat } from "node:fs/promises";
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
      themeVersion: await this.assetVersion(name, manifest),
    });
    return layout;
  }

  /**
   * 테마 스탬프 = 테마 버전 + **테마 파일들의 최종 수정 시각**.
   *
   * 두 곳에 쓴다: 에셋 URL 의 캐시버스터, 그리고 렌더 캐시 키.
   *
   * 버전만 쓰면 style.css 를 고쳐도 (1) 손님 브라우저가 옛 CSS 를 계속 쓰고
   * (2) 렌더 캐시가 옛 HTML 을 계속 내준다 — 테마를 직접 손보는 것이 운영자의
   * 일상인데(그게 런타임 테마의 이유다) 버전 올리기를 기억해야 한다면 잊는
   * 쪽이 기본값이 된다. 실제로 이 문제로 새 스타일이 화면에 안 나타나 한참
   * 헤맸다.
   *
   * 템플릿·에셋·매니페스트를 모두 본다. 에셋만 보면 layout.html 을 고친 경우가
   * 반영되지 않는다.
   *
   * mtime 조회는 5초 메모한다. 공개 페이지 핫패스에서 렌더마다 디렉터리를
   * 읽지 않으려는 것이고, 5초면 테마를 고치고 새로고침하는 사이에 반영된다.
   */
  private readonly stampCache = new Map<string, { at: number; value: string }>();

  /** 활성 테마의 스탬프 — 렌더 캐시 키에 섞는다 */
  async activeStamp(): Promise<string> {
    const name = await this.activeThemeName();
    const manifest = await this.readManifest(name).catch(() => null);
    return `${name}@${manifest ? await this.assetVersion(name, manifest) : "0"}`;
  }

  private async assetVersion(theme: string, manifest: ThemeManifest): Promise<string> {
    const base = encodeURIComponent(manifest.version ?? "0");
    const hit = this.stampCache.get(theme);
    if (hit && Date.now() - hit.at < 5_000) return hit.value;

    const newest = await this.newestMtime(join(this.themesDir, theme), 2);
    const value = newest ? `${base}-${Math.floor(newest / 1000)}` : base;
    this.stampCache.set(theme, { at: Date.now(), value });
    return value;
  }

  /** 디렉터리(및 depth 만큼의 하위)에서 가장 최근 수정 시각 */
  private async newestMtime(dirPath: string, depth: number): Promise<number> {
    let newest = 0;
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) {
        if (depth > 0) newest = Math.max(newest, await this.newestMtime(full, depth - 1));
        continue;
      }
      if (!e.isFile()) continue;
      const s = await stat(full).catch(() => null);
      if (s && s.mtimeMs > newest) newest = s.mtimeMs;
    }
    return newest;
  }

  /**
   * 테마 토큰 → CSS 커스텀 프로퍼티.
   *
   * **`dark-` 로 시작하는 키는 다크 팔레트다.** `dark-color-bg` 는 `--color-bg`
   * 의 어두운 값으로, 두 곳에 낸다 — OS 가 다크일 때(사용자가 라이트를 명시하지
   * 않은 경우) 그리고 사용자가 토글로 다크를 고른 경우. 이렇게 하면 style.css 와
   * 블록 CSS 는 `var(--color-bg)` 하나만 쓰면 되고 다크 대응이 공짜로 따라온다.
   * 테마가 dark- 토큰을 주지 않으면 다크 규칙 자체가 나오지 않는다(라이트 고정).
   *
   * 값은 **그대로 CSS 에 들어가므로 위생 처리한다.** 토큰은 테마 ZIP 과 관리자
   * 설정에서 오는데, 값에 `;}` 를 넣으면 선언을 닫고 임의의 규칙(예: 관리 메뉴
   * 숨기기, 가짜 오버레이)을 주입할 수 있다 — 관리자 권한이 필요한 경로라도
   * 저장 시점과 렌더 시점이 떨어져 있어(ZIP 재사용·백업 복원) 신뢰 경계로 둔다.
   */
  tokensToCss(tokens: Record<string, string>): string {
    const light: string[] = [];
    const dark: string[] = [];
    for (const [rawKey, rawVal] of Object.entries(tokens)) {
      const key = String(rawKey).trim();
      const val = String(rawVal ?? "").trim();
      // 키: CSS 식별자만. 값: 선언/규칙을 닫거나 주석을 열 수 없는 문자만
      if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key)) continue;
      if (!val || val.length > 200 || /[;{}<>\\]|\/\*|@|url\s*\(/i.test(val)) continue;
      const isDark = key.startsWith("dark-") && key.length > 5;
      (isDark ? dark : light).push(`--${isDark ? key.slice(5) : key}: ${val};`);
    }
    const css = [`:root { ${light.join(" ")} }`];
    if (dark.length) {
      const decls = dark.join(" ");
      // OS 다크 + 사용자가 라이트를 고르지 않았을 때
      css.push(`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${decls} } }`);
      // 사용자가 토글로 다크를 골랐을 때 (OS 가 라이트여도 이긴다)
      css.push(`:root[data-theme="dark"] { ${decls} }`);
    }
    return css.join("\n");
  }

  private async read(theme: string, rel: string): Promise<string> {
    return readFile(join(this.themesDir, theme, rel), "utf8");
  }

  /**
   * 활성 테마의 팔레트를 CSS 로. Next 로 그리는 화면(로그인·회원가입·마이
   * 페이지·관리자)이 같은 색을 쓰게 하는 통로다 — 이게 없으면 손님이 로그인
   * 화면으로 넘어가는 순간 사이트가 바뀐 것처럼 보이고, 다크 모드도 끊긴다.
   */
  async activeTokensCss(): Promise<{ css: string; version: string }> {
    const name = await this.activeThemeName();
    const manifest = await this.readManifest(name).catch(() => null);
    if (!manifest) return { css: ":root { }", version: "0" };
    return {
      css: this.tokensToCss(manifest.tokens ?? {}),
      version: await this.assetVersion(name, manifest),
    };
  }

  private async readManifest(name: string): Promise<ThemeManifest> {
    const raw = await readFile(join(this.themesDir, name, "brick.theme.json"), "utf8");
    return JSON.parse(raw) as ThemeManifest;
  }
}
