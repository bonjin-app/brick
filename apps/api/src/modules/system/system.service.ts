import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { siteSettings, type BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { BRICK_VERSION, compareVersions } from "../../config/version.js";

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string | null;
}

export interface VersionInfo {
  version: string;
  updateCheck: boolean;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

const RELEASES_API = "https://api.github.com/repos/bonjin-app/brick/releases/latest";
const RELEASES_LIST_API = "https://api.github.com/repos/bonjin-app/brick/releases?per_page=10";
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

/**
 * 코어 업데이트 알림.
 *
 * 워드프레스식 "관리 화면에서 버튼 하나로 코어 교체"는 만들지 않는다 — Node 는 모듈을
 * 메모리에 들고 있어 자기 자신을 부분 교체하다 실패하면 복구가 안 된다(architecture.md 의
 * 의도적 미구현). 대신 **알려 주기만** 한다: GitHub Releases 의 최신 태그를 6시간에 한 번
 * 확인해 대시보드에 띄우고, 실제 교체는 운영자가 프로세스 밖에서 한다(update.mjs · docker pull).
 *
 * 확인 요청은 관리자가 대시보드를 열 때만 나가고(백그라운드 폴링 없음), 설정
 * system.update_check=false 로 끌 수 있다 — 폐쇄망이나 외부 호출을 원치 않는 운영자를 위해.
 * 실패(네트워크·rate limit)는 조용히 error 로 담아 대시보드가 죽지 않는다.
 */
@Injectable()
export class SystemService {
  private readonly log = new Logger(SystemService.name);
  private cache: { at: number; latest: LatestRelease | null; error: string | null } | null = null;

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  get version(): string {
    return BRICK_VERSION;
  }

  async versionInfo(): Promise<VersionInfo> {
    const updateCheck = await this.updateCheckEnabled();
    if (!updateCheck) {
      return { version: BRICK_VERSION, updateCheck, latest: null, updateAvailable: false, checkedAt: null, error: null };
    }
    const { latest, error, at } = await this.latest();
    return {
      version: BRICK_VERSION,
      updateCheck,
      latest,
      updateAvailable: Boolean(latest && compareVersions(latest.version, BRICK_VERSION) > 0),
      checkedAt: new Date(at).toISOString(),
      error,
    };
  }

  /** 캐시를 비우고 다시 확인한다 (대시보드의 "다시 확인") */
  invalidate(): void {
    this.cache = null;
  }

  private async updateCheckEnabled(): Promise<boolean> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "system.update_check")).limit(1);
    return row?.value === undefined || row?.value === null ? true : row.value !== false;
  }

  private async latest(): Promise<{ latest: LatestRelease | null; error: string | null; at: number }> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = { accept: "application/vnd.github+json", "user-agent": `brick/${BRICK_VERSION}` };
      type Release = { tag_name?: string; html_url?: string; published_at?: string; draft?: boolean; prerelease?: boolean };
      let body: Release | undefined;
      const res = await fetch(RELEASES_API, { signal: controller.signal, headers });
      if (res.ok) body = (await res.json()) as Release;
      else if (res.status === 404) {
        // /releases/latest 는 프리릴리스를 제외한다 — 알파·베타만 있는 동안은 목록에서 첫 정식 릴리스를 고른다
        const list = await fetch(RELEASES_LIST_API, { signal: controller.signal, headers });
        if (!list.ok) throw new Error(`GitHub ${list.status}`);
        body = ((await list.json()) as Release[]).find((r) => !r.draft);
      } else throw new Error(`GitHub ${res.status}`);
      if (!body) throw new Error("no release");
      const version = String(body.tag_name ?? "").replace(/^v/, "");
      if (!version) throw new Error("no tag");
      this.cache = {
        at: Date.now(),
        latest: { version, url: String(body.html_url ?? "https://github.com/bonjin-app/brick/releases"), publishedAt: body.published_at ?? null },
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`업데이트 확인 실패: ${message}`);
      // 실패도 캐시한다 — 대시보드를 열 때마다 4초씩 기다리게 하지 않는다 (30분 뒤 재시도)
      this.cache = { at: Date.now() - CACHE_MS + 30 * 60 * 1000, latest: null, error: message };
    } finally {
      clearTimeout(timer);
    }
    return this.cache;
  }
}
