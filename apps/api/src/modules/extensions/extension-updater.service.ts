/**
 * 확장 원클릭 업데이트 — 서명 검증이 뿌리다.
 *
 * "원격에서 코드를 받아 설치하는" 기능은 서명 검증 없이 만들면 **원격 코드
 * 실행의 문**이 된다. 업데이트 서버가 뚫리거나, DNS 가 조작되거나, 관리자
 * 계정 하나가 새면 임의 코드가 들어온다 — 오래된 CMS 들이 실제로 겪은 사고
 * 유형이다.
 *
 * ── 신뢰 모델: 처음 설치할 때 키를 고정한다 (TOFU) ────
 *
 * 플러그인 매니페스트에 배포자의 Ed25519 공개키(`publisherKey`)가 들어 있고,
 * **처음 설치(운영자의 명시적 신뢰 행위)할 때 그 키가 고정된다.** 이후의
 * 원격 업데이트는:
 *
 *   1. 업데이트 매니페스트(JSON)를 https 로 받아서
 *   2. ZIP 을 내려받고
 *   3. **지금 설치된 매니페스트의 키**로 ZIP 서명을 검증한다
 *
 * 업데이트 매니페스트나 ZIP 안의 새 매니페스트가 주장하는 키는 검증에 쓰지
 * 않는다 — 그것을 믿으면 공격자가 자기 키를 함께 보내면 끝이다. 키 교체는
 * 운영자가 ZIP 을 직접 업로드하는 것(또 하나의 명시적 신뢰 행위)으로만 된다.
 *
 * ── 막아야 하는 것들 ─────────────────────────────────
 *
 *   - 다운그레이드: 낮은 버전을 "업데이트"로 제시해 알려진 취약점이 있는
 *     옛 버전을 되살리는 공격. 지금보다 높은 버전만 받는다.
 *   - http 주소: 평문이면 중간자가 매니페스트·ZIP 을 바꾼다. localhost 만
 *     예외다(테스트 — PG 스텁과 같은 규칙).
 *   - 무한 응답: 크기 상한과 시간 제한이 없으면 서버를 매달 수 있다.
 */
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, verify as edVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { installedPlugins, installedThemes } from "@brick/database";
import type { PluginManifest, ThemeManifest } from "@brick/shared";
import { DB } from "../../runtime.module.js";
import { ExtensionInstallerService } from "./extension-installer.service.js";

/** 업데이트 매니페스트 — 배포자가 서버에 올려 두는 JSON */
export interface UpdateManifest {
  name: string;
  version: string;
  /** ZIP 다운로드 주소 (https) */
  url: string;
  /** ZIP 의 sha256 (hex) — 서명 검증 전의 무결성·진단용 */
  sha256: string;
  /** ZIP 바이트에 대한 Ed25519 서명 (base64) */
  signature: string;
  /** 변경 요약 (화면에 보여준다) */
  notes?: string;
}

export interface AvailableUpdate {
  kind: "plugin" | "theme";
  name: string;
  displayName: string;
  currentVersion: string;
  nextVersion: string;
  notes: string | null;
}

/** 내려받기 상한 — 정상 확장이 이보다 클 이유가 없다 */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * 버전 비교 — semver 의 숫자 부분만 본다.
 *
 * 프리릴리스 규칙까지 구현하지 않는다: 확장 배포에서 "1.2.0-beta 다음이
 * 1.2.0" 같은 순서가 필요하면 배포자가 숫자를 올리면 된다. 규칙이 단순해야
 * 배포자가 실수하지 않는다.
 */
export function isNewerVersion(next: string, current: string): boolean {
  const parse = (v: string) =>
    String(v ?? "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(next);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 업데이트 주소 검증 — https 만, localhost 는 http 허용 (테스트).
 *
 * 평문 http 로 코드를 받으면 중간자가 내용을 바꾼다. 서명 검증이 있으니
 * 바뀐 ZIP 은 거부되지만, 매니페스트 단계에서 "업데이트 없음"으로 조작해
 * 보안 패치를 숨기는 것은 서명으로 못 막는다 — 전송 자체가 안전해야 한다.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(`잘못된 주소입니다: ${raw}`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocal) {
    throw new BadRequestException("업데이트 주소는 https 여야 합니다.");
  }
  return url;
}

@Injectable()
export class ExtensionUpdaterService {
  private readonly logger = new Logger("ExtensionUpdater");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly installer: ExtensionInstallerService,
  ) {}

  /**
   * 설치된 확장 중 업데이트가 있는 것을 찾는다.
   *
   * 한 확장의 확인 실패가 나머지를 막지 않는다 — 배포자 서버 하나가 죽었다고
   * 다른 확장의 보안 패치를 못 보면 안 된다.
   */
  async check(): Promise<{ items: AvailableUpdate[]; errors: string[] }> {
    const [plugins, themes] = await Promise.all([
      this.db.select().from(installedPlugins),
      this.db.select().from(installedThemes),
    ]);

    const items: AvailableUpdate[] = [];
    const errors: string[] = [];

    const rows: Array<{ kind: "plugin" | "theme"; name: string; version: string; manifest: PluginManifest | ThemeManifest }> = [
      ...plugins.map((p) => ({ kind: "plugin" as const, name: p.name, version: p.version, manifest: p.manifest as PluginManifest })),
      ...themes.map((t) => ({ kind: "theme" as const, name: t.name, version: t.version, manifest: t.manifest as ThemeManifest })),
    ];

    for (const row of rows) {
      const updatesUrl = row.manifest?.updates;
      if (!updatesUrl) continue; // 동봉 확장 등 — 원격 업데이트를 제공하지 않는다
      try {
        const remote = await this.fetchManifest(String(updatesUrl), row.name);
        if (isNewerVersion(remote.version, row.version)) {
          items.push({
            kind: row.kind,
            name: row.name,
            displayName: String((row.manifest as { displayName?: string }).displayName ?? row.name),
            currentVersion: row.version,
            nextVersion: remote.version,
            notes: remote.notes ?? null,
          });
        }
      } catch (err) {
        errors.push(`${row.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { items, errors };
  }

  /**
   * 업데이트 적용.
   *
   * 검증 순서가 중요하다: 버전 → sha256 → **고정된 키로 서명** → 설치.
   * 서명 검증을 통과하기 전에는 ZIP 의 어떤 내용도 신뢰하지 않는다.
   */
  async apply(kind: "plugin" | "theme", name: string): Promise<{
    name: string;
    from: string;
    to: string;
  }> {
    const row = kind === "plugin"
      ? (await this.db.select().from(installedPlugins).where(eq(installedPlugins.name, name)).limit(1))[0]
      : (await this.db.select().from(installedThemes).where(eq(installedThemes.name, name)).limit(1))[0];
    if (!row) throw new BadRequestException(`설치되어 있지 않습니다: ${name}`);

    const manifest = row.manifest as PluginManifest | ThemeManifest;
    const updatesUrl = manifest?.updates;
    if (!updatesUrl) throw new BadRequestException("이 확장은 원격 업데이트를 제공하지 않습니다.");

    // 고정된 키 — 처음 설치할 때의 매니페스트에서 온다.
    // 이것이 없으면 서명을 검증할 수 없으므로 원격 업데이트를 거부한다.
    const pinnedKey = String(manifest?.publisherKey ?? "");
    if (!pinnedKey) {
      throw new BadRequestException(
        "배포자 공개키가 없어 원격 업데이트를 할 수 없습니다. ZIP 을 직접 업로드해주세요.",
      );
    }

    const remote = await this.fetchManifest(String(updatesUrl), name);

    // 다운그레이드 거부 — 낮은 버전을 제시해 취약한 옛 버전을 되살리는 공격
    if (!isNewerVersion(remote.version, row.version)) {
      throw new BadRequestException(
        `새 버전이 아닙니다 (현재 ${row.version}, 제시된 ${remote.version}).`,
      );
    }

    const zip = await this.download(remote.url);

    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== String(remote.sha256 ?? "").toLowerCase()) {
      throw new BadRequestException("내려받은 파일이 매니페스트의 sha256 과 다릅니다.");
    }

    if (!this.verifySignature(zip, String(remote.signature ?? ""), pinnedKey)) {
      // 로그에 남긴다 — 서명 불일치는 공격 시도이거나 배포자의 키 분실이다.
      // 어느 쪽이든 운영자가 알아야 한다.
      this.logger.warn(`서명 검증 실패: ${name} (${remote.version}) — 고정된 키와 서명이 맞지 않습니다`);
      throw new BadRequestException(
        "서명 검증에 실패했습니다. 배포자 키가 바뀌었다면 새 ZIP 을 직접 업로드해야 합니다.",
      );
    }

    // 여기서부터 ZIP 을 신뢰한다. 기존 설치기 경로를 그대로 쓴다 —
    // zip-slip 방어와 매니페스트 검증을 두 번 구현하지 않는다.
    const result = kind === "plugin"
      ? await this.installer.installPlugin(zip)
      : await this.installer.installTheme(zip);

    if (result.name !== name) {
      // 설치기는 ZIP 안의 이름으로 설치한다. 이름이 다르면 다른 확장을
      // 그 자리에 심으려는 시도다 — 이미 설치는 됐으므로 명확히 알린다.
      throw new BadRequestException(
        `ZIP 안의 확장 이름(${result.name})이 요청한 이름(${name})과 다릅니다. 확인이 필요합니다.`,
      );
    }

    // 새 매니페스트가 키를 바꿔치기하지 못하게 고정된 키를 되살린다.
    // 키 교체는 운영자의 직접 업로드로만 된다.
    await this.repinKey(kind, name, pinnedKey);

    this.logger.log(`업데이트 적용: ${kind} ${name} ${row.version} → ${result.version}`);
    return { name, from: row.version, to: result.version };
  }

  private async repinKey(kind: "plugin" | "theme", name: string, pinnedKey: string): Promise<void> {
    const table = kind === "plugin" ? installedPlugins : installedThemes;
    const [row] = await this.db.select().from(table).where(eq(table.name, name)).limit(1);
    if (!row) return;
    const manifest = { ...(row.manifest as Record<string, unknown>), publisherKey: pinnedKey };
    await this.db.update(table).set({ manifest: manifest as never }).where(eq(table.name, name));
  }

  private verifySignature(zip: Buffer, signatureB64: string, publicKeyB64: string): boolean {
    try {
      const signature = Buffer.from(signatureB64, "base64");
      // Ed25519 raw 공개키(32바이트)를 SPKI DER 로 감싼다
      const raw = Buffer.from(publicKeyB64, "base64");
      if (raw.length !== 32) return false;
      const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
      const key = Buffer.concat([spkiPrefix, raw]);
      return edVerify(null, zip, { key, format: "der", type: "spki" }, signature);
    } catch {
      return false;
    }
  }

  private async fetchManifest(url: string, expectName: string): Promise<UpdateManifest> {
    const safe = assertSafeUrl(url);
    const res = await this.fetchWithLimit(safe, 1024 * 1024);
    let json: UpdateManifest;
    try {
      json = JSON.parse(res.toString("utf8")) as UpdateManifest;
    } catch {
      throw new BadRequestException("업데이트 매니페스트가 JSON 이 아닙니다.");
    }
    // 매니페스트의 이름이 다르면 다른 확장의 매니페스트를 물려받은 것이다
    if (String(json.name) !== expectName) {
      throw new BadRequestException(
        `업데이트 매니페스트의 이름(${json.name})이 확장(${expectName})과 다릅니다.`,
      );
    }
    if (!json.version || !json.url || !json.sha256 || !json.signature) {
      throw new BadRequestException("업데이트 매니페스트에 version/url/sha256/signature 가 필요합니다.");
    }
    return json;
  }

  private async download(url: string): Promise<Buffer> {
    const safe = assertSafeUrl(url);
    return this.fetchWithLimit(safe, MAX_DOWNLOAD_BYTES);
  }

  /** 크기 상한과 시간 제한을 지키며 받는다 — 없으면 악의적 서버가 우리를 매단다 */
  private async fetchWithLimit(url: URL, maxBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "error" });
      if (!res.ok) throw new BadRequestException(`받기 실패 (HTTP ${res.status}): ${url.pathname}`);

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new BadRequestException("응답 본문이 없습니다.");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new BadRequestException(`파일이 너무 큽니다 (${Math.round(maxBytes / 1024 / 1024)}MB 상한).`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new BadRequestException(
        aborted ? "받는 데 시간이 너무 걸립니다." : `받기 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
