import { Injectable, Inject, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import argon2 from "argon2";
import { uuidv7 } from "uuidv7";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { users, sessions } from "@brick/database";
import type { SessionUser } from "@brick/shared";
import { DB } from "../../runtime.module.js";

export const SESSION_COOKIE = "brick_session";
const SESSION_TTL_DAYS = 30;

/**
 * 세션 인증.
 * 토큰 원문은 쿠키에만 존재하고 DB에는 sha256 해시만 저장한다.
 * (DB가 유출되어도 세션 탈취 불가)
 */
@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: BrickDb) {}

  async login(email: string, password: string): Promise<{ token: string; user: SessionUser }> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    // 사용자 부재와 비밀번호 불일치를 구분해 노출하지 않는다.
    // 소셜 전용 계정(passwordLoginEnabled=false)도 같은 응답으로 거절한다 —
    // "이 이메일은 소셜 계정입니다"라고 알려주면 가입 여부가 새어 나간다.
    if (
      !row ||
      !row.isActive ||
      row.passwordLoginEnabled === false ||
      !(await argon2.verify(row.passwordHash, password))
    ) {
      throw new UnauthorizedException("invalid credentials");
    }

    // 탈퇴한 계정은 is_active=false 이므로 위에서 이미 걸린다.
    // "탈퇴한 계정입니다"라고 알려주지 않는다 — 그 이메일이 한때 가입되어 있었다는
    // 사실이 새어 나간다.

    // 마지막 로그인 기록 + 휴면 해제.
    //
    // 휴면 계정은 비밀번호가 맞으면 풀어준다. 본인 확인의 기준이 평소 로그인과
    // 같으므로 더 높은 문턱을 둘 이유가 없고, 해제 경로가 없으면 휴면은
    // 되돌릴 수 없는 함정이 된다(사용자는 관리자에게 연락할 방법도 모른다).
    // 데이터를 분리 보관하는 방식이 아니라 플래그이므로 이 판단이 성립한다.
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), dormantAt: null })
      .where(eq(users.id, row.id));

    return { token: await this.issueSession(row.id), user: this.toSessionUser(row) };
  }

  /**
   * 세션 발급.
   *
   * 비밀번호 검증과 분리해 둔다 — 소셜 로그인은 비밀번호를 보지 않지만
   * 세션은 똑같이 발급해야 한다. 이 메서드는 **인증을 하지 않으므로**,
   * 호출자가 신원을 확인한 뒤에만 불러야 한다.
   */
  async issueSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash: this.hash(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86400_000),
    });
    return token;
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, this.hash(token)));
  }

  /** 특정 사용자의 모든 세션 무효화 (비밀번호 변경/계정 비활성화 시) */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  /**
   * 현재 비밀번호 확인.
   *
   * 되돌릴 수 없는 동작(탈퇴, 이메일 변경) 앞에서 다시 확인하는 데 쓴다 —
   * 세션이 탈취된 상태에서 계정을 지워버리는 경로를 닫는다.
   *
   * 비밀번호 로그인이 꺼진 계정(소셜 전용)은 항상 false 다. 호출하는 쪽이
   * 다른 확인 수단을 써야 한다 — true 를 주면 아무 값으로나 통과된다.
   */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row || row.passwordLoginEnabled === false) return false;
    if (!password) return false;
    try {
      return await argon2.verify(row.passwordHash, password);
    } catch {
      // 해시 형식이 아닌 값(탈퇴 계정의 withdrawn: 접두어 등)은 verify 가 던진다
      return false;
    }
  }

  async resolve(token: string): Promise<SessionUser | null> {
    if (!token) return null;
    const [row] = await this.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, this.hash(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row || !row.user.isActive) return null;
    return this.toSessionUser(row.user);
  }

  /** 쿠키 또는 Authorization: Bearer 에서 세션 해석 */
  async resolveFromRequest(req: FastifyRequest): Promise<SessionUser | null> {
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    return this.resolve(cookieToken ?? bearer ?? "");
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private toSessionUser(row: typeof users.$inferSelect): SessionUser {
    return { id: row.id, email: row.email, displayName: row.displayName, role: row.role as SessionUser["role"] };
  }
}
