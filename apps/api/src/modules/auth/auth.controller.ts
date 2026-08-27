import {
  Body, Controller, Delete, Get, HttpException, HttpStatus, Inject, Param, Post, Put,
  Query, Req, Res, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService, SESSION_COOKIE } from "./auth.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { PasswordResetService } from "./password-reset.service.js";
import { OAuthService, safeNext } from "./oauth.service.js";
import type { HookBus } from "@brick/core";
import { HOOKS } from "../../runtime.module.js";
import { AuditService } from "../audit/audit.service.js";
import { AdminGuard } from "./auth.guard.js";

/** 소셜 로그인 state 쿠키 — 콜백 경로에서만 필요하므로 path를 좁힌다 */
const OAUTH_STATE_COOKIE = "brick_oauth_state";

/** 로그인 화면으로 메시지를 들고 돌아간다 */
function loginBack(message: string): string {
  return `/login?error=${encodeURIComponent(message.slice(0, 200))}`;
}

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
    private readonly reset: PasswordResetService,
    private readonly audit: AuditService,
    private readonly oauth: OAuthService,
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


  // ════════════════════════════════════════════════════
  //  소셜 로그인
  // ════════════════════════════════════════════════════

  /** 로그인 화면이 어떤 버튼을 보일지 결정하는 데 쓴다 (비밀키는 나가지 않는다) */
  @Get("oauth/providers")
  async oauthProviders() {
    return { items: await this.oauth.publicProviders() };
  }

  /**
   * 인증 시작 — 공급자로 302.
   *
   * state를 쿠키에도 심는다. 콜백에서 쿠키와 쿼리의 state가 같아야 통과하므로,
   * 공격자가 자기 흐름의 state를 남의 브라우저에 심어 자기 계정으로
   * 로그인시키는 것(로그인 CSRF)을 막는다.
   */
  @Get("oauth/:provider")
  async oauthStart(
    @Param("provider") provider: string,
    @Query("next") next: string,
    @Query("link") link: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    // 소셜 로그인 시작도 남용될 수 있다 (공급자에 대한 요청 증폭)
    if (!this.rateLimit.consume(`oauth:${req.ip}`, 30, 15 * 60_000).allowed) {
      throw new HttpException("요청이 너무 많습니다. 잠시 후 다시 시도하세요.", HttpStatus.TOO_MANY_REQUESTS);
    }

    // link=1 이면 "연결" 흐름 — 로그인한 사람만 할 수 있다
    let linkToUserId: string | null = null;
    if (link === "1") {
      const me = await this.auth.resolveFromRequest(req);
      if (!me) throw new UnauthorizedException("로그인이 필요합니다.");
      linkToUserId = me.id;
    }

    const { url, state } = await this.oauth.authorize(provider, { next, linkToUserId });
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      path: "/api/auth/oauth",
      httpOnly: true,
      // lax로는 공급자에서 되돌아오는 GET에 쿠키가 실린다. none은 불필요하게 넓다.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 600,
    });
    return reply.redirect(url, 302);
  }

  /**
   * 콜백 — 여기서 세션을 발급하고 사이트로 되돌린다.
   *
   * 오류를 JSON으로 주지 않는다. 사용자는 브라우저로 이 주소에 도착했으므로
   * 로그인 화면으로 메시지를 들고 돌아가야 한다.
   */
  @Get("oauth/:provider/callback")
  async oauthCallback(
    @Param("provider") provider: string,
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/api/auth/oauth" });

    // 사용자가 공급자 화면에서 취소한 경우
    if (query.error) {
      return reply.redirect(loginBack("소셜 로그인이 취소되었습니다."), 302);
    }

    let result: { userId: string; next: string; created: boolean };
    try {
      result = await this.oauth.callback({
        provider,
        code: query.code ?? "",
        state: query.state ?? "",
        cookieState: (req.cookies as Record<string, string> | undefined)?.[OAUTH_STATE_COOKIE] ?? "",
      });
    } catch (err) {
      const message =
        err instanceof HttpException
          ? String((err.getResponse() as { message?: string })?.message ?? err.message)
          : "소셜 로그인에 실패했습니다.";
      await this.audit.record({
        action: "auth.oauth_failed", targetType: "provider", targetId: provider,
        summary: message, ip: req.ip,
      });
      return reply.redirect(loginBack(message), 302);
    }

    const token = await this.auth.issueSession(result.userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 86400,
    });
    await this.audit.record({
      action: result.created ? "auth.oauth_signup" : "auth.oauth_login",
      targetType: "user", targetId: result.userId, summary: provider, ip: req.ip,
    });
    // 신규 가입도 훅 대상이다 — 가입 축하 포인트가 소셜 가입에서 빠지면 안 된다
    if (result.created) {
      await this.hooks.doAction("user.registered", { userId: result.userId, email: null, provider });
    }
    await this.hooks.doAction("auth.login", { userId: result.userId, email: null, ip: req.ip });
    return reply.redirect(result.next, 302);
  }

  /** 내 소셜 연결 목록 */
  @Get("oauth/my/identities")
  async myIdentities(@Req() req: FastifyRequest) {
    const me = await this.auth.resolveFromRequest(req);
    if (!me) throw new UnauthorizedException();
    return { items: await this.oauth.identitiesOf(me.id) };
  }

  /** 연결 해제 — 마지막 로그인 수단이면 거부된다 */
  @Delete("oauth/my/identities/:provider")
  async unlinkIdentity(@Param("provider") provider: string, @Req() req: FastifyRequest) {
    const me = await this.auth.resolveFromRequest(req);
    if (!me) throw new UnauthorizedException();
    await this.oauth.unlink(me.id, provider);
    await this.audit.record({
      action: "auth.oauth_unlink", targetType: "user", targetId: me.id,
      summary: provider, ip: req.ip,
    });
    return { ok: true };
  }

  // ── 관리자: 공급자 설정 ─────────────────────────────
  @Get("oauth/admin/providers")
  @UseGuards(AdminGuard)
  async adminOauthProviders() {
    return { items: await this.oauth.adminProviders() };
  }

  @Put("oauth/admin/providers/:provider")
  @UseGuards(AdminGuard)
  async saveOauthProvider(
    @Param("provider") provider: string,
    @Body() body: {
      enabled?: boolean; clientId?: string; clientSecret?: string;
      authUrl?: string; tokenUrl?: string; profileUrl?: string;
    },
    @Req() req: FastifyRequest,
  ) {
    await this.oauth.saveProvider(provider, body ?? {});
    await this.audit.record({
      action: "auth.oauth_config", targetType: "provider", targetId: provider,
      summary: body?.enabled ? "사용" : "미사용", ip: req.ip,
    });
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: FastifyRequest) {
    const user = await this.auth.resolveFromRequest(req);
    if (!user) throw new UnauthorizedException();
    return { user };
  }
}
