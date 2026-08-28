/**
 * 계정 보안 — 2단계 인증 설정과 세션 관리.
 *
 * 모두 **본인 계정**에 대한 것이다. 관리자가 남의 2FA 를 켜거나 끌 수는
 * 없다 — 켜주면 비밀을 관리자가 알게 되고, 꺼주면 관리자 계정 하나가
 * 뚫리면 전원의 2FA 가 무력화된다.
 *
 * 상태를 바꾸는 요청에는 **비밀번호를 다시 받는다.** 훔친 세션으로 2FA 를
 * 해제할 수 있으면 2FA 가 의미가 없다.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus,
  Param, Post, Req, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "./auth.guard.js";
import { AuthService, SESSION_COOKIE } from "./auth.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { ReauthService } from "./reauth.service.js";
import { TwoFactorService } from "./two-factor.service.js";
import { AuditService } from "../audit/audit.service.js";
import { sql } from "drizzle-orm";
import { Inject } from "@nestjs/common";
import { DB } from "../../runtime.module.js";
import type { BrickDb } from "@brick/database";

@Controller("api/me/security")
@UseGuards(AuthGuard)
export class AccountSecurityController {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly reauth: ReauthService,
    @Inject(DB) private readonly db: BrickDb,
  ) {}

  /**
   * 위험 작업 재인증 — 비밀번호를 다시 확인하면 이 세션이 10분간 승격된다.
   * 회원 개인정보 열람·대량 발송 같은 작업이 승격을 요구한다.
   */
  @Post("reauth")
  async reauthenticate(
    @Req() req: FastifyRequest,
    @Body() body: { password?: string },
  ) {
    await this.requirePassword(req, String(body?.password ?? ""));
    const granted = this.reauth.grant(this.currentTokenHash(req));
    return { ok: true, ...granted };
  }

  /** site_settings 직접 조회 — 설정 서비스가 없다 (SeoService 도 같은 방식) */
  private async setting(key: string): Promise<unknown> {
    const { rows } = await this.db.execute(sql`
      SELECT value FROM site_settings WHERE key = ${key} LIMIT 1
    `);
    return rows[0]?.value;
  }

  private userId(req: FastifyRequest): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user) throw new UnauthorizedException("로그인이 필요합니다.");
    return user.id;
  }

  private email(req: FastifyRequest): string {
    const user = (req as unknown as { user?: { email: string } }).user;
    return user?.email ?? "";
  }

  private currentTokenHash(req: FastifyRequest): string {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    return this.auth.tokenHash(token ?? bearer ?? "");
  }

  /**
   * 비밀번호 재확인.
   *
   * 브루트포스를 막는다 — 여기가 열려 있으면 훔친 세션으로 비밀번호를
   * 알아낼 수 있다.
   */
  private async requirePassword(req: FastifyRequest, password: string): Promise<void> {
    const userId = this.userId(req);
    const { allowed, retryAfterSeconds } = this.rateLimit.consume(
      `reauth:${userId}`,
      10,
      15 * 60_000,
    );
    if (!allowed) {
      throw new HttpException(
        `너무 많이 시도했습니다. ${retryAfterSeconds}초 후 다시 시도해주세요.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ok = await this.auth.verifyPassword(userId, password);
    if (!ok) throw new UnauthorizedException("비밀번호가 맞지 않습니다.");
    this.rateLimit.reset(`reauth:${userId}`);
  }

  @Get()
  async status(@Req() req: FastifyRequest) {
    const userId = this.userId(req);
    const totp = await this.twoFactor.status(userId);
    return {
      twoFactor: totp,
      /** 관리자·운영자에게 2FA 를 강제하는 설정이 켜져 있는가 */
      requiredForStaff: await this.isRequiredForStaff(),
      sessions: await this.twoFactor.listSessions({
        userId,
        currentTokenHash: this.currentTokenHash(req),
      }),
    };
  }

  private async isRequiredForStaff(): Promise<boolean> {
    const v = await this.setting("security.require_2fa_for_staff");
    return v === true || v === "true";
  }

  // ── 2단계 인증 ────────────────────────────────────

  /**
   * 등록 시작 — QR 코드용 URI 를 준다.
   *
   * 비밀번호를 받는다: 훔친 세션으로 공격자가 **자기 인증 앱을 등록**하면
   * 본인이 잠기고 계정을 빼앗긴다.
   */
  @Post("2fa/begin")
  async begin(@Req() req: FastifyRequest, @Body() body: { password: string }) {
    await this.requirePassword(req, String(body?.password ?? ""));
    const raw = await this.setting("site.name");
    const siteName = typeof raw === "string" && raw.trim() ? raw.trim() : "Brick";
    const result = await this.twoFactor.beginEnroll({
      userId: this.userId(req),
      email: this.email(req),
      siteName,
    });
    return {
      ...result,
      guide:
        "인증 앱(Google Authenticator, Authy, 1Password 등)에 등록한 뒤 " +
        "6자리 코드를 입력해 완료해주세요. 코드를 확인하기 전에는 켜지지 않습니다.",
    };
  }

  /** 등록 완료 — 코드 검증 후 켜고 복구 코드를 준다 */
  @Post("2fa/complete")
  async complete(@Req() req: FastifyRequest, @Body() body: { code: string }) {
    const userId = this.userId(req);
    const { allowed } = this.rateLimit.consume(`2fa-enroll:${userId}`, 10, 15 * 60_000);
    if (!allowed) {
      throw new HttpException("너무 많이 시도했습니다.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = await this.twoFactor.completeEnroll({ userId, code: String(body?.code ?? "") });
    await this.audit.record({ action: "auth.totp_enabled", actor: (req as unknown as { user?: never }).user ?? null, ip: req.ip });
    return {
      ...result,
      warning:
        "복구 코드는 지금 한 번만 표시됩니다. 안전한 곳에 저장해주세요. " +
        "휴대폰을 잃으면 이 코드로만 로그인할 수 있습니다.",
    };
  }

  /**
   * 해제.
   *
   * 강제 설정이 켜진 상태에서 관리자·운영자는 끌 수 없다 — 끌 수 있으면
   * 강제가 아니다.
   */
  @Post("2fa/disable")
  async disable(@Req() req: FastifyRequest, @Body() body: { password: string }) {
    await this.requirePassword(req, String(body?.password ?? ""));
    const userId = this.userId(req);
    const role = (req as unknown as { user?: { role: string } }).user?.role ?? "member";

    if ((role === "admin" || role === "manager") && (await this.isRequiredForStaff())) {
      throw new BadRequestException(
        "이 사이트는 관리자·운영자에게 2단계 인증을 요구합니다. 해제할 수 없습니다.",
      );
    }

    const result = await this.twoFactor.disable(userId);
    await this.audit.record({ action: "auth.totp_disabled", actor: (req as unknown as { user?: never }).user ?? null, ip: req.ip });
    return result;
  }

  /** 복구 코드 재발급 — 남은 것이 적을 때 */
  @Post("2fa/recovery-codes")
  async regenerate(@Req() req: FastifyRequest, @Body() body: { password: string }) {
    await this.requirePassword(req, String(body?.password ?? ""));
    const userId = this.userId(req);
    const result = await this.twoFactor.regenerateRecoveryCodes(userId);
    await this.audit.record({ action: "auth.recovery_codes_regenerated", actor: (req as unknown as { user?: never }).user ?? null, ip: req.ip });
    return {
      ...result,
      warning: "이전 복구 코드는 모두 무효가 되었습니다. 새 코드를 저장해주세요.",
    };
  }

  // ── 세션 ──────────────────────────────────────────

  @Get("sessions")
  async sessions(@Req() req: FastifyRequest) {
    return {
      items: await this.twoFactor.listSessions({
        userId: this.userId(req),
        currentTokenHash: this.currentTokenHash(req),
      }),
    };
  }

  @Delete("sessions/:id")
  async revoke(@Req() req: FastifyRequest, @Param("id") id: string) {
    const userId = this.userId(req);
    const result = await this.twoFactor.revokeSession({ userId, sessionId: id });
    await this.audit.record({ action: "auth.session_revoked", actor: (req as unknown as { user?: never }).user ?? null, ip: req.ip });
    return result;
  }

  /** 지금 기기만 남기고 전부 끊는다 — 계정이 뚫렸다고 의심할 때 */
  @Post("sessions/revoke-others")
  async revokeOthers(@Req() req: FastifyRequest) {
    const userId = this.userId(req);
    const result = await this.twoFactor.revokeOtherSessions({
      userId,
      currentTokenHash: this.currentTokenHash(req),
    });
    await this.audit.record({
      action: "auth.other_sessions_revoked",
      actor: (req as unknown as { user?: never }).user ?? null,
      ip: req.ip,
      summary: `${result.revoked}개 세션 종료`,
    });
    return result;
  }
}
