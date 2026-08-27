import {
  BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { siteSettings, users } from "@brick/database";
import { DB, ENV } from "../../runtime.module.js";
import type { BrickEnv } from "../../config/env.js";
import { OAUTH_PROVIDERS, providerDef, type OAuthProfile } from "./oauth.providers.js";

/** 관리자가 저장하는 공급자 설정 */
export interface OAuthProviderConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  /** 사내 SSO(oidc)만 사용 — 공급자 주소를 직접 지정한다 */
  authUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
}

const SETTINGS_KEY = "auth.oauth";
const STATE_TTL_MS = 10 * 60_000;

/**
 * 소셜 로그인.
 *
 * 흐름은 표준 Authorization Code 그대로다. 직접 구현한 이유는 의존성 하나를
 * 아끼려는 것이 아니라, passport 계열이 세션·미들웨어 모델을 강제하는데
 * Brick은 자체 세션을 쓰기 때문이다.
 *
 * 보안에서 특별히 신경 쓴 것:
 *
 *  - **state를 쿠키에 묶는다.** state를 서명만 하면 공격자가 자기 흐름에서 받은
 *    state를 남의 브라우저에 심어 자기 계정으로 로그인시킬 수 있다(로그인 CSRF).
 *    그래서 서명값을 쿠키에도 넣고 콜백에서 둘이 같은지 본다.
 *  - **검증된 이메일만 기존 계정에 붙인다.** 공급자가 이메일 소유를 확인하지
 *    않았다면, 남의 이메일을 적어둔 소셜 계정으로 그 사람의 Brick 계정을
 *    가져갈 수 있다.
 *  - **비밀번호 로그인을 막은 계정은 재설정 메일도 못 받는다.**
 *    (users.password_login_enabled — 재설정으로 비밀번호를 만들어 우회하는 길)
 */
@Injectable()
export class OAuthService {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(ENV) private readonly env: BrickEnv,
  ) {}

  /** 설정된 공급자 — 비밀키는 절대 밖으로 내보내지 않는다 */
  async publicProviders(): Promise<Array<{ name: string; label: string; color: string }>> {
    const config = await this.config();
    return Object.values(OAUTH_PROVIDERS)
      .filter((p) => config[p.name]?.enabled && config[p.name]?.clientId)
      .map((p) => ({ name: p.name, label: p.label, color: p.color }));
  }

  /** 관리 화면용 — clientSecret 은 설정 여부만 알려준다 */
  async adminProviders() {
    const config = await this.config();
    return Object.values(OAUTH_PROVIDERS).map((p) => ({
      name: p.name,
      label: p.label,
      enabled: config[p.name]?.enabled === true,
      clientId: config[p.name]?.clientId ?? "",
      hasSecret: Boolean(config[p.name]?.clientSecret),
      redirectUri: this.redirectUri(p.name),
      // 주소를 설정에서 받는 공급자만 화면에 입력란을 낸다
      needsUrls: !p.authUrl,
      authUrl: config[p.name]?.authUrl ?? "",
      tokenUrl: config[p.name]?.tokenUrl ?? "",
      profileUrl: config[p.name]?.profileUrl ?? "",
    }));
  }

  async saveProvider(name: string, input: Partial<OAuthProviderConfig>): Promise<void> {
    const def = providerDef(name);
    if (!def) throw new BadRequestException("지원하지 않는 공급자입니다.");

    const config = await this.config();
    const current = config[def.name] ?? { enabled: false, clientId: "", clientSecret: "" };
    // 비밀키를 빈 값으로 보내면 "변경하지 않음"으로 다룬다.
    // 관리 화면이 비밀키를 되읽을 수 없으므로, 저장 시 비면 지우는 동작이면
    // 다른 항목만 고쳐도 연동이 조용히 끊긴다.
    const next: OAuthProviderConfig = {
      enabled: input.enabled === true,
      clientId: String(input.clientId ?? current.clientId).trim().slice(0, 300),
      clientSecret: String(input.clientSecret ?? "").trim() || current.clientSecret,
    };
    if (next.enabled && (!next.clientId || !next.clientSecret)) {
      throw new BadRequestException("사용하려면 Client ID와 Client Secret이 모두 필요합니다.");
    }

    // 주소를 설정에서 받는 공급자(사내 SSO)
    if (!def.authUrl) {
      const url = (label: string, value: unknown, fallback: string | undefined) => {
        const v = String(value ?? fallback ?? "").trim();
        if (!v) return "";
        // 관리자가 넣는 값이지만 http(s)로 제한한다 — file:// 같은 스킴으로
        // 서버가 자기 파일을 읽어 오는 통로가 되지 않게 한다
        if (!/^https?:\/\//.test(v)) {
          throw new BadRequestException(`${label}은 http(s):// 로 시작해야 합니다.`);
        }
        return v.slice(0, 500);
      };
      next.authUrl = url("인증 주소", input.authUrl, current.authUrl);
      next.tokenUrl = url("토큰 주소", input.tokenUrl, current.tokenUrl);
      next.profileUrl = url("사용자 정보 주소", input.profileUrl, current.profileUrl);
      if (next.enabled && (!next.authUrl || !next.tokenUrl || !next.profileUrl)) {
        throw new BadRequestException("사내 SSO는 인증·토큰·사용자 정보 주소가 모두 필요합니다.");
      }
    }

    config[def.name] = next;
    await this.db
      .insert(siteSettings)
      .values({ key: SETTINGS_KEY, value: config as never })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: config as never, updatedAt: new Date() },
      });
  }

  /**
   * 인증 시작 — 공급자로 보낼 주소와 쿠키에 심을 state를 만든다.
   *
   * @param linkToUserId 값이 있으면 "연결" 흐름 (로그인한 사람이 소셜을 추가)
   */
  async authorize(
    name: string,
    params: { next: string; linkToUserId?: string | null },
  ): Promise<{ url: string; state: string }> {
    const def = providerDef(name);
    if (!def) throw new BadRequestException("지원하지 않는 공급자입니다.");
    const config = (await this.config())[def.name];
    if (!config?.enabled || !config.clientId) {
      throw new ServiceUnavailableException(`${def.label} 로그인이 설정되지 않았습니다.`);
    }

    const state = this.signState({
      p: def.name,
      n: randomBytes(12).toString("base64url"),
      t: Date.now(),
      // 로그인 후 돌아갈 경로. 열린 리다이렉트가 되지 않게 내부 경로만 허용한다
      r: safeNext(params.next),
      u: params.linkToUserId ?? null,
    });

    const url = new URL(def.authUrl || String(config.authUrl ?? ""));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri(def.name));
    url.searchParams.set("state", state);
    if (def.scope) url.searchParams.set("scope", def.scope);
    for (const [k, v] of Object.entries(def.extraAuthParams ?? {})) {
      url.searchParams.set(k, v);
    }
    return { url: url.toString(), state };
  }

  /**
   * 콜백 처리 — 코드를 프로필로 바꾸고, 회원을 찾거나 만든다.
   *
   * @returns 로그인시킬 회원 id와 돌아갈 경로
   */
  async callback(params: {
    provider: string;
    code: string;
    state: string;
    cookieState: string;
  }): Promise<{ userId: string; next: string; created: boolean }> {
    const def = providerDef(params.provider);
    if (!def) throw new BadRequestException("지원하지 않는 공급자입니다.");

    // state 검증 — 서명, 만료, 공급자 일치, 그리고 쿠키와의 동일성
    const claims = this.verifyState(params.state);
    if (claims.p !== def.name) throw new BadRequestException("요청이 올바르지 않습니다.");
    if (Date.now() - Number(claims.t) > STATE_TTL_MS) {
      throw new BadRequestException("로그인 요청이 만료되었습니다. 다시 시도해주세요.");
    }
    if (!params.cookieState || !constantEquals(params.cookieState, params.state)) {
      // 이 검사가 없으면 공격자가 자기 state를 남의 브라우저에 심어
      // 자기 소셜 계정으로 로그인시킬 수 있다 (로그인 CSRF)
      throw new BadRequestException("로그인 요청을 확인할 수 없습니다. 다시 시도해주세요.");
    }
    if (!params.code) throw new BadRequestException("인증 코드가 없습니다.");

    const config = (await this.config())[def.name];
    if (!config?.enabled) throw new ServiceUnavailableException("로그인이 설정되지 않았습니다.");

    const accessToken = await this.exchangeCode(def.tokenUrl || String(config.tokenUrl ?? ""), {
      grant_type: "authorization_code",
      code: params.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: this.redirectUri(def.name),
    });
    const profile = def.parseProfile(
      await this.fetchProfile(def.profileUrl || String(config.profileUrl ?? ""), accessToken),
    );
    if (!profile.uid) throw new BadRequestException("공급자에서 사용자 정보를 받지 못했습니다.");

    const next = safeNext(String(claims.r ?? "/"));
    const linkTo = claims.u ? String(claims.u) : null;
    if (linkTo) {
      await this.linkIdentity(linkTo, def.name, profile);
      return { userId: linkTo, next, created: false };
    }
    return { ...(await this.loginOrCreate(def.name, profile)), next };
  }

  /** 연결된 소셜 목록 (내 계정 화면) */
  async identitiesOf(userId: string) {
    const { rows } = await this.db.execute(sql`
      SELECT provider, email, display_name, created_at, last_login_at
      FROM user_identities WHERE user_id = ${userId}::uuid ORDER BY created_at
    `);
    return rows.map((r) => ({
      ...r,
      label: providerDef(String(r.provider))?.label ?? String(r.provider),
    }));
  }

  /**
   * 연결 해제.
   *
   * 마지막 로그인 수단을 지우면 계정에 들어갈 방법이 사라진다.
   * 비밀번호 로그인이 꺼져 있고 소셜이 하나뿐이면 거부한다.
   */
  async unlink(userId: string, provider: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new BadRequestException("회원을 찾을 수 없습니다.");

    const { rows } = await this.db.execute(sql`
      SELECT count(*) AS n FROM user_identities WHERE user_id = ${userId}::uuid
    `);
    const linked = Number(rows[0]?.n ?? 0);
    const passwordUsable = user.passwordLoginEnabled !== false;
    if (!passwordUsable && linked <= 1) {
      throw new ConflictException(
        "마지막 로그인 수단은 해제할 수 없습니다. 비밀번호를 먼저 설정해주세요.",
      );
    }

    const { rows: deleted } = await this.db.execute(sql`
      DELETE FROM user_identities
      WHERE user_id = ${userId}::uuid AND provider = ${provider}
      RETURNING id
    `);
    if (!deleted.length) throw new BadRequestException("연결된 계정이 아닙니다.");
  }

  // ── 내부 ────────────────────────────────────────────

  private async loginOrCreate(
    provider: string,
    profile: OAuthProfile,
  ): Promise<{ userId: string; created: boolean }> {
    // 1) 이미 연결된 신원 — 가장 흔한 경로
    const { rows: existing } = await this.db.execute(sql`
      SELECT user_id FROM user_identities
      WHERE provider = ${provider} AND provider_uid = ${profile.uid} LIMIT 1
    `);
    if (existing[0]) {
      const userId = String(existing[0].user_id);
      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user || !user.isActive) {
        throw new BadRequestException("정지된 계정입니다. 관리자에게 문의하세요.");
      }
      await this.db.execute(sql`
        UPDATE user_identities SET last_login_at = now(), email = ${profile.email},
               display_name = ${profile.displayName}
        WHERE provider = ${provider} AND provider_uid = ${profile.uid}
      `);
      return { userId, created: false };
    }

    // 2) 같은 이메일의 기존 계정에 붙이기 — **검증된 이메일만**
    if (profile.email && profile.emailVerified) {
      const email = profile.email.toLowerCase();
      const [found] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
      if (found) {
        if (!found.isActive) throw new BadRequestException("정지된 계정입니다.");
        await this.insertIdentity(found.id, provider, profile);
        return { userId: found.id, created: false };
      }
    } else if (profile.email && !profile.emailVerified) {
      // 검증되지 않은 이메일이 기존 계정과 겹치면 자동 연결하지 않는다.
      // 그대로 새 계정을 만들면 이메일 유니크 제약에 걸리므로, 먼저 로그인한 뒤
      // 연결하라고 안내한다.
      const email = profile.email.toLowerCase();
      const { rows: clash } = await this.db.execute(sql`
        SELECT id FROM users WHERE email = ${email} LIMIT 1
      `);
      if (clash.length) {
        throw new ConflictException(
          "이미 같은 이메일의 계정이 있습니다. 로그인한 뒤 내 정보에서 연결해주세요.",
        );
      }
    }

    // 3) 새 계정. 이메일이 없으면 공급자 uid로 내부 주소를 만든다
    //    (카카오는 이메일 동의가 선택이라 이메일 없는 가입이 실제로 생긴다)
    const email = profile.email?.toLowerCase() ?? `${provider}_${profile.uid}@social.invalid`;
    const userId = uuidv7();
    // 소셜 전용 계정에도 쓸 수 없는 무작위 비밀번호를 넣는다 — NULL을 허용하면
    // "비밀번호 없는 계정"이라는 상태가 인증 코드 전체에 퍼진다
    const unusable = await argon2.hash(randomBytes(32).toString("base64url"));

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email,
        passwordHash: unusable,
        displayName: (profile.displayName ?? "회원").slice(0, 100),
        role: "member",
        emailVerifiedAt: profile.emailVerified ? new Date() : null,
      });
      await tx.execute(sql`
        UPDATE users SET password_login_enabled = false WHERE id = ${userId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO user_identities (id, user_id, provider, provider_uid, email, display_name, last_login_at)
        VALUES (${uuidv7()}, ${userId}::uuid, ${provider}, ${profile.uid},
                ${profile.email}, ${profile.displayName}, now())
      `);
    });
    return { userId, created: true };
  }

  private async linkIdentity(userId: string, provider: string, profile: OAuthProfile): Promise<void> {
    const { rows } = await this.db.execute(sql`
      SELECT user_id FROM user_identities
      WHERE provider = ${provider} AND provider_uid = ${profile.uid} LIMIT 1
    `);
    if (rows[0]) {
      if (String(rows[0].user_id) === userId) return; // 이미 연결됨 — 조용히 성공
      throw new ConflictException("이 소셜 계정은 다른 회원에게 연결되어 있습니다.");
    }
    await this.insertIdentity(userId, provider, profile);
  }

  private async insertIdentity(userId: string, provider: string, profile: OAuthProfile): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO user_identities (id, user_id, provider, provider_uid, email, display_name, last_login_at)
        VALUES (${uuidv7()}, ${userId}::uuid, ${provider}, ${profile.uid},
                ${profile.email}, ${profile.displayName}, now())
      `);
    } catch (err) {
      if (String(err).includes("user_identities_user_provider_idx")) {
        throw new ConflictException("이미 같은 공급자를 연결하셨습니다.");
      }
      throw err;
    }
  }

  private async config(): Promise<Record<string, OAuthProviderConfig>> {
    const [row] = await this.db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, SETTINGS_KEY))
      .limit(1);
    return (row?.value as Record<string, OAuthProviderConfig>) ?? {};
  }

  redirectUri(provider: string): string {
    return `${this.env.siteUrl}/api/auth/oauth/${provider}/callback`;
  }

  /**
   * 코드 → 액세스 토큰.
   *
   * 응답을 JSON으로 못 읽는 경우가 있다(GitHub는 기본이 form-urlencoded).
   * Accept 헤더로 요청하되, 그래도 form이 오면 파싱한다.
   */
  private async exchangeCode(url: string, body: Record<string, string>): Promise<string> {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = Object.fromEntries(new URLSearchParams(text));
    }
    const token = data.access_token;
    if (!res.ok || !token) {
      // 공급자의 오류 문구를 그대로 사용자에게 보이지 않는다 —
      // client_secret 이 섞여 나오는 구현이 있다.
      throw new BadRequestException("소셜 로그인 인증에 실패했습니다. 다시 시도해주세요.");
    }
    return String(token);
  }

  private async fetchProfile(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const res = await fetchWithTimeout(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        // GitHub는 User-Agent가 없으면 403을 준다
        "user-agent": "brick-cms",
      },
    });
    if (!res.ok) throw new BadRequestException("사용자 정보를 가져오지 못했습니다.");
    return (await res.json()) as Record<string, unknown>;
  }

  /** state = base64url(JSON).서명 — 서버에 저장하지 않으므로 재시작에도 살아 있다 */
  private signState(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  private verifyState(state: string): Record<string, unknown> {
    const [payload, mac] = String(state ?? "").split(".");
    if (!payload || !mac) throw new BadRequestException("요청이 올바르지 않습니다.");
    if (!constantEquals(mac, this.mac(payload))) {
      throw new BadRequestException("요청이 위조되었습니다.");
    }
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("요청이 올바르지 않습니다.");
    }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.env.secret).update(`oauth:${payload}`).digest("base64url");
  }
}

/** 열린 리다이렉트 방어 — 내부 절대 경로만 허용한다 */
export function safeNext(value: unknown): string {
  const v = String(value ?? "").trim();
  // "//evil.com" 은 브라우저가 프로토콜 상대 URL로 읽어 외부로 나간다
  if (!v.startsWith("/") || v.startsWith("//")) return "/";
  if (v.includes("\\") || /[ -]/.test(v)) return "/";
  return v.slice(0, 500);
}

function constantEquals(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** 공급자가 응답하지 않을 때 요청이 매달려 있지 않게 한다 */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new BadRequestException(
      String(err).includes("abort")
        ? "소셜 로그인 서버가 응답하지 않습니다. 잠시 후 다시 시도해주세요."
        : "소셜 로그인 서버에 연결할 수 없습니다.",
    );
  } finally {
    clearTimeout(timer);
  }
}
