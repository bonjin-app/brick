import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { installedPlugins, siteSettings } from "@brick/database";
import type { PluginManifest } from "@brick/shared";
import type { PluginContext, PluginInstance, BlockDefinition, PluginRouteHandler, PluginDb, AdminResource, HookBus, CacheProvider, QueueProvider, StorageProvider } from "@brick/core";
import { DB, HOOKS, CACHE, QUEUE, STORAGE } from "../../runtime.module.js";

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
  }> = [];

  /** 디스패치: 메서드/경로를 라우트 테이블과 대조하고 :param을 추출한다 */
  matchRoute(method: string, path: string): { handler: PluginRouteHandler; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
  /** 페이지 빌더 블록 레지스트리 */
  readonly blocks = new Map<string, BlockDefinition>();
  readonly adminMenus: Array<{ plugin: string; label: string; path: string; icon?: string }> = [];
  /** 플러그인이 선언한 관리자 리소스 — 코어 관리자가 이걸로 CRUD 화면을 생성한다 */
  readonly adminResources: Array<AdminResource & { plugin: string }> = [];

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(HOOKS) private readonly hooks: HookBus,
    @Inject(CACHE) private readonly cache: CacheProvider,
    @Inject(QUEUE) private readonly queue: QueueProvider,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /**
   * 부팅 시 active 플러그인 복원.
   * 파일이 사라진 플러그인(볼륨 미마운트, 수동 삭제 등)은 매 부팅 에러를 남기지 않고
   * 자동으로 비활성화한다 — 관리자가 화면에서 상황을 확인하고 재설치할 수 있다.
   */
  async onModuleInit(): Promise<void> {
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

    // upsert: ZIP 설치를 거치지 않은 개발용 플러그인도 재부팅 시 복원되도록
    await this.db
      .insert(installedPlugins)
      .values({ name, version: manifest.version, manifest: manifest as never, isActive: true, activatedAt: new Date() })
      .onConflictDoUpdate({
        target: installedPlugins.name,
        set: { version: manifest.version, manifest: manifest as never, isActive: true, activatedAt: new Date() },
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
    await this.db.update(installedPlugins).set({ isActive: false }).where(eq(installedPlugins.name, name));
    await this.cache.invalidateTag("pages");
    this.logger.log(`plugin "${name}" deactivated`);
  }

  private buildContext(pluginName: string): PluginContext {
    const settingsKey = (k: string) => `plugin:${pluginName}:${k}`;
    return {
      pluginName,
      hooks: this.hooks,
      cache: this.cache,
      queue: this.queue,
      storage: this.storage,
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
      registerRoute: (method, path, handler) => {
        const clean = path.startsWith("/") ? path : `/${path}`;
        this.routes.push({
          plugin: pluginName,
          method,
          segments: `/api/plugins/${pluginName}${clean}`.split("/").filter(Boolean),
          handler,
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
    };
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
