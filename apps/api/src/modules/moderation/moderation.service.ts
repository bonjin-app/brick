import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { siteSettings } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { ipAllowed } from "../auth/ip-allowlist.js";

/**
 * 모더레이션 — 금지 단어 · 가입 금지 이름/도메인 · 접속 차단 IP.
 *
 * 그누보드의 기본 설정(cf_filter · cf_prohibit_id · cf_prohibit_email · cf_intercept_ip)에
 * 해당한다. 커뮤니티를 운영하면 첫 주에 필요해지는 것들이다 — 욕설이 올라오고,
 * "관리자"라는 닉네임이 생기고, 한 IP 가 도배한다.
 *
 * 설정은 5초 메모한다. 글·댓글·가입마다 부르는 핫패스이고, 5초면 운영자가 저장한 뒤
 * 다음 글부터 반영된다. 목록은 줄바꿈/쉼표로 나눈다 — 운영자가 한 줄에 하나씩 적는
 * 것이 자연스럽고, 쉼표도 받아서 실수를 막는다.
 */
export const MODERATION_KEYS = {
  bannedWords: "moderation.banned_words",
  deniedNames: "moderation.denied_names",
  deniedEmailDomains: "moderation.denied_email_domains",
  blockedIps: "security.blocked_ips",
} as const;

/** 닉네임으로 쓸 수 없는 기본 이름 — 운영진을 사칭하는 것들. 설정으로 늘릴 수 있다 */
const DEFAULT_DENIED_NAMES = ["admin", "administrator", "root", "system", "관리자", "운영자", "운영팀", "고객센터", "시스템"];

export const splitList = (raw: unknown): string[] =>
  String(raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

@Injectable()
export class ModerationService {
  private cache: { at: number; value: Record<string, string> } | null = null;

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  private async settings(): Promise<Record<string, string>> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.value;
    const rows = await this.db
      .select()
      .from(siteSettings)
      .where(inArray(siteSettings.key, Object.values(MODERATION_KEYS)));
    const value: Record<string, string> = {};
    for (const r of rows) if (typeof r.value === "string") value[r.key] = r.value;
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** 시험·설정 저장 직후 즉시 반영이 필요할 때 */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * 본문에 금지 단어가 있으면 그 단어를 돌려준다(없으면 null).
   * 대소문자를 무시하고 부분 일치로 본다 — "바보"를 막으면 "바보야"도 막힌다.
   * HTML 은 태그를 벗기고 본다(태그 사이에 끼워 넣는 우회를 막는다).
   */
  async findBannedWord(text: string): Promise<string | null> {
    const words = splitList((await this.settings())[MODERATION_KEYS.bannedWords]);
    if (!words.length) return null;
    // 태그는 빈 문자열로 지운다(공백이 아니라). "바<b></b>보"가 "바 보"가 되면 필터가
    // 두 글자 사이의 태그 하나로 무력화된다 — 그누보드 필터도 태그를 벗긴 붙은 글자로 본다
    const plain = String(text ?? "").replace(/<[^>]*>/g, "").toLowerCase();
    return words.find((w) => plain.includes(w.toLowerCase())) ?? null;
  }

  /**
   * 표시 이름 검사 — 금지 이름(정확히 일치, 공백·대소문자 무시)과 금지 단어(포함).
   * 통과하지 못하면 사람이 읽을 사유를 돌려준다.
   */
  async nameProblem(name: string): Promise<string | null> {
    const s = await this.settings();
    const norm = String(name ?? "").replace(/\s+/g, "").toLowerCase();
    const denied = [...DEFAULT_DENIED_NAMES, ...splitList(s[MODERATION_KEYS.deniedNames])]
      .map((n) => n.replace(/\s+/g, "").toLowerCase());
    if (denied.includes(norm)) return "사용할 수 없는 이름입니다.";
    const hit = await this.findBannedWord(name);
    return hit ? `이름에 사용할 수 없는 단어가 있습니다: ${hit}` : null;
  }

  /** 가입 금지 이메일 도메인 (예: 일회용 메일) */
  async emailProblem(email: string): Promise<string | null> {
    const domains = splitList((await this.settings())[MODERATION_KEYS.deniedEmailDomains]).map((d) => d.toLowerCase().replace(/^@/, ""));
    if (!domains.length) return null;
    const domain = String(email ?? "").toLowerCase().split("@")[1] ?? "";
    return domains.some((d) => domain === d || domain.endsWith(`.${d}`)) ? "이 이메일 도메인으로는 가입할 수 없습니다." : null;
  }

  /** 접속 차단 IP — 관리자 허용목록과 같은 문법(IPv4·CIDR·IPv6) */
  async isBlockedIp(ip: string): Promise<boolean> {
    const list = (await this.settings())[MODERATION_KEYS.blockedIps];
    if (!list || !list.trim()) return false;
    return ipAllowed(ip, list);
  }
}
