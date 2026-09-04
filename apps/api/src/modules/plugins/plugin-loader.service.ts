import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { ModerationService } from "../moderation/moderation.service.js";
import { readFile, readdir, mkdir, symlink, stat, lstat, rm, readlink, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { installedPlugins, siteSettings } from "@brick/database";
import type { PluginManifest } from "@brick/shared";
import type { PluginContext, PluginInstance, BlockDefinition, PluginRouteHandler, PluginDb, AdminResource, HookBus, CacheProvider, QueueProvider, StorageProvider, MailProvider, CaptchaProvider, PersonalDataEraser, SitemapSource,
  SearchSource, LinkTargetSource, DashboardCard, HeaderAction, Locale, MessageCatalog } from "@brick/core";
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, makeTranslator, normalizeLocale } from "@brick/core";
import { DB, HOOKS, CACHE, QUEUE, STORAGE, MAIL, CAPTCHA, ENV } from "../../runtime.module.js";
import type { BrickEnv } from "../../config/env.js";
import { ImageService } from "../images/image.service.js";

/**
 * PluginLoader — Brick 런타임 아키텍처의 심장.
 *
 * 원칙:
 *  1. 모든 플러그인은 이 하나의 Node 프로세스 안에서 실행된다. (프로세스 분리 금지)
 *  2. 플러그인은 사전 빌드된 dist/index.js 로 배포된다. 서버는 절대 빌드하지 않는다.
 *  3. 활성화 시점에 플러그인의 migrations/*.sql 을 순서대로 적용한다.
 *  4. 비활성화하면 HookBus 등록/라우트/블록이 모두 제거된다.
 *
 * ZIP 설치 흐름:
 *  업로드 → 압축 해제(plugins/<name>/) → manifest 검증 → installed_plugins 기록
 *  → 활성화 → 마이그레이션 → dynamic import → activate(ctx)
 */
@Injectable()
export class PluginLoaderService implements OnModuleInit {
  private readonly logger = new Logger("PluginLoader");
  private readonly pluginsDir = resolve(process.env.BRICK_PLUGINS_DIR ?? "plugins");
  private instances = new Map<string, PluginInstance>();
  /** 플러그인이 등록한 라우트 테이블. ":param" 세그먼트를 지원한다 */
  readonly routes: Array<{
    plugin: string;
    method: string;
    segments: string[]; // "/api/plugins/<plugin>/boards/:slug/posts" → 분해된 세그먼트
    handler: PluginRouteHandler;
    /** API 문서용 설명 (선택 — 없어도 경로는 문서에 실린다) */
    docs?: { summary?: string };
  }> = [];

  /**
   * 디스패치: 메서드/경로를 라우트 테이블과 대조하고 :param을 추출한다.
   *
   * HEAD는 GET 라우트로 처리한다 — HTTP 표준이며, 이렇게 하지 않으면
   * `curl -I` 나 링크 검사 도구가 404를 받는다.
   */
  matchRoute(method: string, path: string): { handler: PluginRouteHandler; params: Record<string, string> } | null {
    const wanted = method === "HEAD" ? "GET" : method;
    const parts = path.split("/").filter(Boolean);

    /**
     * 구체적인 경로가 파라미터 경로보다 우선한다.
     *
     * 등록 순서대로 첫 매칭을 쓰면 "/:id" 가 먼저 등록된 경우 "/cost" 요청이
     * 그쪽으로 빨려 들어간다(실제로 발생). 플러그인 개발자가 등록 순서를
     * 신경 쓰게 하는 것은 함정이므로, 정적 세그먼트가 많은 쪽을 고른다.
     */
    let best: { handler: PluginRouteHandler; params: Record<string, string>; score: number } | null = null;

    for (const r of this.routes) {
      if (r.method !== wanted || r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      let score = 0;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg === parts[i]) {
          score += 1; // 정적 세그먼트가 일치할수록 구체적이다
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!best || score > best.score) best = { handler: r.handler, params, score };
    }

    return best ? { handler: best.handler, params: best.params } : null;
  }
  /** 페이지 빌더 블록 레지스트리 */
  readonly blocks = new Map<string, BlockDefinition>();
  readonly adminMenus: Array<{ plugin: string; label: string; path: string; icon?: string }> = [];
  /** 플러그인이 선언한 관리자 리소스 — 코어 관리자가 이걸로 CRUD 화면을 생성한다 */
  readonly adminResources: Array<AdminResource & { plugin: string }> = [];
  /**
   * 개인정보 삭제 처리기 — 회원 탈퇴 시 코어가 트랜잭션 안에서 부른다.
   * 코어가 플러그인 테이블 이름을 알지 않게 하려는 장치다 (ADR-38).
   */
  readonly dataErasers: Array<PersonalDataEraser & { plugin: string }> = [];
  /** 사이트맵 URL 공급자 — 코어는 페이지만 알고, 게시글·상품 주소는 플러그인이 안다 */
  readonly sitemapSources: Array<SitemapSource & { plugin: string }> = [];
  /** 통합검색 공급자 — 등록하지 않으면 그 플러그인의 내용은 검색되지 않는다 */
  readonly searchSources: Array<SearchSource & { plugin: string }> = [];
  /** 연결 대상 공급자 — 메뉴·팝업에서 주소를 직접 타이핑하지 않게 한다 */
  readonly linkTargets: Array<LinkTargetSource & { plugin: string }> = [];
  /** 대시보드 카드 — 관리자 첫 화면의 "오늘의 사이트" 숫자는 플러그인이 안다 */
  readonly dashboardCards: Array<DashboardCard & { plugin: string }> = [];
  /** 헤더 유틸 영역의 링크 — 테마가 그린다 (쇼핑몰 장바구니, 쪽지함 등) */
  readonly headerActions: Array<HeaderAction & { plugin: string }> = [];
  /**
   * 플러그인 간 서비스 레지스트리.
   * 훅으로 표현할 수 없는 협력(호출자 트랜잭션 참여 등)에 쓴다.
   */
  private readonly services = new Map<string, { plugin: string; impl: unknown }>();

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(HOOKS) private readonly hooks: HookBus,
    @Inject(CACHE) private readonly cache: CacheProvider,
    @Inject(QUEUE) private readonly queue: QueueProvider,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    @Inject(MAIL) private readonly mail: MailProvider,
    @Inject(CAPTCHA) private readonly captcha: CaptchaProvider,
    @Inject(ENV) private readonly env: BrickEnv,
    private readonly moderation: ModerationService,
    private readonly imageService: ImageService,
  ) {}

  /**
   * 부팅 시 active 플러그인 복원.
   * 파일이 사라진 플러그인(볼륨 미마운트, 수동 삭제 등)은 매 부팅 에러를 남기지 않고
   * 자동으로 비활성화한다 — 관리자가 화면에서 상황을 확인하고 재설치할 수 있다.
   */
  async onModuleInit(): Promise<void> {
    // 설정이 바뀌면 언어 캐시를 즉시 버린다 — 운영자가 언어를 바꿨는데
    // 10초 동안 옛 언어로 그리는 것은 "안 바뀌었다"로 보인다.
    this.hooks.onAction("site.settings_changed", "__core__", () => {
      this.localeCache = { ...this.localeCache, at: 0 };
    });

    const actives = await this.db.select().from(installedPlugins).where(eq(installedPlugins.isActive, true));
    for (const p of actives) {
      try {
        await this.activate(p.name, { skipMigrations: false });
      } catch (err) {
        const missing = (err as { code?: string })?.code === "ENOENT";
        await this.db.update(installedPlugins).set({ isActive: false }).where(eq(installedPlugins.name, p.name));
        if (missing) {
          this.logger.warn(`plugin "${p.name}" files are missing — deactivated. 재설치하거나 삭제하세요.`);
        } else {
          this.logger.error(`plugin "${p.name}" failed to activate on boot — deactivated`, err as Error);
        }
      }
    }
  }

  isActive(name: string): boolean {
    return this.instances.has(name);
  }

  async discover(): Promise<PluginManifest[]> {
    const entries = await readdir(this.pluginsDir, { withFileTypes: true }).catch(() => []);
    const manifests: PluginManifest[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifest = await this.readManifest(e.name).catch(() => null);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  async activate(name: string, opts = { skipMigrations: false }): Promise<void> {
    if (this.instances.has(name)) return;
    const manifest = await this.readManifest(name);

    // ZIP 으로 설치된 플러그인은 node_modules 가 없다 — 공유 의존성 링크를 보증한다
    await this.ensureSharedDependencies(name);

    // 다국어 — 플러그인 동봉 카탈로그(locales/*.json)와 현재 언어를 준비한다
    await this.loadPluginCatalogs(name);
    this.localeCache.at = 0; // 다음 refreshLocale 이 즉시 읽게
    await this.refreshLocale();

    if (!opts.skipMigrations && manifest.migrations) {
      await this.runPluginMigrations(name, join(this.pluginsDir, name, manifest.migrations));
    }

    const entryUrl = pathToFileURL(join(this.pluginsDir, name, manifest.entry)).href;
    // 캐시 무효화를 위한 버전 쿼리 (플러그인 업데이트 후 재활성화 대응)
    const mod = await import(`${entryUrl}?v=${encodeURIComponent(manifest.version)}`);
    const activate = mod.default as (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>;
    if (typeof activate !== "function") {
      throw new Error(`plugin "${name}": entry must default-export an activate function`);
    }

    const ctx = this.buildContext(name);
    const instance = (await activate(ctx)) ?? {};
    this.instances.set(name, instance);

    // upsert: ZIP 설치를 거치지 않은 개발용 플러그인도 재부팅 시 복원되도록.
    //
    // 단, **신뢰 필드(publisherKey·updates)는 DB 의 기존 값이 이긴다.**
    // 이 값들은 설치·업데이트 시점에 고정된 것이다(ADR-67/74) — 파일의
    // 매니페스트로 무조건 덮으면, 유효하게 서명된 ZIP 이 자기 매니페스트에
    // 다른 키를 적어 두는 것만으로 다음 업데이트의 검증 키를 갈아치운다.
    // 키 교체는 운영자의 직접 업로드로만 된다.
    const [prior] = await this.db
      .select().from(installedPlugins).where(eq(installedPlugins.name, name)).limit(1);
    const priorManifest = (prior?.manifest ?? {}) as Record<string, unknown>;
    const stored = {
      ...manifest,
      ...(priorManifest.publisherKey ? { publisherKey: priorManifest.publisherKey } : {}),
      ...(priorManifest.updates ? { updates: priorManifest.updates } : {}),
    };
    await this.db
      .insert(installedPlugins)
      .values({ name, version: manifest.version, manifest: stored as never, isActive: true, activatedAt: new Date() })
      .onConflictDoUpdate({
        target: installedPlugins.name,
        set: { version: manifest.version, manifest: stored as never, isActive: true, activatedAt: new Date() },
      });
    await this.hooks.doAction("plugin.activated", { name, version: manifest.version });
    await this.cache.invalidateTag("pages"); // 블록 구성이 바뀌었으므로 렌더 캐시 무효화
    this.logger.log(`plugin "${name}@${manifest.version}" activated`);
  }

  /**
   * 플러그인 재적재 — ZIP 업데이트 후 호출된다.
   * 새 버전의 마이그레이션이 자동 적용되고, 활성 상태가 유지된다.
   * (사용자는 "업로드"만 하면 되고 비활성화→활성화를 수동으로 오갈 필요가 없다)
   */
  async reload(name: string): Promise<void> {
    const wasActive = this.instances.has(name);
    if (wasActive) await this.deactivate(name);
    if (wasActive) await this.activate(name);
  }

  async deactivate(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (instance?.deactivate) await instance.deactivate().catch(() => undefined);
    this.instances.delete(name);
    this.hooks.removePlugin(name);
    for (let i = this.routes.length - 1; i >= 0; i--) {
      if (this.routes[i].plugin === name) this.routes.splice(i, 1);
    }
    for (const [blockName] of [...this.blocks]) {
      if (blockName.startsWith(`${name}/`)) this.blocks.delete(blockName);
    }
    for (let i = this.adminMenus.length - 1; i >= 0; i--) {
      if (this.adminMenus[i].plugin === name) this.adminMenus.splice(i, 1);
    }
    for (let i = this.adminResources.length - 1; i >= 0; i--) {
      if (this.adminResources[i].plugin === name) this.adminResources.splice(i, 1);
    }
    for (const [serviceName, entry] of [...this.services]) {
      if (entry.plugin === name) this.services.delete(serviceName);
    }
    await this.db.update(installedPlugins).set({ isActive: false }).where(eq(installedPlugins.name, name));
    await this.cache.invalidateTag("pages");
    // 비활성화된 플러그인의 eraser 는 부르지 않는다 — 테이블이 남아 있어도
    // 플러그인이 없으면 그 데이터를 해석할 방법이 없다.
    for (let i = this.dataErasers.length - 1; i >= 0; i--) {
      if (this.dataErasers[i].plugin === name) this.dataErasers.splice(i, 1);
    }
    for (let i = this.sitemapSources.length - 1; i >= 0; i--) {
      if (this.sitemapSources[i].plugin === name) this.sitemapSources.splice(i, 1);
    }
    for (let i = this.searchSources.length - 1; i >= 0; i--) {
      if (this.searchSources[i].plugin === name) this.searchSources.splice(i, 1);
    }
    for (let i = this.linkTargets.length - 1; i >= 0; i--) {
      if (this.linkTargets[i].plugin === name) this.linkTargets.splice(i, 1);
    }
    for (let i = this.dashboardCards.length - 1; i >= 0; i--) {
      if (this.dashboardCards[i].plugin === name) this.dashboardCards.splice(i, 1);
    }
    for (let i = this.headerActions.length - 1; i >= 0; i--) {
      if (this.headerActions[i].plugin === name) this.headerActions.splice(i, 1);
    }
    this.logger.log(`plugin "${name}" deactivated`);
  }

  // ── 다국어 ──────────────────────────────────────────
  /** 플러그인별 카탈로그 (locales/<locale>.json — 활성화 때 읽는다) */
  private readonly pluginCatalogs = new Map<string, Partial<Record<Locale, MessageCatalog>>>();
  /** 빠진 키는 한 번만 로그한다 — 렌더마다 찍히면 로그가 로그를 덮는다 */
  private readonly missingKeyLogged = new Set<string>();
  /**
   * 사이트 locale 캐시 (TTL 10초).
   *
   * ctx.t 는 동기여야 한다(블록 렌더·라우트 본문 어디서든 부른다) — 그래서
   * DB 를 직접 못 읽는다. 요청 처리 진입점(라우트 디스패치·페이지 렌더)이
   * refreshLocale() 을 부르고, t 는 캐시를 읽는다. 운영자가 언어를 바꾸면
   * 늦어도 10초 안에 플러그인 문자열이 따라온다.
   */
  private localeCache: { value: Locale; at: number } = { value: DEFAULT_LOCALE, at: 0 };

  /** 현재 사이트 언어 (캐시) — 코어 블록이 렌더 시점 번역에 쓴다 */
  get siteLocale(): Locale {
    return this.localeCache.value;
  }

  async refreshLocale(): Promise<void> {
    if (Date.now() - this.localeCache.at < 10_000) return;
    try {
      const { rows } = await this.db.execute(
        sql`SELECT value FROM site_settings WHERE key = 'site.locale' LIMIT 1`,
      );
      this.localeCache = { value: normalizeLocale(rows[0]?.value), at: Date.now() };
    } catch {
      this.localeCache = { ...this.localeCache, at: Date.now() };
    }
  }

  /**
   * 플러그인이 **선언**한 관리 라벨(AdminResource·관리 메뉴)의 서빙 시점 번역.
   *
   * 선언은 문자열이라 ctx.t 를 쓸 수 없다(활성화 한 번에 고정되면 언어 변경을
   * 못 따라간다). 대신 gettext 방식을 쓴다 — **원문(한국어)이 곧 카탈로그
   * 키**다. 플러그인은 locales/en.json 에 `"주문": "Orders"` 를 추가하면 되고,
   * 선언 코드는 한 줄도 바뀌지 않는다. 번역이 없으면 원문이 그대로 나간다 —
   * 자연 폴백이라 빠짐 로그는 내지 않는다(전 라벨이 원문키라 노이즈가 된다).
   */
  localizeAdminResource<T extends AdminResource>(plugin: string, resource: T): T {
    const locale = this.localeCache.value;
    if (locale === DEFAULT_LOCALE) return resource;
    const tr = <S extends string | undefined>(s: S): S =>
      (s !== undefined ? (this.trCatalog(plugin, s) as S) : s);
    return {
      ...resource,
      title: tr(resource.title),
      itemLabel: tr(resource.itemLabel),
      description: tr(resource.description),
      fields: resource.fields.map((f) => ({
        ...f,
        label: tr(f.label),
        help: tr((f as { help?: string }).help),
        placeholder: tr((f as { placeholder?: string }).placeholder),
        options: (f as { options?: Array<{ value: string; label: string }> }).options?.map(
          (o) => ({ ...o, label: tr(o.label) }),
        ),
      })),
      bulkActions: resource.bulkActions?.map((a) => ({
        ...a,
        label: tr(a.label),
        confirm: tr(a.confirm),
        input: a.input ? { ...a.input, label: tr(a.input.label) } : undefined,
      })),
    };
  }

  localizeAdminMenu<T extends { plugin: string; label: string }>(menu: T): T {
    if (this.localeCache.value === DEFAULT_LOCALE) return menu;
    return { ...menu, label: this.trCatalog(menu.plugin, menu.label) };
  }

  /** 선언 라벨(관리 리소스·메뉴·대시보드 카드)이 공유하는 gettext 치환 — 원문=키, 폴백=원문 */
  private trCatalog(plugin: string, text: string): string {
    const locale = this.localeCache.value;
    if (locale === DEFAULT_LOCALE) return text;
    return this.pluginCatalogs.get(plugin)?.[locale]?.[text] ?? text;
  }

  /**
   * 대시보드 카드 수집 — 정렬·제목 번역·실행·격리까지 여기서 끝낸다.
   * 레지스트리를 "쓸 수 있는 형태"로 만드는 지식이 HTTP 계층에 흩어지면
   * 두 번째 소비자가 생기는 순간 규칙(기본 order·번역)이 복제된다.
   *
   * 실패 격리는 시간 축에도 적용한다 — 느린 카드 하나가 관리자 첫 화면
   * 전체를 붙잡으면 안 되므로, 시간 초과는 그 카드만 오류로 표시한다.
   */
  /**
   * 테마 헤더에 그릴 링크 목록.
   *
   * 라벨은 관리 라벨과 같은 gettext 방식이다(원문이 번역 키). 값이 아니라
   * 선언이므로 요청마다 계산할 것이 없다 — 로그인 여부로 걸러 주기만 한다.
   * 사용자별 숫자(장바구니 개수)는 담지 않는다: 비로그인 렌더는 캐시되므로
   * 남의 값이 새어 나간다.
   */
  headerActionsFor(loggedIn: boolean): Array<{ label: string; url: string; icon: string | null }> {
    return this.headerActions
      .filter((a) => !a.requiresLogin || loggedIn)
      .slice()
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((a) => ({
        label: this.trCatalog(a.plugin, a.label),
        url: a.path,
        // 이름만 통과시킨다 — 템플릿이 href="#i-…" 에 넣으므로 식별자 문자만
        icon: a.icon && /^[a-z][a-z0-9-]{0,30}$/.test(a.icon) ? a.icon : null,
      }));
  }

  async collectDashboardCards(timeoutMs = 3000): Promise<
    Array<{ plugin: string; title: string; link: string | null; value: string | number | null; sub: string | null; error: boolean }>
  > {
    await this.refreshLocale();
    const sorted = this.dashboardCards.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return Promise.all(
      sorted.map(async (card) => {
        const base = {
          plugin: card.plugin,
          title: this.trCatalog(card.plugin, card.title),
          link: card.link ?? null,
        };
        try {
          const result = await Promise.race([
            card.load(),
            new Promise<never>((_, reject) => {
              const t = setTimeout(() => reject(new Error(`카드 시간 초과 (${timeoutMs}ms)`)), timeoutMs);
              t.unref?.();
            }),
          ]);
          return { ...base, value: result.value, sub: result.sub ?? null, error: false };
        } catch (err) {
          // 실패한 카드는 오류로 표시한다 — 0 으로 보이는 것이 최악이다
          this.logger.error(`dashboard card "${card.plugin}/${card.title}" 실패: ${String(err)}`);
          return { ...base, value: null, sub: null, error: true };
        }
      }),
    );
  }

  private async loadPluginCatalogs(name: string): Promise<void> {
    const dir = join(this.pluginsDir, name, "locales");
    const catalogs: Partial<Record<Locale, MessageCatalog>> = {};
    for (const locale of AVAILABLE_LOCALES) {
      try {
        const raw = await readFile(join(dir, `${locale}.json`), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        catalogs[locale] = Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string"),
        ) as MessageCatalog;
      } catch {
        // 그 언어의 카탈로그가 없다 — ko 폴백 규칙이 처리한다
      }
    }
    this.pluginCatalogs.set(name, catalogs);
  }

  private buildContext(pluginName: string): PluginContext {
    // 객체 리터럴의 게터 안에서 this 가 로더가 아니므로 별칭이 필요하다
    const loader = this;
    const settingsKey = (k: string) => `plugin:${pluginName}:${k}`;
    const translate = (key: string, params?: Record<string, string | number>): string => {
      const locale = this.localeCache.value;
      const t = makeTranslator({
        locale,
        catalogs: this.pluginCatalogs.get(pluginName) ?? {},
        onMissing: (k, l) => {
          const once = `${pluginName}:${l}:${k}`;
          if (this.missingKeyLogged.has(once)) return;
          this.missingKeyLogged.add(once);
          this.logger.warn(`[${pluginName}] 번역 없음: ${k} (${l})`);
        },
      });
      return t(key, params);
    };
    return {
      pluginName,
      get locale(): Locale {
        // 게터 — 요청 사이에 언어가 바뀌어도 항상 현재 값을 본다
        return loader.localeCache.value;
      },
      t: translate,
      hooks: this.hooks,
      cache: this.cache,
      queue: this.queue,
      storage: this.storage,
      mail: this.mail,
      captcha: this.captcha,
      logger: {
        log: (m: string) => this.logger.log(`[${pluginName}] ${m}`),
        warn: (m: string) => this.logger.warn(`[${pluginName}] ${m}`),
        error: (m: string) => this.logger.error(`[${pluginName}] ${m}`),
      },
      images: {
        canProcess: (contentType: string) => this.imageService.canProcess(contentType),
        optimize: (buffer, contentType, opts) => this.imageService.optimize(buffer, contentType, opts),
        thumbnail: (buffer, contentType, opts) => this.imageService.thumbnail(buffer, contentType, opts),
      },
      moderation: {
        findBannedWord: (text: string) => this.moderation.findBannedWord(text),
      },
      site: {
        url: this.env.siteUrl,
        // 매번 읽는다 — 운영자가 사이트 이름을 바꾸면 다음 메일부터 반영되어야 한다
        name: async () => {
          const { rows } = await this.db.execute(
            sql`SELECT value FROM site_settings WHERE key = 'site.name' LIMIT 1`,
          );
          const raw = rows[0]?.value;
          return typeof raw === "string" && raw.trim() ? raw.trim() : "Brick";
        },
      },
      // Drizzle 핸들은 execute/transaction을 모두 제공하므로 PluginDb 계약을 충족한다
      db: this.db as unknown as PluginDb,
      settings: {
        get: async <T>(key: string): Promise<T | null> => {
          const [row] = await this.db
            .select()
            .from(siteSettings)
            .where(eq(siteSettings.key, settingsKey(key)))
            .limit(1);
          return (row?.value as T) ?? null;
        },
        set: async <T>(key: string, value: T): Promise<void> => {
          await this.db
            .insert(siteSettings)
            .values({ key: settingsKey(key), value: value as never })
            .onConflictDoUpdate({ target: siteSettings.key, set: { value: value as never, updatedAt: new Date() } });
        },
      },
      registerRoute: (method, path, handler, docs) => {
        const clean = path.startsWith("/") ? path : `/${path}`;
        this.routes.push({
          plugin: pluginName,
          method,
          segments: `/api/plugins/${pluginName}${clean}`.split("/").filter(Boolean),
          handler,
          docs,
        });
      },
      registerBlock: (block) => {
        // 블록 이름은 "<plugin>/<block>" 네임스페이스 강제
        const full = block.name.startsWith(`${pluginName}/`) ? block.name : `${pluginName}/${block.name}`;
        this.blocks.set(full, { ...block, name: full });
      },
      registerAdminMenu: (item) => {
        this.adminMenus.push({ plugin: pluginName, ...item });
      },
      registerAdminResource: (resource) => {
        this.adminResources.push({ ...resource, plugin: pluginName });
      },
      provideService: (name, impl) => {
        const existing = this.services.get(name);
        if (existing && existing.plugin !== pluginName) {
          // 같은 이름을 두 플러그인이 제공하면 어느 쪽이 쓰일지 예측할 수 없다
          this.logger.warn(
            `서비스 "${name}" 을 "${existing.plugin}" 이 이미 제공하고 있습니다 — ` +
              `"${pluginName}" 의 등록으로 덮어씁니다.`,
          );
        }
        this.services.set(name, { plugin: pluginName, impl });
        this.logger.log(`plugin "${pluginName}" provides service "${name}"`);
      },
      useService: <T>(name: string): T | null => (this.services.get(name)?.impl as T) ?? null,
      registerDataEraser: (eraser) => {
        this.dataErasers.push({ ...eraser, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers data eraser "${eraser.label}"`);
      },
      registerSitemapSource: (source) => {
        this.sitemapSources.push({ ...source, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers sitemap source "${source.label}"`);
      },
      registerSearchSource: (source) => {
        this.searchSources.push({ ...source, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers search source "${source.label}"`);
      },
      registerLinkTarget: (source) => {
        this.linkTargets.push({ ...source, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers link target "${source.label}"`);
      },
      registerDashboardCard: (card) => {
        this.dashboardCards.push({ ...card, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers dashboard card "${card.title}"`);
      },
      registerHeaderAction: (action) => {
        this.headerActions.push({ ...action, plugin: pluginName });
        this.logger.log(`plugin "${pluginName}" registers header action "${action.label}"`);
      },
    };
  }

  /**
   * ZIP 으로 설치된 플러그인의 공유 의존성 해석을 보증한다.
   *
   * 왜 필요한가: ZIP 에는 node_modules 가 없다. 배포본은 모든 의존성이 루트
   * node_modules 에 있어 우연히 해석되지만, pnpm 모노레포(개발)에서는 루트에
   * 링크가 없어 `Cannot find package '@brick/plugin-sdk'` 로 활성화가 죽는다 —
   * create-brick-plugin 스모크가 잡았다. "배치에 따라 우연히 되는 것"은
   * 계약이 아니므로, 로더가 명시적으로 보증한다.
   *
   * 방법: 플러그인 폴더에서 해석해 보고, 실패한 패키지만 API 가 쓰는 사본으로
   * 심볼릭 링크를 만든다. **API 와 같은 사본을 가리키는 것이 목적이기도 하다** —
   * drizzle-orm 이 다른 사본이면 플러그인의 sql 객체를 서버가 알아보지 못한다.
   */
  private async ensureSharedDependencies(name: string): Promise<void> {
    // 플러그인이 import 해도 되는, Brick 이 함께 설치하는 패키지들.
    // @brick/core 는 plugin-sdk 가 re-export 하므로 함께 보증한다.
    const SHARED = ["@brick/plugin-sdk", "@brick/core", "drizzle-orm", "uuidv7"];

    const pluginDir = join(this.pluginsDir, name);

    // 이미 자기 node_modules 를 가진 플러그인(개발용 워크스페이스)은 건드리지 않는다.
    //
    // 주의: 이 존재 확인은 **일반 fs 로만** 한다. createRequire().resolve() 로
    // "해석되는지" 찔러보면 안 된다 — Node 24부터 모듈 해석기가 stat/파일 읽기
    // 결과를 캐시하므로, 실패를 한 번 캐시한 경로는 **링크를 만든 뒤에도 계속
    // 실패한다**. (Node 22 에서는 통과하고 24 에서만 죽는 형태로 나타났다)
    const hasOwn = await lstat(join(pluginDir, "node_modules")).then(() => true).catch(() => false);

    // 해석 기준점들: API 자신, 그리고 다른 플러그인들.
    // API 는 @brick/plugin-sdk 에 의존하지 않으므로 (플러그인의 계약이지 API 의
    // 것이 아니다) API 컨텍스트만으로는 sdk 를 못 찾는다 — 동봉 플러그인의
    // 컨텍스트가 폴백이다. (호스트 쪽 경로 해석은 긍정 결과만 캐시되므로 안전하다)
    const resolverBases = [import.meta.url];
    const siblings = await readdir(this.pluginsDir, { withFileTypes: true }).catch(() => []);
    for (const e of siblings) {
      if (e.isDirectory() && e.name !== name) {
        resolverBases.push(pathToFileURL(join(this.pluginsDir, e.name, "noop.js")).href);
      }
    }

    for (const pkg of SHARED) {
      const linkPath = join(pluginDir, "node_modules", ...pkg.split("/"));
      const linkStat = await lstat(linkPath).catch(() => null);
      if (linkStat) {
        // 있으면 존중한다 — 단, 깨진 링크(대상이 사라짐)는 다시 만든다
        const alive = await stat(linkPath).catch(() => null);
        if (alive) continue;
        await rm(linkPath, { recursive: true, force: true });
      } else if (hasOwn && !linkStat) {
        // 자기 node_modules 가 있는데 이 패키지만 없다 — pnpm 워크스페이스가
        // 관리하는 폴더에 우리가 끼어들면 다음 install 때 충돌한다. 워크스페이스
        // 플러그인은 자기 package.json 에 의존성을 선언하는 것이 맞다.
        continue;
      }

      let entry: string | null = null;
      for (const base of resolverBases) {
        try {
          entry = createRequire(base).resolve(pkg);
          break;
        } catch {
          // 다음 기준점
        }
      }
      if (!entry) {
        this.logger.warn(`plugin "${name}": 공유 의존성 "${pkg}" 를 호스트에서 찾지 못했습니다`);
        continue;
      }

      // 해석된 파일 → 패키지 루트: 가장 가까운, 이름이 일치하는 package.json 을 찾는다.
      // (경로 문자열 추측은 pnpm 의 .pnpm 레이아웃과 워크스페이스 링크 양쪽에서 깨진다)
      let root = dirname(entry);
      for (let i = 0; i < 10; i += 1) {
        try {
          const pkgJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
          if (pkgJson.name === pkg) break;
        } catch {
          // package.json 없음 — 위로
        }
        const parent = dirname(root);
        if (parent === root) break;
        root = parent;
      }

      try {
        await mkdir(dirname(linkPath), { recursive: true });
        await symlink(await realpath(root), linkPath, process.platform === "win32" ? "junction" : "dir");
        this.logger.log(`plugin "${name}": 공유 의존성 링크 ${pkg} → ${root.split(sep).slice(-3).join(sep)}`);
      } catch (err) {
        this.logger.warn(`plugin "${name}": ${pkg} 링크 실패 — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      // 링크를 만들었다고 끝이 아니다 — 링크 너머에 진짜 패키지가 있는지 확인한다.
      // 검증도 일반 fs 로 한다 (모듈 해석기를 부르면 캐시를 오염시킬 수 있다).
      const pkgJson = await stat(join(linkPath, "package.json")).then(() => true).catch(() => false);
      if (!pkgJson) {
        const target = await readlink(linkPath).catch(() => "(링크 아님)");
        this.logger.error(
          `plugin "${name}": ${pkg} 링크가 패키지를 가리키지 않습니다 — 대상=${target}`,
        );
      }
    }
  }

  private async readManifest(name: string): Promise<PluginManifest> {
    const raw = await readFile(join(this.pluginsDir, name, "brick.plugin.json"), "utf8");
    const manifest = JSON.parse(raw) as PluginManifest;
    if (!manifest.name || !manifest.entry) throw new Error(`invalid manifest for plugin "${name}"`);
    return manifest;
  }

  private async runPluginMigrations(pluginName: string, dir: string): Promise<void> {
    const files = (await readdir(dir).catch(() => []) as string[]).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const id = `${pluginName}:${file}`;
      const applied = await this.db.execute(
        // plugin_migrations 테이블로 멱등 보장
        (await import("drizzle-orm")).sql`SELECT 1 FROM plugin_migrations WHERE id = ${id} LIMIT 1`,
      );
      if ((applied as unknown as { rows: unknown[] }).rows?.length) continue;
      const sqlText = await readFile(join(dir, file), "utf8");
      const { sql } = await import("drizzle-orm");
      await this.db.execute(sql.raw(sqlText));
      await this.db.execute(sql`INSERT INTO plugin_migrations (id, plugin_name) VALUES (${id}, ${pluginName})`);
      this.logger.log(`migration applied: ${id}`);
    }
  }
}
