import {
  Body, Controller, Get, HttpException, HttpStatus, Post, Req, Res, UnauthorizedException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService, SESSION_COOKIE } from "./auth.service.js";
import { RateLimitService } from "./rate-limit.service.js";

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
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
    return { user };
  }

  @Post("logout")
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: FastifyRequest) {
    const user = await this.auth.resolveFromRequest(req);
    if (!user) throw new UnauthorizedException();
    return { user };
  }
}
