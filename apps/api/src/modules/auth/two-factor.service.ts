/**
 * 2단계 인증 · 세션 관리.
 *
 * **관리자 계정이 뚫리면 사이트 전체를 잃는다.** 회원 개인정보, 주문 내역,
 * 결제 정보 접근 권한이 한 계정에 몰려 있고, 유출되면 개인정보보호법상
 * 신고 의무가 생긴다. 재사용된 비밀번호는 다른 사이트 유출로 뚫리고,
 * 그 사실을 우리는 알 수 없다.
 *
 * ── 설계에서 조심한 것 ───────────────────────────────
 *
 * **잠기지 않게.** 2FA 는 잘못 만들면 본인을 영구히 배제한다. 그래서
 * (1) 코드를 한 번 검증하기 전에는 켜지 않고, (2) 복구 코드를 반드시 주고,
 * (3) 강제 설정이 켜져 있어도 등록 경로는 열어 둔다. 휴면 계정에서 배운
 * 것과 같다 — 되돌릴 수 없는 상태를 만들면 함정이 된다.
 *
 * **비밀번호만으로 세션을 주지 않는다.** 코드 확인 전에는 짧게 사는
 * 도전 토큰만 준다. 그것으로는 아무것도 할 수 없다.
 */
import { Inject, Injectable, Logger, BadRequestException, UnauthorizedException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { DB } from "../../runtime.module.js";
import type { BrickDb } from "@brick/database";
import {
  generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUri, verifyCode,
} from "./totp.js";

/** 도전 토큰 수명 — 길게 두면 비밀번호만 아는 공격자가 코드를 맞출 시간이 늘어난다 */
const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * 도전 하나당 시도 한계.
 *
 * 6자리는 100만분의 1이다. 다섯 번이면 실수를 흡수하고 무차별 시도는 막는다
 * (실패하면 비밀번호부터 다시 입력해야 한다).
 */
const MAX_ATTEMPTS = 5;

export interface TotpStatus {
  enabled: boolean;
  /** 남은 복구 코드 수 — 다 쓰기 전에 알려줘야 한다 */
  recoveryCodesLeft: number;
  enabledAt: Date | null;
}

@Injectable()
export class TwoFactorService {
  private readonly log = new Logger("TwoFactor");

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  private sha256(v: string): string {
    return createHash("sha256").update(v).digest("hex");
  }

  /**
   * IP 해시.
   *
   * 원본을 남기지 않는다 — 접속 위치 이력이 되고, 그것은 보관할 이유가 없는
   * 개인정보다. 같은 IP 인지 비교하는 데는 해시로 충분하다 (ADR-35 와 같은 원칙).
   */
  private hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHash("sha256").update(`totp:${ip}`).digest("hex").slice(0, 64);
  }

  async status(userId: string): Promise<TotpStatus> {
    const { rows } = await this.db.execute(sql`
      SELECT t.is_enabled, t.enabled_at,
             (SELECT count(*) FROM user_recovery_codes rc
              WHERE rc.user_id = ${userId}::uuid AND rc.used_at IS NULL) AS codes_left
      FROM user_totp t WHERE t.user_id = ${userId}::uuid LIMIT 1
    `);
    const row = rows[0];
    if (!row) return { enabled: false, recoveryCodesLeft: 0, enabledAt: null };
    return {
      enabled: row.is_enabled === true,
      recoveryCodesLeft: Number(row.codes_left ?? 0),
      enabledAt: (row.enabled_at as Date | null) ?? null,
    };
  }

  /** 로그인 시 2FA 를 요구해야 하는가 */
  async isEnabled(userId: string): Promise<boolean> {
    const { rows } = await this.db.execute(sql`
      SELECT 1 FROM user_totp WHERE user_id = ${userId}::uuid AND is_enabled = true LIMIT 1
    `);
    return rows.length > 0;
  }

  /**
   * 등록 시작 — 비밀을 만들어 QR 용 URI 를 준다.
   *
   * 아직 **켜지 않는다.** 이미 켜져 있으면 거절한다 — 다시 등록하면 기존
   * 인증 앱이 조용히 무효가 되고, 사용자는 로그인할 때 알게 된다.
   */
  async beginEnroll(params: {
    userId: string;
    email: string;
    siteName: string;
  }): Promise<{ secret: string; otpauthUri: string }> {
    if (await this.isEnabled(params.userId)) {
      throw new BadRequestException("이미 2단계 인증이 켜져 있습니다. 먼저 해제해주세요.");
    }

    const secret = generateSecret();
    // 등록을 다시 시작하면 이전 비밀을 버린다 (아직 활성화되지 않은 것이다)
    await this.db.execute(sql`
      INSERT INTO user_totp (user_id, secret, is_enabled)
      VALUES (${params.userId}::uuid, ${secret}, false)
      ON CONFLICT (user_id) DO UPDATE
        SET secret = ${secret}, is_enabled = false, last_step = NULL, enabled_at = NULL
    `);

    return {
      secret,
      otpauthUri: otpauthUri({
        secret,
        account: params.email,
        issuer: params.siteName || "Brick",
      }),
    };
  }

  /**
   * 등록 완료 — 코드를 검증하고 켠다.
   *
   * **여기서 검증하지 않으면 잘못된 비밀이 저장되어 본인이 영구히 잠긴다.**
   * 복구 코드는 이 시점에 만들어 한 번만 보여준다.
   */
  async completeEnroll(params: {
    userId: string;
    code: string;
  }): Promise<{ recoveryCodes: string[] }> {
    const { rows } = await this.db.execute(sql`
      SELECT secret, is_enabled FROM user_totp WHERE user_id = ${params.userId}::uuid LIMIT 1
    `);
    const row = rows[0];
    if (!row) throw new BadRequestException("먼저 2단계 인증 등록을 시작해주세요.");
    if (row.is_enabled === true) throw new BadRequestException("이미 켜져 있습니다.");

    const result = verifyCode({ secret: String(row.secret), code: params.code });
    if (!result.ok) {
      throw new BadRequestException(
        result.reason === "format"
          ? "6자리 숫자를 입력해주세요."
          : "코드가 맞지 않습니다. 인증 앱의 시간이 정확한지 확인해주세요.",
      );
    }

    const codes = generateRecoveryCodes();

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE user_totp SET is_enabled = true, enabled_at = now(), last_step = ${result.step}
        WHERE user_id = ${params.userId}::uuid
      `);
      // 이전에 남아 있던 복구 코드는 버린다 (재등록 시 옛 코드가 살아 있으면 안 된다)
      await tx.execute(sql`
        DELETE FROM user_recovery_codes WHERE user_id = ${params.userId}::uuid
      `);
      for (const code of codes) {
        await tx.execute(sql`
          INSERT INTO user_recovery_codes (id, user_id, code_hash)
          VALUES (${uuidv7()}, ${params.userId}::uuid, ${this.sha256(normalizeRecoveryCode(code))})
        `);
      }
    });

    this.log.log(`2단계 인증 활성화: ${params.userId}`);
    // 이 목록은 다시 볼 수 없다 — 화면이 반드시 저장을 안내해야 한다
    return { recoveryCodes: codes };
  }

  /**
   * 해제.
   *
   * 호출자가 **비밀번호를 이미 확인**했다고 전제한다. 세션만으로 끌 수 있으면
   * 훔친 세션으로 2FA 를 무력화할 수 있고, 그러면 2FA 가 의미가 없다.
   */
  async disable(userId: string): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM user_totp WHERE user_id = ${userId}::uuid`);
      await tx.execute(sql`DELETE FROM user_recovery_codes WHERE user_id = ${userId}::uuid`);
    });
    this.log.log(`2단계 인증 해제: ${userId}`);
    return { ok: true };
  }

  /** 복구 코드 재발급 — 남은 것이 적을 때. 비밀번호 확인은 호출자 책임이다 */
  async regenerateRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
    if (!(await this.isEnabled(userId))) {
      throw new BadRequestException("2단계 인증이 켜져 있지 않습니다.");
    }
    const codes = generateRecoveryCodes();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM user_recovery_codes WHERE user_id = ${userId}::uuid`);
      for (const code of codes) {
        await tx.execute(sql`
          INSERT INTO user_recovery_codes (id, user_id, code_hash)
          VALUES (${uuidv7()}, ${userId}::uuid, ${this.sha256(normalizeRecoveryCode(code))})
        `);
      }
    });
    return { recoveryCodes: codes };
  }

  // ── 로그인 중간 단계 ──────────────────────────────

  /**
   * 도전 토큰 발급 — 비밀번호는 맞았고 코드가 남았다.
   *
   * 이 토큰으로는 아무것도 할 수 없다. 코드 검증에만 쓴다.
   */
  async createChallenge(params: { userId: string; ip?: string }): Promise<string> {
    // 만료된 것을 정리한다 (별도 작업을 두지 않아도 테이블이 자라지 않는다)
    await this.db.execute(sql`DELETE FROM totp_challenges WHERE expires_at < now()`);

    const token = randomBytes(32).toString("base64url");
    await this.db.execute(sql`
      INSERT INTO totp_challenges (id, user_id, token_hash, expires_at, ip_hash)
      VALUES (${uuidv7()}, ${params.userId}::uuid, ${this.sha256(token)},
              ${new Date(Date.now() + CHALLENGE_TTL_MS)}, ${this.hashIp(params.ip)})
    `);
    return token;
  }

  /**
   * 도전 검증 — TOTP 코드 또는 복구 코드.
   *
   * 성공하면 도전을 소비하고 userId 를 돌려준다. 호출자가 세션을 발급한다.
   */
  async verifyChallenge(params: {
    token: string;
    code: string;
  }): Promise<{ userId: string; usedRecoveryCode: boolean; recoveryCodesLeft: number }> {
    const { rows } = await this.db.execute(sql`
      SELECT c.id, c.user_id, c.attempts, t.secret, t.last_step
      FROM totp_challenges c
      LEFT JOIN user_totp t ON t.user_id = c.user_id
      WHERE c.token_hash = ${this.sha256(params.token)} AND c.expires_at > now()
      LIMIT 1
    `);
    const ch = rows[0];
    // 만료·위조를 구분해 알려주지 않는다
    if (!ch) throw new UnauthorizedException("인증 시간이 지났습니다. 다시 로그인해주세요.");

    if (Number(ch.attempts) >= MAX_ATTEMPTS) {
      await this.db.execute(sql`DELETE FROM totp_challenges WHERE id = ${String(ch.id)}::uuid`);
      throw new UnauthorizedException("시도 횟수를 초과했습니다. 다시 로그인해주세요.");
    }

    const userId = String(ch.user_id);
    const raw = String(params.code ?? "");

    // TOTP 코드인지 복구 코드인지 **길이로 구분한다.**
    //
    // 처음에는 "숫자만 남겼을 때 6자리면 TOTP" 로 판단했는데 틀렸다.
    // base32 알파벳에는 숫자 2~7 이 있어서, 10자 복구 코드에 숫자가 정확히
    // 6개 들어가는 경우가 **0.4% 확률로 생긴다**(사용자 10명 중 4명은 못 쓰는
    // 코드를 하나 갖는다). 그러면 복구 코드가 TOTP 로 오인되어 거절되고,
    // 그 사실은 **휴대폰을 잃어 복구 코드를 쓰는 순간에만** 드러난다.
    //
    // 구분자를 떼면 TOTP 는 6자, 복구 코드는 10자다. 길이는 겹치지 않는다.
    const compact = raw.toUpperCase().replace(/[\s-]/g, "");
    const isTotpCode = /^\d{6}$/.test(compact);
    const normalized = normalizeRecoveryCode(raw);

    if (!isTotpCode) {
      const used = await this.consumeRecoveryCode(userId, normalized);
      if (used) {
        await this.db.execute(sql`DELETE FROM totp_challenges WHERE id = ${String(ch.id)}::uuid`);
        const left = await this.countRecoveryCodes(userId);
        this.log.warn(`복구 코드로 로그인: ${userId} (남은 코드 ${left}개)`);
        return { userId, usedRecoveryCode: true, recoveryCodesLeft: left };
      }
      await this.bumpAttempts(String(ch.id));
      throw new UnauthorizedException("코드가 맞지 않습니다.");
    }

    if (!ch.secret) {
      // 도전을 만든 뒤 2FA 가 해제된 경우
      await this.db.execute(sql`DELETE FROM totp_challenges WHERE id = ${String(ch.id)}::uuid`);
      throw new UnauthorizedException("다시 로그인해주세요.");
    }

    const result = verifyCode({
      secret: String(ch.secret),
      code: raw,
      lastStep: ch.last_step === null || ch.last_step === undefined ? null : Number(ch.last_step),
    });
    if (!result.ok) {
      await this.bumpAttempts(String(ch.id));
      throw new UnauthorizedException(
        result.reason === "reused"
          ? "이미 사용한 코드입니다. 다음 코드를 기다려주세요."
          : "코드가 맞지 않습니다.",
      );
    }

    await this.db.transaction(async (tx) => {
      // 사용한 스텝을 기록해 재사용을 막는다
      await tx.execute(sql`
        UPDATE user_totp SET last_step = ${result.step} WHERE user_id = ${userId}::uuid
      `);
      await tx.execute(sql`DELETE FROM totp_challenges WHERE id = ${String(ch.id)}::uuid`);
    });

    return {
      userId,
      usedRecoveryCode: false,
      recoveryCodesLeft: await this.countRecoveryCodes(userId),
    };
  }

  private async bumpAttempts(challengeId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE totp_challenges SET attempts = attempts + 1 WHERE id = ${challengeId}::uuid
    `);
  }

  private async countRecoveryCodes(userId: string): Promise<number> {
    const { rows } = await this.db.execute(sql`
      SELECT count(*) AS n FROM user_recovery_codes
      WHERE user_id = ${userId}::uuid AND used_at IS NULL
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 복구 코드 소비.
   *
   * `used_at IS NULL` 조건으로 UPDATE 해서 **동시 요청에서 같은 코드가 두 번
   * 쓰이지 않게** 한다 (읽고 나서 쓰면 그 사이에 다른 요청이 끼어든다).
   */
  private async consumeRecoveryCode(userId: string, normalized: string): Promise<boolean> {
    const { rows } = await this.db.execute(sql`
      UPDATE user_recovery_codes SET used_at = now()
      WHERE user_id = ${userId}::uuid
        AND code_hash = ${this.sha256(normalized)}
        AND used_at IS NULL
      RETURNING id
    `);
    return rows.length > 0;
  }

  // ── 세션 관리 ─────────────────────────────────────

  /**
   * 내 세션 목록 — "지금 누가 내 계정에 접속해 있나".
   *
   * 계정이 뚫렸는지 알아채는 유일한 방법이다. 모르는 기기가 보이면
   * 끊고 비밀번호를 바꿀 수 있다.
   */
  async listSessions(params: {
    userId: string;
    currentTokenHash: string;
  }): Promise<Array<{
    id: string;
    device: string;
    isCurrent: boolean;
    createdAt: Date;
    lastSeenAt: Date | null;
    expiresAt: Date;
  }>> {
    const { rows } = await this.db.execute(sql`
      SELECT id, token_hash, user_agent, created_at, last_seen_at, expires_at
      FROM sessions
      WHERE user_id = ${params.userId}::uuid AND expires_at > now()
      ORDER BY coalesce(last_seen_at, created_at) DESC
    `);
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      device: describeUserAgent(r.user_agent ? String(r.user_agent) : null),
      // 지금 쓰는 세션을 표시한다 — 실수로 자기를 끊는 것을 줄인다
      isCurrent: String(r.token_hash) === params.currentTokenHash,
      createdAt: r.created_at as Date,
      lastSeenAt: (r.last_seen_at as Date | null) ?? null,
      expiresAt: r.expires_at as Date,
    }));
  }

  /** 다른 기기 하나를 끊는다 */
  async revokeSession(params: { userId: string; sessionId: string }): Promise<{ ok: true }> {
    const { rows } = await this.db.execute(sql`
      DELETE FROM sessions
      WHERE id = ${params.sessionId}::uuid AND user_id = ${params.userId}::uuid
      RETURNING id
    `);
    // 남의 세션 id 를 넣었을 때 "없다"와 "권한 없다"를 구분해 알려주지 않는다
    if (!rows.length) throw new BadRequestException("세션을 찾을 수 없습니다.");
    return { ok: true };
  }

  /**
   * 지금 세션만 남기고 전부 끊는다.
   *
   * 계정이 뚫렸다고 의심할 때 누르는 버튼이다. 지금 세션을 남기는 이유:
   * 자기까지 끊기면 다시 로그인해야 하고, 그 사이 공격자가 먼저 들어올
   * 수 있다.
   */
  async revokeOtherSessions(params: {
    userId: string;
    currentTokenHash: string;
  }): Promise<{ revoked: number }> {
    const { rows } = await this.db.execute(sql`
      DELETE FROM sessions
      WHERE user_id = ${params.userId}::uuid AND token_hash <> ${params.currentTokenHash}
      RETURNING id
    `);
    return { revoked: rows.length };
  }

  /** 세션 접속 정보 기록 — 로그인할 때 부른다 */
  async recordSessionContext(params: {
    tokenHash: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE sessions SET ip_hash = ${this.hashIp(params.ip)},
        user_agent = ${(params.userAgent ?? "").slice(0, 400) || null},
        last_seen_at = now()
      WHERE token_hash = ${params.tokenHash}
    `);
  }
}

/**
 * User-Agent 를 사람이 읽는 기기 이름으로.
 *
 * 원문을 그대로 보여주면 아무도 읽지 않는다. 완벽한 판별이 목적이 아니라
 * **"내가 쓰는 기기인가"를 알아보게** 하는 것이 목적이다.
 */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "알 수 없는 기기";
  const s = ua;

  const os =
    /iPhone/.test(s) ? "iPhone"
    : /iPad/.test(s) ? "iPad"
    : /Android/.test(s) ? "Android"
    : /Mac OS X|Macintosh/.test(s) ? "Mac"
    : /Windows/.test(s) ? "Windows"
    : /Linux/.test(s) ? "Linux"
    : null;

  // 순서가 중요하다 — Edge/Chrome 은 UA 에 Safari 를, Edge 는 Chrome 을 포함한다
  const browser =
    /Edg\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /Whale/.test(s) ? "웨일"
    : /SamsungBrowser/.test(s) ? "삼성 인터넷"
    : /Firefox\//.test(s) ? "Firefox"
    : /Chrome\//.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari"
    : /curl\//.test(s) ? "curl"
    : null;

  if (os && browser) return `${os} · ${browser}`;
  if (os) return os;
  if (browser) return browser;
  return "알 수 없는 기기";
}
