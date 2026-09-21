import { Injectable, Inject, Logger } from "@nestjs/common";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { siteSettings } from "@brick/database";
import type { ThemeManifest } from "@brick/shared";
import { renderTemplate } from "@brick/theme-sdk";
import { DB } from "../../runtime.module.js";
import { renderBuiltinLayout } from "./builtin-layout.js";

/**
 * 활성 테마를 못 읽을 때 대신 그리는 테마 — Brick 이 함께 설치하는 기본 테마다.
 * 이것마저 없으면 내장 레이아웃(builtin-layout.ts)이 받는다.
 */
const FALLBACK_THEME = "default";

/** 활성 테마를 못 읽고 대체로 그리는 중이라는 기록 */
export interface ThemeFailure {
  /** 운영자가 고른 테마 (지금 못 읽는 것) */
  theme: string;
  /** 왜 못 읽는가 — 관리 화면이 그대로 보여준다 */
  message: string;
  /** 대신 그리는 테마. 빈 문자열이면 내장 레이아웃이다 */
  fallback: string;
  /** 실패했을 때의 테마 스탬프 — 파일이 바뀌었는지 보는 표식 */
  stamp: string;
}

/**
 * ThemesService — 빌드 없는 런타임 테마.
 * themes/<name>/ 의 템플릿 파일을 읽어 즉시 렌더한다. ZIP 업로드 = 즉시 적용.
 */
@Injectable()
export class ThemesService {
  private readonly logger = new Logger(ThemesService.name);
  private readonly themesDir = resolve(process.env.BRICK_THEMES_DIR ?? "themes");
  private failure: ThemeFailure | null = null;

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

  /**
   * 활성 테마의 매니페스트 (CSP 선언 등 테마 메타를 읽는 쪽이 쓴다).
   * 활성 테마를 못 읽으면 기본 테마 것을 준다 — 대체로 그리고 있는 화면과
   * 같은 테마의 선언이어야 한다(그러지 않으면 대체 테마의 폰트·스크립트가 CSP 에 막힌다).
   */
  async activeManifest(): Promise<ThemeManifest> {
    return (await this.resolveActive()).manifest;
  }

  /**
   * 지금 **실제로 그리는** 테마와 매니페스트.
   * render() 가 물러나는 것과 같은 순서를 따라야 색·에셋·CSP 가 화면과 어긋나지 않는다.
   */
  private async resolveActive(): Promise<{ name: string; manifest: ThemeManifest }> {
    const active = await this.activeThemeName();
    const manifest = await this.readManifest(active).catch(() => null);
    if (manifest) return { name: active, manifest };
    if (active !== FALLBACK_THEME) {
      const fb = await this.readManifest(FALLBACK_THEME).catch(() => null);
      if (fb) return { name: FALLBACK_THEME, manifest: fb };
    }
    throw new Error(`테마 "${active}" 를 읽을 수 없습니다`);
  }

  /**
   * 슬롯(layout/home/page/...)을 렌더해 완성된 HTML 반환.
   * `scope.__theme` 이 있으면 그 테마로 그린다 — 관리자 미리보기가 활성 테마를 건드리지 않고
   * "내 사이트가 이 테마로 어떻게 보이는지" 보기 위한 통로다(적용은 여전히 activate 뿐이다).
   *
   * **테마가 깨져도 사이트는 계속 나간다.** 활성 테마 → 기본 테마 → 내장
   * 레이아웃 순으로 물러난다. 테마는 디스크의 파일이라 볼륨이 안 붙거나
   * 경로가 어긋나거나(컨테이너에서 흔하다) 운영자가 JSON 을 고치다 쉼표를
   * 하나 더 찍으면 못 읽게 되는데, 그때 모든 공개 페이지가 500 이 되는 것은
   * 원인에 비해 너무 큰 결과다 — 글도 상품도 DB 에 멀쩡히 있다.
   */
  async render(slot: string, scope: Record<string, unknown>): Promise<string> {
    const override = typeof scope.__theme === "string" ? scope.__theme : null;
    /*
     * 미리보기는 대체하지 않는다. 관리자가 테마를 보려고 누른 것인데 조용히
     * 다른 테마를 보여주면 "적용했더니 화면이 다르다"가 된다 — 고장은 고장으로 보여준다.
     */
    if (override) {
      return this.renderWith(override, slot, scope).catch((err: unknown) => {
        throw new Error(`테마 "${override}": ${reasonOf(err)}`);
      });
    }

    const active = await this.activeThemeName();
    const candidates = active === FALLBACK_THEME ? [active] : [active, FALLBACK_THEME];
    let firstReason = "";
    for (const name of candidates) {
      try {
        const html = await this.renderWith(name, slot, scope);
        if (name === active) this.noteHealthy(active);
        else await this.noteFailure(active, firstReason, name);
        return html;
      } catch (err) {
        if (!firstReason) firstReason = reasonOf(err);
      }
    }
    await this.noteFailure(active, firstReason, "");
    return renderBuiltinLayout(scope);
  }

  /** 지정한 테마로 실제 렌더 — 실패는 호출자가 받는다 */
  private async renderWith(name: string, slot: string, scope: Record<string, unknown>): Promise<string> {
    const manifest = await this.readManifest(name);
    const tplPath = manifest.templates[slot] ?? manifest.templates.page;
    if (!tplPath) throw new Error(`no template for slot "${slot}"`);

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
   * 활성 테마가 깨졌다는 기록.
   *
   * 같은 실패로 로그를 매 요청 채우지 않는다 — 공개 페이지 핫패스다.
   * 상태는 이 프로세스에만 남긴다(DB 를 고치지 않는다): 파일을 되돌리면
   * 다음 렌더에 저절로 돌아오고, 운영자가 손댈 것은 테마 설정이 아니라 경로다.
   */
  private async noteFailure(theme: string, message: string, fallback: string): Promise<void> {
    const changed = this.failure?.theme !== theme || this.failure?.message !== message;
    this.failure = { theme, message, fallback, stamp: await this.activeStamp() };
    if (!changed) return;
    this.logger.error(
      `테마 "${theme}" 를 그릴 수 없습니다: ${message} — ` +
        (fallback ? `"${fallback}" 테마로 대신 그립니다.` : "내장 레이아웃으로 대신 그립니다."),
    );
  }

  private noteHealthy(theme: string): void {
    if (!this.failure) return;
    this.failure = null;
    this.logger.log(`테마 "${theme}" 를 다시 읽었습니다 — 대체 렌더를 멈춥니다.`);
  }

  /**
   * 지금 대체로 그리고 있는가 (대시보드·테마 목록이 읽는다). 정상이면 null.
   *
   * 렌더에서 잡은 것이 있으면 그것을 준다 — 템플릿 파일 한 장이 없는 경우처럼
   * 매니페스트만 봐서는 알 수 없는 고장이 거기 담겨 있다. 아직 아무도 공개
   * 페이지를 열지 않았으면 기록이 없으므로, 그때는 지금 확인한다 — 설치 직후
   * 볼륨이 안 붙은 서버에서 운영자가 가장 먼저 여는 곳이 관리 화면이다.
   */
  async problem(): Promise<ThemeFailure | null> {
    const active = await this.activeThemeName();
    /*
     * 기록이 아직 유효한지 먼저 본다. 운영자가 파일을 되돌려도 그 페이지가
     * 렌더 캐시에서 나가면 렌더가 일어나지 않아 기록을 지울 기회가 없다 —
     * 고쳤는데 경고가 남아 있으면 운영자는 더 고칠 곳을 찾아 헤맨다.
     * 스탬프(버전+파일 수정시각)가 그대로면 파일도 그대로다.
     */
    if (this.failure && (this.failure.theme !== active || this.failure.stamp !== (await this.activeStamp()))) {
      this.failure = null;
    }
    if (this.failure) return this.failure;
    const message = await this.readManifest(active).then(() => "", (e: unknown) => reasonOf(e));
    if (!message) return null;
    const hasFallback =
      active !== FALLBACK_THEME && (await this.readManifest(FALLBACK_THEME).then(() => true, () => false));
    return { theme: active, message, fallback: hasFallback ? FALLBACK_THEME : "", stamp: await this.activeStamp() };
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

  /**
   * 활성 테마의 스탬프 — 렌더 캐시 키에 섞는다.
   * 못 읽는 동안은 `@0` 이라 대체 렌더가 정상 렌더의 캐시를 덮지 않고,
   * 파일이 돌아오면 스탬프가 돌아와 캐시도 함께 돌아온다.
   */
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
    const resolved = await this.resolveActive().catch(() => null);
    if (!resolved) return { css: ":root { }", version: "0" };
    return {
      css: this.tokensToCss(resolved.manifest.tokens ?? {}),
      version: await this.assetVersion(resolved.name, resolved.manifest),
    };
  }

  private async readManifest(name: string): Promise<ThemeManifest> {
    const raw = await readFile(join(this.themesDir, name, "brick.theme.json"), "utf8");
    return JSON.parse(raw) as ThemeManifest;
  }
}

/**
 * 실패 이유 한 줄.
 *
 * 파일이 없을 때는 경로를 그대로 내보내지 않는다 — 테마 목록은 로그인 없이도
 * 읽히고, 서버의 실제 경로는 손님이 알 이유가 없다. 파싱 오류처럼 파일 안의
 * 문제는 그 메시지가 곧 고치는 법이라 그대로 전한다.
 */
function reasonOf(err: unknown): string {
  if ((err as { code?: string })?.code === "ENOENT") {
    return "테마 파일을 찾지 못했습니다 (설치 경로·볼륨을 확인하세요)";
  }
  return err instanceof Error ? err.message : String(err);
}
