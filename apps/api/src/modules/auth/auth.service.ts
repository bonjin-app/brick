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
    // 사용자 부재와 비밀번호 불일치를 구분해 노출하지 않는다
    if (!row || !row.isActive || !(await argon2.verify(row.passwordHash, password))) {
      throw new UnauthorizedException("invalid credentials");
    }
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(sessions).values({
      id: uuidv7(),
      userId: row.id,
      tokenHash: this.hash(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86400_000),
    });
    return { token, user: this.toSessionUser(row) };
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, this.hash(token)));
  }

  /** 특정 사용자의 모든 세션 무효화 (비밀번호 변경/계정 비활성화 시) */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
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
