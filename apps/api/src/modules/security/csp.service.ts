import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { siteSettings, type BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { ThemesService } from "../themes/themes.service.js";

/** 정책에 실을 수 있는 지시어 — 테마·플러그인이 더할 수 있는 것만 */
export type CspDirective = "style-src" | "font-src" | "img-src" | "media-src" | "frame-src" | "connect-src";

export type CspMode = "on" | "report-only" | "off";

/** 출처 문자열 검사 — https 출처, 스킴, 잘 알려진 키워드만 받는다 */
const SOURCE_RE = /^(https:\/\/[a-z0-9.*-]+(:\d+)?(\/[\w./-]*)?|https:|data:|blob:|'self'|'none')$/i;

const DIRECTIVES: CspDirective[] = ["style-src", "font-src", "img-src", "media-src", "frame-src", "connect-src"];

/**
 * Content-Security-Policy — 저장형 XSS 의 두 번째 방어선.
 *
 * 게시판 본문은 손님이 쓰는 HTML 이다. 새니타이저(허용 목록)가 1차로 걷어내지만 그것은 우리가 짠
 * 정규식이고, 언젠가 우회가 나올 수 있다. 그때 브라우저가 한 번 더 막아 주는 것이 CSP 다.
 *
 * **인라인은 허용한다.** 테마의 화면 모드 스크립트와 토큰 `<style>`, 플러그인 블록의 `<style>` 이
 * 모두 인라인이다. 이것들에 nonce 를 붙이려면 렌더 캐시에 담긴 HTML 까지 매 응답 손봐야 하고,
 * 플러그인 전부를 고쳐야 한다 — 지금 얻을 수 있는 것에 비해 대가가 크다. 대신 **외부 스크립트를
 * 전면 차단**한다(`script-src 'self'`): 저장형 XSS 의 가장 흔한 형태가 `<script src="//evil">` 이고,
 * 그것이 막히면 공격자는 인라인만 남는데 그건 새니타이저가 지운다.
 *
 * 인라인과 무관하게 바로 이득인 것들도 함께 건다:
 *   object-src 'none'   — 플래시·PDF 임베드를 통한 실행
 *   base-uri 'self'     — `<base>` 하나로 페이지의 모든 상대 URL 이 공격자 서버로 간다
 *   form-action 'self'  — 로그인 폼의 action 을 바꿔 비밀번호를 가로채는 수법
 *   frame-ancestors     — 클릭재킹 (X-Frame-Options 의 현대판)
 *
 * 테마·플러그인은 매니페스트의 `csp` 로 자기가 쓰는 출처를 **선언**한다(웹폰트 CDN 등).
 * 선언하지 않은 곳은 막힌다 — 확장이 몰래 바깥과 통신하지 못한다는 뜻이기도 하다.
 *
 * 운영자는 `security.csp` 로 끄거나(`off`) 먼저 관찰만(`report-only`) 할 수 있다.
 * 손수 고친 테마에 외부 스크립트가 있다면 report-only 로 콘솔을 보고 옮긴 뒤 켜면 된다.
 */
@Injectable()
export class CspService {
  private cache: { at: number; header: string | null; mode: CspMode } | null = null;
  private readonly ttlMs = 60_000;
  /** 플러그인이 로더를 통해 선언한 출처 (플러그인 이름 → 지시어별 목록) */
  private readonly fromPlugins = new Map<string, Partial<Record<CspDirective, string[]>>>();

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly themes: ThemesService,
  ) {}

  /** 플러그인 로더가 활성화 시점에 부른다. 같은 이름으로 다시 부르면 덮어쓴다(재적재) */
  declare(pluginName: string, sources: Partial<Record<CspDirective, string[]>> | undefined): void {
    if (!sources) this.fromPlugins.delete(pluginName);
    else this.fromPlugins.set(pluginName, sources);
    this.invalidate();
  }

  invalidate(): void {
    this.cache = null;
  }

  /** 응답에 붙일 헤더 이름과 값. 꺼져 있으면 null */
  async header(): Promise<{ name: string; value: string } | null> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > this.ttlMs) {
      const mode = await this.mode();
      this.cache = { at: now, mode, header: mode === "off" ? null : await this.build() };
    }
    if (!this.cache.header) return null;
    return {
      name: this.cache.mode === "report-only" ? "content-security-policy-report-only" : "content-security-policy",
      value: this.cache.header,
    };
  }

  private async mode(): Promise<CspMode> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, "security.csp")).limit(1);
    const v = String(row?.value ?? "on");
    return v === "off" || v === "report-only" ? v : "on";
  }

  private async build(): Promise<string> {
    const extra = new Map<CspDirective, Set<string>>(DIRECTIVES.map((d) => [d, new Set<string>()]));
    const add = (sources: Partial<Record<CspDirective, string[]>> | undefined) => {
      for (const d of DIRECTIVES) {
        for (const raw of sources?.[d] ?? []) {
          const value = String(raw).trim();
          // 잘못 적힌 출처 하나가 정책 전체를 무너뜨리지 않게 조용히 버린다.
          // (http: 나 * 를 받아 주면 선언의 의미가 없다)
          if (SOURCE_RE.test(value)) extra.get(d)!.add(value);
        }
      }
    };

    const active = await this.themes.activeManifest().catch(() => null);
    add(active?.csp);
    for (const sources of this.fromPlugins.values()) add(sources);

    const join = (d: CspDirective, base: string[]) => [...base, ...extra.get(d)!].join(" ");
    return [
      "default-src 'self'",
      // 외부 스크립트 전면 차단. 인라인은 테마·플러그인이 쓰므로 허용한다(위 주석 참고)
      "script-src 'self' 'unsafe-inline'",
      `style-src ${join("style-src", ["'self'", "'unsafe-inline'"])}`,
      // 본문에 외부 이미지를 넣는 것은 정상 사용이다 — 이미지로는 스크립트가 실행되지 않는다
      `img-src ${join("img-src", ["'self'", "data:", "blob:", "https:"])}`,
      `font-src ${join("font-src", ["'self'", "data:"])}`,
      `connect-src ${join("connect-src", ["'self'"])}`,
      `media-src ${join("media-src", ["'self'", "data:", "blob:"])}`,
      `frame-src ${join("frame-src", ["'self'"])}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; ");
  }
}
