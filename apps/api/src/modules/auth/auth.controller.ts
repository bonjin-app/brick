import {
  Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Req, Res, UnauthorizedException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService, SESSION_COOKIE } from "./auth.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { PasswordResetService } from "./password-reset.service.js";
import type { HookBus } from "@brick/core";
import { HOOKS } from "../../runtime.module.js";
import { AuditService } from "../audit/audit.service.js";

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
    private readonly reset: PasswordResetService,
    private readonly audit: AuditService,
    @Inject(HOOKS) private readonly hooks: HookBus,
  ) {}

  @Post("login")
  async login(
    @Body() body: { email: string; password: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // 계정별은 엄격하게, IP별은 느슨하게.
    // NAT로 IP를 공유하는 환경(사무실/가정)에서 정상 사용자가 무더기로 잠기는 것을 막으면서
    // 한 계정에 대한 집중 공격은 확실히 차단한다.
    const email = (body?.email ?? "").toLowerCase().trim();
    const keys: Array<{ key: string; limit: number }> = [
      { key: `email:${email}`, limit: 5 },
      { key: `ip:${req.ip}`, limit: 50 },
    ];
    for (const { key, limit } of keys) {
      const { allowed, retryAfterSeconds } = this.rateLimit.consume(key, limit, 15 * 60_000);
      if (!allowed) {
        reply.header("retry-after", String(retryAfterSeconds));
        throw new HttpException(
          `로그인 시도가 너무 많습니다. ${Math.ceil(retryAfterSeconds / 60)}분 후 다시 시도하세요.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const { token, user } = await this.auth.login(email, body?.password ?? "");
    for (const { key } of keys) this.rateLimit.reset(key);

    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax", // CSRF 방어: 크로스사이트 POST에는 쿠키가 실리지 않는다
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 86400,
    });
    // 출석 적립·접속 로그 등이 구독한다. 실패해도 로그인은 성공해야 하므로
    // doAction 내부에서 예외를 삼킨다(HookBus의 계약).
    await this.hooks.doAction("auth.login", { userId: user.id, email: user.email, ip: req.ip });
    return { user };
  }

  @Post("logout")
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }

  /**
   * 비밀번호 재설정 요청.
   * 계정 존재 여부를 응답으로 구분할 수 없게 항상 동일하게 답한다 (이메일 열거 방지).
   */
  @Post("password/forgot")
  async forgot(@Body() body: { email: string }, @Req() req: FastifyRequest) {
    const email = (body?.email ?? "").toLowerCase().trim();
    // 메일 폭탄 방어: 주소별 3회/시간, IP별 10회/시간
    const limits: Array<{ key: string; limit: number }> = [
      { key: `reset:email:${email}`, limit: 3 },
      { key: `reset:ip:${req.ip}`, limit: 10 },
    ];
    for (const { key, limit } of limits) {
      if (!this.rateLimit.consume(key, limit, 60 * 60_000).allowed) {
        // 제한에 걸려도 열거 정보를 주지 않기 위해 동일 응답을 유지한다
        return { ok: true };
      }
    }
    await this.reset.request(email, req.ip);
    await this.audit.record({ action: "auth.password_reset_requested", ip: req.ip });
    return { ok: true };
  }

  /** 재설정 화면 진입 시 토큰 유효성 확인 */
  @Get("password/verify")
  async verifyResetToken(@Query("token") token?: string) {
    return { valid: await this.reset.verify(token ?? "") };
  }

  @Post("password/reset")
  async resetPassword(
    @Body() body: { token: string; password: string },
    @Req() req: FastifyRequest,
  ) {
    if (!this.rateLimit.consume(`reset-submit:${req.ip}`, 20, 60 * 60_000).allowed) {
      throw new HttpException("요청이 너무 많습니다. 잠시 후 다시 시도하세요.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = await this.reset.complete(body?.token ?? "", body?.password ?? "");
    if (!ok) {
      throw new HttpException(
        "링크가 만료되었거나 이미 사용되었습니다. 다시 요청해주세요. (비밀번호는 8자 이상)",
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.audit.record({ action: "auth.password_reset_completed", ip: req.ip });
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: FastifyRequest) {
    const user = await this.auth.resolveFromRequest(req);
    if (!user) throw new UnauthorizedException();
    return { user };
  }
}
