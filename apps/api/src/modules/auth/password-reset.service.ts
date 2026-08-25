import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { BrickDb } from "@brick/database";
import { passwordResets, users } from "@brick/database";
import type { MailProvider } from "@brick/core";
import { DB, MAIL, ENV } from "../../runtime.module.js";
import type { loadEnv } from "../../config/env.js";
import { AuthService } from "./auth.service.js";

const TOKEN_TTL_MINUTES = 30;

/**
 * 비밀번호 재설정.
 *
 * 보안 설계:
 *  1. **이메일 열거 방지** — 등록되지 않은 주소여도 성공 응답을 준다.
 *     "존재하지 않는 계정" 응답은 공격자에게 회원 목록을 알려준다.
 *  2. **토큰은 해시로 저장** — 세션과 같은 원칙. DB 유출로 계정을 빼앗을 수 없다.
 *  3. **단회성** — used_at을 원자적으로 채워 재사용을 막는다.
 *  4. **짧은 유효기간** — 30분.
 *  5. **성공 시 전 세션 무효화** — 공격자가 이미 로그인해 있었다면 끊어낸다.
 *  6. **기존 미사용 토큰 폐기** — 새로 요청하면 이전 링크는 죽는다.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger("PasswordReset");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(MAIL) private readonly mail: MailProvider,
    @Inject(ENV) private readonly env: ReturnType<typeof loadEnv>,
    private readonly auth: AuthService,
  ) {}

  /**
   * 재설정 메일 요청.
   * @returns 항상 void — 계정 존재 여부를 호출자에게도 알리지 않는다
   */
  async request(rawEmail: string, ip?: string): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user || !user.isActive) {
      // 존재하지 않는 계정에도 같은 시간을 쓴다 (타이밍으로 구분되지 않게)
      await argon2.hash(randomBytes(16).toString("hex")).catch(() => undefined);
      this.logger.log(`재설정 요청 — 대상 없음 (열거 방지를 위해 성공 응답)`);
      return;
    }

    // 이전 미사용 토큰 폐기: 새 링크를 받으면 옛 링크는 즉시 죽어야 한다
    await this.db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

    const token = randomBytes(32).toString("base64url");
    await this.db.insert(passwordResets).values({
      id: uuidv7(),
      userId: user.id,
      tokenHash: this.hash(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000),
      requestedIp: ip ?? null,
    });

    const link = `${this.env.siteUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const sent = await this.mail.send({
      to: user.email,
      subject: "[Brick] 비밀번호 재설정 안내",
      text:
        `${user.displayName}님, 안녕하세요.\n\n` +
        `비밀번호를 재설정하려면 아래 링크를 열어주세요. 유효 시간은 ${TOKEN_TTL_MINUTES}분입니다.\n\n` +
        `${link}\n\n` +
        `본인이 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 변경되지 않습니다.\n` +
        `링크는 한 번만 사용할 수 있습니다.\n`,
      html:
        `<p>${escapeHtml(user.displayName)}님, 안녕하세요.</p>` +
        `<p>비밀번호를 재설정하려면 아래 버튼을 눌러주세요. 유효 시간은 ${TOKEN_TTL_MINUTES}분입니다.</p>` +
        `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;` +
        `background:#d0402c;color:#fff;border-radius:8px;text-decoration:none">비밀번호 재설정</a></p>` +
        `<p style="color:#666;font-size:13px">본인이 요청하지 않았다면 이 메일을 무시하세요. ` +
        `비밀번호는 변경되지 않습니다. 링크는 한 번만 사용할 수 있습니다.</p>`,
    });

    if (!sent) {
      // SMTP 미설정/장애 시 운영자가 알 수 있게 로그에 링크를 남긴다 (개발 편의)
      this.logger.warn(`메일 발송 실패 — 재설정 링크: ${link}`);
    }
  }

  /** 토큰 유효성만 확인 (재설정 화면 진입 시) */
  async verify(token: string): Promise<boolean> {
    return (await this.findValid(token)) !== null;
  }

  /**
   * 비밀번호 변경 확정.
   * @returns 성공 여부. 토큰이 유효하지 않으면 false
   */
  async complete(token: string, newPassword: string): Promise<boolean> {
    if (newPassword.length < 8) return false;
    const row = await this.findValid(token);
    if (!row) return false;

    // 단회성: used_at을 조건부로 채운다. 동시에 두 번 들어와도 한 번만 성공한다
    const claimed = await this.db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });
    if (!claimed.length) return false;

    await this.db
      .update(users)
      .set({ passwordHash: await argon2.hash(newPassword), updatedAt: new Date() })
      .where(eq(users.id, row.userId));

    // 공격자가 이미 세션을 갖고 있었다면 여기서 끊어낸다
    await this.auth.revokeAllSessions(row.userId);
    this.logger.log(`비밀번호 재설정 완료 (user ${row.userId})`);
    return true;
  }

  /** 만료·사용된 토큰 정리 */
  async prune(): Promise<void> {
    await this.db.delete(passwordResets).where(lt(passwordResets.expiresAt, new Date()));
  }

  private async findValid(token: string) {
    if (!token || token.length > 200) return null;
    const [row] = await this.db
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, this.hash(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return null;
    // 해시 비교는 이미 DB 인덱스로 끝났지만, 상수시간 비교로 한 번 더 확인한다
    const a = Buffer.from(row.tokenHash);
    const b = Buffer.from(this.hash(token));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return row;
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
