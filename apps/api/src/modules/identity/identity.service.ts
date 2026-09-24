import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { siteSettings, type BrickDb } from "@brick/database";
import { isAdultByBirthYear, type IdentityProvider, type IdentityStatus } from "@brick/core";
import { DB, ENV } from "../../runtime.module.js";
import type { BrickEnv } from "../../config/env.js";

/** 인증창을 열고 돌아오기까지 기다리는 시간 — 넘으면 새로 시작해야 한다 */
const REQUEST_TTL_MINUTES = 30;

/** 한 사람 한 계정 설정 키 */
export const ONE_PERSON_KEY = "member.one_person_one_account";

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
    const entry = this.providers.get(row.provider);
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
    const birth = /^(\d{4})-\d{2}-\d{2}$/.exec(String(person.birthDate ?? ""));
    const key = String(person.ci ?? "").trim() || String(person.di ?? "").trim();
    if (!birth || !key) {
      // 생년월일·연계정보가 없으면 나이도 한 사람도 판정할 수 없다 — 받은 것으로 치지 않는다
      await this.fail(requestId, !birth ? "생년월일 없음" : "CI·DI 없음");
      return { ok: false, status: 502, message: "인증 결과를 확인할 수 없습니다. 잠시 후 다시 시도해주세요." };
    }
    const birthYear = Number(birth[1]);
    const personHash = this.personHash(key);
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

  /** 오래된 요청을 지운다 — 인증 결과는 user_certifications 에 있다. 주기 정리가 부른다 */
  async prune(): Promise<number> {
    const { rows } = (await this.db.execute(sql`
      DELETE FROM identity_verifications WHERE created_at < now() - interval '30 days' RETURNING id
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
