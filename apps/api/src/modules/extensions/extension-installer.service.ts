import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import yauzl from "yauzl";
import type { BrickDb } from "@brick/database";
import { installedPlugins, installedThemes } from "@brick/database";
import type { PluginManifest, ThemeManifest } from "@brick/shared";
import { DB } from "../../runtime.module.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

/**
 * ZIP 업로드 설치 — WordPress의 plugin.zip UX.
 *
 * 흐름: ZIP 버퍼 → 엔트리 파싱 → manifest 검증 → zip-slip 방어 →
 *       plugins/<name>/ 또는 themes/<name>/ 에 전개 → DB 레지스트리 upsert.
 *
 * ZIP 안에 최상위 폴더가 있어도(my-plugin/brick.plugin.json) 없어도
 * (brick.plugin.json) 모두 허용한다 — manifest 위치로 루트를 판별한다.
 */
@Injectable()
export class ExtensionInstallerService {
  private readonly logger = new Logger("ExtensionInstaller");
  private readonly pluginsDir = resolve(process.env.BRICK_PLUGINS_DIR ?? "plugins");
  private readonly themesDir = resolve(process.env.BRICK_THEMES_DIR ?? "themes");

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  async installPlugin(zip: Buffer): Promise<{ name: string; version: string }> {
    const { manifest, files } = await this.extract<PluginManifest>(zip, "brick.plugin.json");
    if (!manifest.entry || !files.has(manifest.entry)) {
      throw new BadRequestException(`entry "${manifest.entry}" not found in zip`);
    }
    await this.writeFiles(join(this.pluginsDir, manifest.name), files);
    await this.db
      .insert(installedPlugins)
      .values({ name: manifest.name, version: manifest.version, manifest: manifest as never, isActive: false })
      .onConflictDoUpdate({
        target: installedPlugins.name,
        set: { version: manifest.version, manifest: manifest as never },
      });
    this.logger.log(`plugin "${manifest.name}@${manifest.version}" installed`);
    return { name: manifest.name, version: manifest.version };
  }

  async installTheme(zip: Buffer): Promise<{ name: string; version: string }> {
    const { manifest, files } = await this.extract<ThemeManifest>(zip, "brick.theme.json");
    if (!manifest.templates?.layout || !files.has(manifest.templates.layout)) {
      throw new BadRequestException("theme must include templates.layout");
    }
    await this.writeFiles(join(this.themesDir, manifest.name), files);
    await this.db
      .insert(installedThemes)
      .values({ name: manifest.name, version: manifest.version, manifest: manifest as never, isActive: false })
      .onConflictDoUpdate({
        target: installedThemes.name,
        set: { version: manifest.version, manifest: manifest as never },
      });
    this.logger.log(`theme "${manifest.name}@${manifest.version}" installed`);
    return { name: manifest.name, version: manifest.version };
  }

  /** ZIP 엔트리를 읽고 manifest 기준으로 루트 접두사를 제거해 반환 */
  private async extract<M extends { name: string; version: string }>(
    zip: Buffer,
    manifestFile: string,
  ): Promise<{ manifest: M; files: Map<string, Buffer> }> {
    const raw = await this.readZip(zip);

    // manifest 위치 탐색 (루트 또는 단일 폴더 아래)
    const candidates = [...raw.keys()].filter(
      (k) => k === manifestFile || (k.endsWith(`/${manifestFile}`) && k.split("/").length === 2),
    );
    if (candidates.length !== 1) {
      throw new BadRequestException(`zip must contain exactly one ${manifestFile} at root (found ${candidates.length})`);
    }
    const prefix = candidates[0] === manifestFile ? "" : candidates[0].slice(0, -manifestFile.length);

    let manifest: M;
    try {
      manifest = JSON.parse(raw.get(candidates[0])!.toString("utf8")) as M;
    } catch {
      throw new BadRequestException(`invalid ${manifestFile}: not valid JSON`);
    }
    if (!NAME_RE.test(manifest.name ?? "")) {
      throw new BadRequestException(`invalid extension name: "${manifest.name}" (lowercase/digits/hyphen only)`);
    }
    if (!manifest.version) throw new BadRequestException("manifest.version required");

    const files = new Map<string, Buffer>();
    for (const [key, buf] of raw) {
      if (prefix && !key.startsWith(prefix)) continue; // __MACOSX 등 루트 밖 잡파일 무시
      const rel = key.slice(prefix.length);
      if (!rel || rel.startsWith("__MACOSX") || rel.endsWith(".DS_Store")) continue;
      // zip-slip 방어
      const norm = normalize(rel);
      if (norm.startsWith("..") || norm.startsWith("/") || norm.includes("\0")) {
        throw new BadRequestException(`unsafe path in zip: ${key}`);
      }
      files.set(norm, buf);
    }
    return { manifest, files };
  }

  private async writeFiles(targetDir: string, files: Map<string, Buffer>): Promise<void> {
    // 재설치/업데이트: 기존 디렉터리를 통째로 교체
    await rm(targetDir, { recursive: true, force: true });
    for (const [rel, buf] of files) {
      const abs = join(targetDir, rel);
      if (!abs.startsWith(targetDir)) throw new BadRequestException(`unsafe path: ${rel}`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
    }
  }

  private readZip(buf: Buffer): Promise<Map<string, Buffer>> {
    return new Promise((resolvePromise, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error("invalid zip"));
        const files = new Map<string, Buffer>();
        zipfile.on("entry", (entry: yauzl.Entry) => {
          if (entry.fileName.endsWith("/")) return zipfile.readEntry(); // 디렉터리
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error("zip read error"));
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
              files.set(entry.fileName, Buffer.concat(chunks));
              zipfile.readEntry();
            });
            stream.on("error", reject);
          });
        });
        zipfile.on("end", () => resolvePromise(files));
        zipfile.on("error", reject);
        zipfile.readEntry();
      });
    });
  }
}
