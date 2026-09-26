import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { siteSettings, type BrickDb } from "@brick/database";
import { SITE_TZ, isAdultByBirthYear, type IdentityProvider, type IdentityStatus } from "@brick/core";
import { DB, ENV } from "../../runtime.module.js";
import type { BrickEnv } from "../../config/env.js";

/** 인증창을 열고 돌아오기까지 기다리는 시간 — 넘으면 새로 시작해야 한다 */
const REQUEST_TTL_MINUTES = 30;

/** 한 사람 한 계정 설정 키 */
export const ONE_PERSON_KEY = "member.one_person_one_account";
/** 회원 본인인증 필수 설정 키 */
export const REQUIRED_KEY = "member.identity_required";
/** 가입 전 본인인증 설정 키 */
export const SIGNUP_KEY = "member.identity_at_signup";
/** 가입 전 인증을 이 브라우저에 묶는 쿠키 — 서버가 만든 비밀값이고 스크립트는 읽지 못한다 */
export const SIGNUP_COOKIE = "brick_idv";

/** 요청의 가입 전 인증 쿠키 — 모양이 틀리면 없는 것으로 */
export function signupCookie(req: { cookies?: unknown }): string {
  const v = (req.cookies as Record<string, string> | undefined)?.[SIGNUP_COOKIE] ?? "";
  return /^[A-Za-z0-9_-]{40,60}$/.test(v) ? v : "";
}

/**
 * 만 나이 — 한국 시간의 오늘 기준. 생일이 지나야 한 살을 더한다.
 *
 * 성인 판정(청소년보호법)은 연 나이를 쓰지만, **만 14세 미만 가입 제한**(개인정보보호법 제22조의2 —
 * 법정대리인 동의가 필요하다)은 만 나이다. 가입 전 인증에서 한 번 판정하고 생년월일은 버린다.
 */
export function manAge(birthDate: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("-").map(Number);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today[0] - y;
  if (today[1] < mo || (today[1] === mo && today[2] < d)) age -= 1;
  return age;
}

/**
 * 끝나고 돌아갈 곳 — **사이트 안 경로만** 받는다.
 *
 * `//evil.com`·`/\\evil.com` 은 브라우저가 다른 사이트로 읽는다. 인증을 마친 손님을
 * 그대로 공격자 사이트로 넘기는 링크를 만들 수 있게 되므로, 통과하지 못하면 버린다.
 */
export function safeNext(next: unknown): string {
  const v = String(next ?? "").trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\x00-\x1f\x7f]/.test(v)) return "";
  if (v.length > 500) return "";
  return v;
}

/** 인증 화면 주소 (돌아올 곳을 붙여서) */
export function identityUrl(next?: string): string {
  const back = safeNext(next);
  return back ? `/identity?next=${encodeURIComponent(back)}` : "/identity";
}

export type CompleteResult =
  | { ok: true; status: IdentityStatus }
  | { ok: false; status: number; message: string };

/**
 * 본인인증 — 공급자 등록부와 결과 저장.
 *
 * 공급자(포트원 등)는 플러그인이 등록한다. 결과는 코어가 가진다 — 쇼핑몰의 성인 상품과
 * 게시판의 성인 게시판이 **같은 확인**을 봐야 하기 때문이다.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly providers = new Map<string, { plugin: string; provider: IdentityProvider }>();

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(ENV) private readonly env: BrickEnv,
  ) {}

  setProvider(plugin: string, provider: IdentityProvider): void {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider.name)) {
      this.logger.warn(`plugin "${plugin}" 의 본인인증 공급자 이름 "${provider.name}" 이 올바르지 않아 무시합니다`);
      return;
    }
    this.providers.set(provider.name, { plugin, provider });
  }

  /** 꺼진 플러그인의 공급자를 치운다 — 꺼진 확장이 인증 요금을 계속 쓰면 안 된다 */
  clearProviders(plugin: string): void {
    for (const [name, entry] of this.providers) if (entry.plugin === plugin) this.providers.delete(name);
  }

  /**
   * 지금 인증을 받을 수 있는 공급자들 (설정이 끝난 것만). 등록한 플러그인을 함께 준다 —
   * 표시 이름은 그 플러그인의 카탈로그로 번역한다(사이트 언어가 바뀌어도 따라가게).
   */
  async readyProviders(): Promise<Array<{ plugin: string; provider: IdentityProvider }>> {
    const out: Array<{ plugin: string; provider: IdentityProvider }> = [];
    for (const { plugin, provider } of this.providers.values()) {
      try {
        if (await provider.isReady()) out.push({ plugin, provider });
      } catch (err) {
        // 한 공급자의 설정 오류가 인증 화면 전체를 죽이지 않게
        this.logger.warn(`본인인증 공급자 "${provider.name}" (${plugin}) 준비 확인 실패: ${String(err)}`);
      }
    }
    return out;
  }

  /**
   * 회원에게 본인인증을 요구하는가 — 설정이 켜져 있고 **인증 수단이 준비돼 있을 때만.**
   * 수단이 없는데 요구하면 아무도 인증할 수 없어 모든 회원이 잠긴다.
   */
  async isRequired(): Promise<boolean> {
    /*
     * 가입 전 본인인증도 여기에 든다. 가입 화면만 막으면 **소셜 로그인으로 가입하는 길**(과 설정을 켜기 전에
     * 가입한 회원)이 인증 없이 남는다 — 그런 회원은 인증하기 전까지 쓰기가 막히고 로그인하면 인증 화면으로 간다.
     */
    const on = (await this.setting<boolean>(REQUIRED_KEY)) === true || (await this.setting<boolean>(SIGNUP_KEY)) === true;
    if (!on) return false;
    return (await this.readyProviders()).length > 0;
  }

  /** 사이트 설정 셋 — 관리자 → 본인인증 화면이 그대로 보여 준다(수단이 없어 강제하지 않는 것도 함께 보이게 원래 값) */
  async policySettings(): Promise<{ required: boolean; signup: boolean; onePerson: boolean }> {
    return {
      required: (await this.setting<boolean>(REQUIRED_KEY)) === true,
      signup: (await this.setting<boolean>(SIGNUP_KEY)) === true,
      onePerson: (await this.setting<boolean>(ONE_PERSON_KEY)) === true,
    };
  }

  /**
   * 최근 사용량 — 본인인증은 건당 요금이 나간다. 요청(인증창을 연 수)·성공·실패·끝나지 않음, 회원/손님(가입 전)으로
   * 나누고 날마다 센다. 날짜는 사이트 시간대로 자른다(판매 리포트와 같은 기준).
   *
   * 요청 기록은 30일, **가입하지 않은 손님의 인증은 하루** 뒤에 지워진다(사람 해시를 계정 없이 오래 두지 않는다) —
   * 그래서 그런 인증은 이 집계에서 빠진다. 화면이 그 사실을 함께 말한다.
   */
  async usage(days = 30): Promise<{
    days: number; requests: number; verified: number; failed: number; open: number;
    member: number; guest: number; certified: number;
    daily: Array<{ date: string; requests: number; verified: number }>;
  }> {
    const n = Math.min(90, Math.max(1, Math.floor(days)));
    const tz = SITE_TZ;
    const { rows: [sum] } = (await this.db.execute(sql`
      SELECT count(*)::int AS requests,
             count(*) FILTER (WHERE status = 'verified')::int AS verified,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             count(*) FILTER (WHERE status = 'pending')::int AS open,
             count(*) FILTER (WHERE guest_hash IS NULL)::int AS member,
             count(*) FILTER (WHERE guest_hash IS NOT NULL)::int AS guest
      FROM identity_verifications WHERE created_at > now() - make_interval(days => ${n})
    `)) as unknown as { rows: Array<Record<string, number>> };
    const { rows: daily } = (await this.db.execute(sql`
      SELECT to_char((created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
             count(*)::int AS requests, count(*) FILTER (WHERE status = 'verified')::int AS verified
      FROM identity_verifications WHERE created_at > now() - make_interval(days => ${n})
      GROUP BY 1 ORDER BY 1 DESC
    `)) as unknown as { rows: Array<{ date: string; requests: number; verified: number }> };
    const { rows: [cert] } = (await this.db.execute(sql`
      SELECT count(*)::int AS n FROM user_certifications
    `)) as unknown as { rows: Array<{ n: number }> };
    return {
      days: n,
      requests: Number(sum?.requests ?? 0), verified: Number(sum?.verified ?? 0),
      failed: Number(sum?.failed ?? 0), open: Number(sum?.open ?? 0),
      member: Number(sum?.member ?? 0), guest: Number(sum?.guest ?? 0),
      certified: Number(cert?.n ?? 0),
      daily: daily.map((d) => ({ date: String(d.date), requests: Number(d.requests), verified: Number(d.verified) })),
    };
  }

  /** 가입할 때 본인인증을 요구하는가 — 역시 인증 수단이 준비돼 있을 때만(없으면 아무도 가입할 수 없다) */
  async signupRequired(): Promise<boolean> {
    if ((await this.setting<boolean>(SIGNUP_KEY)) !== true) return false;
    return (await this.readyProviders()).length > 0;
  }

  async status(userId: string): Promise<IdentityStatus> {
    const { rows } = (await this.db.execute(sql`
      SELECT birth_year, verified_at FROM user_certifications WHERE user_id = ${userId}::uuid
    `)) as unknown as { rows: Array<{ birth_year: number; verified_at: string | Date }> };
    const row = rows[0];
    if (!row) return { verified: false, adult: false, verifiedAt: null };
    return {
      verified: true,
      adult: isAdultByBirthYear(Number(row.birth_year)),
      verifiedAt: new Date(row.verified_at),
    };
  }

  /**
   * 인증 요청을 연다 — **ID 는 서버가 만들고 회원에게 묶는다.**
   *
   * 브라우저가 ID 를 정하게 하면, 다른 사람이 자기 계정에서 끝낸 인증(또는 공급자 콘솔에서
   * 본 남의 인증 ID)을 들고 와 내 계정에 붙일 수 있다. 영문·숫자만 쓴다 — KCP 가 그것만 받는다.
   */
  async start(userId: string, providerName: string): Promise<{ ok: true; requestId: string } | { ok: false; message: string }> {
    const entry = this.providers.get(providerName);
    if (!entry || !(await entry.provider.isReady().catch(() => false))) {
      return { ok: false, message: "사용할 수 없는 본인인증 수단입니다." };
    }
    const requestId = `bid${randomBytes(16).toString("hex")}`;
    await this.db.execute(sql`
      INSERT INTO identity_verifications (user_id, provider, request_id)
      VALUES (${userId}::uuid, ${providerName}, ${requestId})
    `);
    return { ok: true, requestId };
  }

  /**
   * 돌아온 인증을 확인하고 결과를 저장한다.
   *
   * 공급자에게 **직접** 묻는다 — 화면이 보낸 이름·생년월일은 받지도 않는다.
   */
  async complete(userId: string, requestId: string): Promise<CompleteResult> {
    if (!/^[A-Za-z0-9]{1,40}$/.test(requestId)) {
      return { ok: false, status: 400, message: "인증 요청을 찾을 수 없습니다." };
    }
    const { rows } = (await this.db.execute(sql`
      SELECT user_id, provider, status, created_at > now() - make_interval(mins => ${REQUEST_TTL_MINUTES}) AS fresh
      FROM identity_verifications WHERE request_id = ${requestId}
    `)) as unknown as { rows: Array<{ user_id: string; provider: string; status: string; fresh: boolean }> };
    const row = rows[0];
    // 남의 요청과 없는 요청을 같은 말로 — 어느 ID 가 있는지 알려 줄 이유가 없다
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, message: "인증 요청을 찾을 수 없습니다." };
    }
    // 이미 반영된 요청을 다시 보내면(돌아온 화면을 새로고침) 지금 상태를 돌려준다
    if (row.status === "verified") return { ok: true, status: await this.status(userId) };
    if (row.status !== "pending") {
      return { ok: false, status: 409, message: "이미 끝난 인증 요청입니다. 처음부터 다시 인증해주세요." };
    }
    if (!row.fresh) {
      await this.fail(requestId, "시간 초과");
      return { ok: false, status: 410, message: "인증 시간이 지났습니다. 처음부터 다시 인증해주세요." };
    }
    const checked = await this.askProvider(row.provider, requestId);
    if (!checked.ok) return checked;
    const { birthYear, personHash } = checked;
    const onePerPerson = (await this.setting<boolean>(ONE_PERSON_KEY)) === true;

    return await this.db.transaction(async (tx) => {
      /*
       * 같은 사람이 두 계정에서 동시에 끝내면 둘 다 "다른 계정 없음" 을 보고 둘 다 저장한다.
       * 사람(해시) 단위로 줄을 세운다.
       */
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${personHash}`}, 0))`);
      // 한 번만 쓴다 — 동시에 두 번 오면 하나만 여기를 지난다
      const claimed = (await tx.execute(sql`
        UPDATE identity_verifications SET status = 'verified', completed_at = now()
        WHERE request_id = ${requestId} AND status = 'pending' RETURNING id
      `)) as unknown as { rows: unknown[] };
      if (!claimed.rows?.length) {
        const { rows: now } = (await tx.execute(sql`
          SELECT status FROM identity_verifications WHERE request_id = ${requestId}
        `)) as unknown as { rows: Array<{ status: string }> };
        return now[0]?.status === "verified"
          ? { ok: true as const, status: await this.status(userId) }
          : { ok: false as const, status: 409, message: "이미 끝난 인증 요청입니다. 처음부터 다시 인증해주세요." };
      }

      const { rows: mine } = (await tx.execute(sql`
        SELECT person_hash FROM user_certifications WHERE user_id = ${userId}::uuid
      `)) as unknown as { rows: Array<{ person_hash: string }> };
      if (mine[0] && mine[0].person_hash !== personHash) {
        /*
         * 이미 다른 사람으로 인증된 계정. 바꿔 주면 성인 한 명이 미성년자의 계정마다 인증을
         * 덮어써 줄 수 있고, 한 사람 한 계정도 계정을 옮겨 가며 빠져나간다.
         */
        await tx.execute(sql`
          UPDATE identity_verifications SET status = 'failed', failure_reason = '다른 명의'
          WHERE request_id = ${requestId}
        `);
        return { ok: false as const, status: 409, message: "이미 다른 명의로 본인인증한 계정입니다." };
      }
      if (onePerPerson) {
        const { rows: others } = (await tx.execute(sql`
          SELECT 1 FROM user_certifications WHERE person_hash = ${personHash} AND user_id <> ${userId}::uuid LIMIT 1
        `)) as unknown as { rows: unknown[] };
        if (others.length) {
          await tx.execute(sql`
            UPDATE identity_verifications SET status = 'failed', failure_reason = '다른 계정에서 인증됨'
            WHERE request_id = ${requestId}
          `);
          return {
            ok: false as const,
            status: 409,
            message: "이미 다른 계정에서 본인인증을 했습니다. 이 사이트는 한 사람이 한 계정만 쓸 수 있습니다.",
          };
        }
      }
      await tx.execute(sql`
        INSERT INTO user_certifications (user_id, provider, person_hash, birth_year, verified_at)
        VALUES (${userId}::uuid, ${row.provider}, ${personHash}, ${birthYear}, now())
        ON CONFLICT (user_id) DO UPDATE SET
          provider = EXCLUDED.provider, birth_year = EXCLUDED.birth_year, verified_at = now()
      `);
      return {
        ok: true as const,
        status: { verified: true, adult: isAdultByBirthYear(birthYear), verifiedAt: new Date() },
      };
    });
  }

  /**
   * 공급자에게 **직접** 묻는다 — 화면이 보낸 이름·생년월일은 받지도 않는다. 회원 인증과 가입 전 인증이 같이 쓴다.
   */
  private async askProvider(providerName: string, requestId: string): Promise<
    | { ok: true; birthYear: number; birthDate: string; personHash: string }
    | { ok: false; status: number; message: string }
  > {
    const entry = this.providers.get(providerName);
    if (!entry) return { ok: false, status: 409, message: "사용할 수 없는 본인인증 수단입니다." };
    let check: Awaited<ReturnType<IdentityProvider["verify"]>>;
    try {
      check = await entry.provider.verify(requestId);
    } catch (err) {
      check = { ok: false, reason: String(err) };
    }
    if (!check.ok) {
      await this.fail(requestId, check.reason);
      return { ok: false, status: 402, message: check.customerReason ?? "본인인증이 완료되지 않았습니다." };
    }
    const person = check.person;
    const birthDate = String(person.birthDate ?? "");
    const birth = /^(\d{4})-\d{2}-\d{2}$/.exec(birthDate);
    const key = String(person.ci ?? "").trim() || String(person.di ?? "").trim();
    if (!birth || !key) {
      // 생년월일·연계정보가 없으면 나이도 한 사람도 판정할 수 없다 — 받은 것으로 치지 않는다
      await this.fail(requestId, !birth ? "생년월일 없음" : "CI·DI 없음");
      return { ok: false, status: 502, message: "인증 결과를 확인할 수 없습니다. 잠시 후 다시 시도해주세요." };
    }
    return { ok: true, birthYear: Number(birth[1]), birthDate, personHash: this.personHash(key) };
  }

  // ── 가입 전 본인인증 ───────────────────────────────
  //
  // 계정이 없으니 요청을 회원에 묶을 수 없다. 대신 **브라우저**에 묶는다: 서버가 만든 비밀값을 httpOnly
  // 쿠키로 주고 그 HMAC 을 요청에 적는다. 브라우저가 정한 ID 를 믿지 않는 것은 회원 인증과 같다 — 남이 끝낸
  // 인증(또는 공급자 콘솔에서 본 ID)을 들고 와 내 가입에 붙일 수 없다.

  /** 새 쿠키 값 (비밀값) */
  newGuestToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private guestHash(token: string): string {
    return createHmac("sha256", this.env.secret).update(`identity-guest:${token}`).digest("hex");
  }

  async startSignup(guestToken: string, providerName: string): Promise<{ ok: true; requestId: string } | { ok: false; message: string }> {
    const entry = this.providers.get(providerName);
    if (!guestToken || !entry || !(await entry.provider.isReady().catch(() => false))) {
      return { ok: false, message: "사용할 수 없는 본인인증 수단입니다." };
    }
    const requestId = `bid${randomBytes(16).toString("hex")}`;
    await this.db.execute(sql`
      INSERT INTO identity_verifications (guest_hash, provider, request_id)
      VALUES (${this.guestHash(guestToken)}, ${providerName}, ${requestId})
    `);
    return { ok: true, requestId };
  }

  /**
   * 가입 전 인증을 확인한다. 결과는 가입이 가져갈 때까지 요청에 잠깐 둔다.
   *
   * 여기서 거절하는 것: **만 14세 미만**(법정대리인 동의 절차가 없다), 그리고 한 사람 한 계정 사이트에서
   * **이미 가입한 사람**(계정을 만들고 나서 거절하면 빈 계정이 남는다). 가입할 때 한 번 더 본다 — 그 사이에
   * 다른 창에서 가입했을 수 있다.
   */
  async completeSignup(guestToken: string, requestId: string): Promise<
    { ok: true; adult: boolean } | { ok: false; status: number; message: string }
  > {
    if (!guestToken || !/^[A-Za-z0-9]{1,40}$/.test(requestId)) {
      return { ok: false, status: 404, message: "인증 요청을 찾을 수 없습니다." };
    }
    const { rows } = (await this.db.execute(sql`
      SELECT guest_hash, provider, status, birth_year,
             created_at > now() - make_interval(mins => ${REQUEST_TTL_MINUTES}) AS fresh
      FROM identity_verifications WHERE request_id = ${requestId}
    `)) as unknown as { rows: Array<{ guest_hash: string | null; provider: string; status: string; birth_year: number | null; fresh: boolean }> };
    const row = rows[0];
    if (!row || !row.guest_hash || row.guest_hash !== this.guestHash(guestToken)) {
      return { ok: false, status: 404, message: "인증 요청을 찾을 수 없습니다." };
    }
    if (row.status === "verified") return { ok: true, adult: isAdultByBirthYear(Number(row.birth_year)) };
    if (row.status !== "pending") {
      return { ok: false, status: 409, message: "이미 끝난 인증 요청입니다. 처음부터 다시 인증해주세요." };
    }
    if (!row.fresh) {
      await this.fail(requestId, "시간 초과");
      return { ok: false, status: 410, message: "인증 시간이 지났습니다. 처음부터 다시 인증해주세요." };
    }
    const checked = await this.askProvider(row.provider, requestId);
    if (!checked.ok) return checked;
    const age = manAge(checked.birthDate);
    if (age === null || age < 14) {
      await this.fail(requestId, "만 14세 미만");
      return { ok: false, status: 403, message: "만 14세 미만은 이 사이트에 가입할 수 없습니다. 법정대리인의 동의가 필요하니 운영자에게 문의해주세요." };
    }
    if ((await this.setting<boolean>(ONE_PERSON_KEY)) === true && (await this.personTaken(checked.personHash))) {
      await this.fail(requestId, "이미 가입한 사람");
      return { ok: false, status: 409, message: "이미 이 사이트에 가입한 계정이 있습니다. 로그인하거나 비밀번호 찾기를 이용해주세요." };
    }
    const claimed = (await this.db.execute(sql`
      UPDATE identity_verifications
      SET status = 'verified', completed_at = now(), person_hash = ${checked.personHash},
          birth_year = ${checked.birthYear}, over14 = true
      WHERE request_id = ${requestId} AND status = 'pending' RETURNING id
    `)) as unknown as { rows: unknown[] };
    if (!claimed.rows?.length) return { ok: false, status: 409, message: "이미 끝난 인증 요청입니다. 처음부터 다시 인증해주세요." };
    return { ok: true, adult: isAdultByBirthYear(checked.birthYear) };
  }

  /** 이 브라우저의 가입 전 인증 — 끝났고, 아직 가입이 가져가지 않았고, 30분이 지나지 않은 것 */
  async signupStatus(guestToken: string): Promise<{ verified: boolean; adult: boolean }> {
    if (!guestToken) return { verified: false, adult: false };
    const { rows } = (await this.db.execute(sql`
      SELECT birth_year FROM identity_verifications
      WHERE guest_hash = ${this.guestHash(guestToken)} AND status = 'verified' AND consumed_at IS NULL
        AND completed_at > now() - make_interval(mins => ${REQUEST_TTL_MINUTES})
      ORDER BY completed_at DESC LIMIT 1
    `)) as unknown as { rows: Array<{ birth_year: number }> };
    return rows[0] ? { verified: true, adult: isAdultByBirthYear(Number(rows[0].birth_year)) } : { verified: false, adult: false };
  }

  /**
   * 가입이 인증 결과를 가져간다 — **계정을 만드는 트랜잭션 안에서** 부른다(인증 없이 만들어진 계정이 남지 않게).
   * 한 번만 가져갈 수 있다. 결과는 회원의 user_certifications 로 옮기고 요청의 결과 칸은 지운다.
   */
  async consumeSignup(
    tx: { execute: BrickDb["execute"] },
    guestToken: string,
    userId: string,
  ): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    const need = { ok: false as const, status: 403, message: "가입하기 전에 본인인증을 해주세요. 인증한 지 30분이 지났다면 다시 인증해야 합니다." };
    if (!guestToken) return need;
    const { rows } = (await tx.execute(sql`
      SELECT id, provider, person_hash, birth_year, over14 FROM identity_verifications
      WHERE guest_hash = ${this.guestHash(guestToken)} AND status = 'verified' AND consumed_at IS NULL
        AND completed_at > now() - make_interval(mins => ${REQUEST_TTL_MINUTES})
      ORDER BY completed_at DESC LIMIT 1
      FOR UPDATE
    `)) as unknown as { rows: Array<{ id: string; provider: string; person_hash: string; birth_year: number; over14: boolean }> };
    const row = rows[0];
    if (!row || !row.person_hash || row.over14 !== true) return need;
    // 사람 단위로 줄을 세운다 — 같은 사람이 두 창에서 동시에 가입해도 한 사람 한 계정이 지켜진다
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${row.person_hash}`}, 0))`);
    if ((await this.setting<boolean>(ONE_PERSON_KEY)) === true) {
      const { rows: taken } = (await tx.execute(sql`
        SELECT 1 FROM user_certifications WHERE person_hash = ${row.person_hash} LIMIT 1
      `)) as unknown as { rows: unknown[] };
      if (taken.length) return { ok: false, status: 409, message: "이미 이 사이트에 가입한 계정이 있습니다. 로그인하거나 비밀번호 찾기를 이용해주세요." };
    }
    await tx.execute(sql`
      INSERT INTO user_certifications (user_id, provider, person_hash, birth_year, verified_at)
      VALUES (${userId}::uuid, ${row.provider}, ${row.person_hash}, ${row.birth_year}, now())
    `);
    await tx.execute(sql`
      UPDATE identity_verifications
      SET consumed_at = now(), user_id = ${userId}::uuid, person_hash = NULL, birth_year = NULL
      WHERE id = ${row.id}::uuid
    `);
    return { ok: true };
  }

  private async personTaken(personHash: string): Promise<boolean> {
    const { rows } = (await this.db.execute(sql`
      SELECT 1 FROM user_certifications WHERE person_hash = ${personHash} LIMIT 1
    `)) as unknown as { rows: unknown[] };
    return rows.length > 0;
  }

  /**
   * 오래된 요청을 지운다 — 인증 결과는 user_certifications 에 있다. 주기 정리가 부른다.
   * 가입이 가져가지 않은 가입 전 인증은 하루 뒤에 지운다 — 사람 해시·출생 연도를 계정 없이 오래 두지 않는다.
   */
  async prune(): Promise<number> {
    const { rows } = (await this.db.execute(sql`
      DELETE FROM identity_verifications
      WHERE created_at < now() - interval '30 days'
         OR (user_id IS NULL AND created_at < now() - interval '1 day')
      RETURNING id
    `)) as unknown as { rows: unknown[] };
    return rows?.length ?? 0;
  }

  /**
   * CI 원문은 두지 않는다 — 평생 바뀌지 않는 식별자라 새면 되돌릴 수 없다. 같은 사람인지만
   * 알면 되므로 사이트 비밀로 HMAC 한다(다른 사이트의 유출 목록과 대조할 수도 없다).
   */
  private personHash(key: string): string {
    return createHmac("sha256", this.env.secret).update(`identity-person:${key}`).digest("hex");
  }

  private async fail(requestId: string, reason: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE identity_verifications SET status = 'failed', failure_reason = ${reason.slice(0, 300)}, completed_at = now()
      WHERE request_id = ${requestId} AND status = 'pending'
    `);
  }

  private async setting<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, key)).limit(1);
    return (row?.value as T) ?? null;
  }
}
