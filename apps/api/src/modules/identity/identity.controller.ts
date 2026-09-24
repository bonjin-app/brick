import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { IdentityService, SIGNUP_COOKIE, signupCookie } from "./identity.service.js";

/** 가입 전 인증 쿠키 — 인증창을 다녀오는 동안(30분)만. SameSite=Lax 라 인증창에서 돌아오는 이동에도 실린다 */
const SIGNUP_COOKIE_OPTS = {
  path: "/api",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 60,
};


type AuthedRequest = FastifyRequest & { user: { id: string; role: string } };

/**
 * 본인인증 API.
 *
 * 인증 화면(`/identity`, 테마 안에서 그려진다)이 부른다. 테마 화면이어야 하는 이유: 공급자
 * SDK 를 불러오려면 플러그인이 선언한 CSP 가 필요한데, 회원 정보 화면(`/account`)은 고정
 * CSP 라 외부 스크립트를 받지 않는다.
 */
@Controller("api")
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly rateLimit: RateLimitService,
    private readonly loader: PluginLoaderService,
    private readonly auth: AuthService,
  ) {}

  // ── 가입 전 본인인증 (손님) ────────────────────────
  //
  // 인증창을 열고 돌아오기까지를 **이 브라우저**에 묶는다(쿠키). 가입(`POST /api/register`)이 그 결과를
  // 계정을 만드는 트랜잭션 안에서 가져간다.

  /** 가입 화면이 묻는다 — 이 사이트가 가입 전 인증을 요구하는가, 이 브라우저는 인증을 마쳤는가 */
  @Get("identity/signup")
  async signupState(@Req() req: FastifyRequest) {
    const required = await this.identity.signupRequired();
    const s = await this.identity.signupStatus(signupCookie(req));
    return { required, verified: s.verified, adult: s.adult };
  }

  @Post("identity/signup/start")
  @HttpCode(200)
  async signupStart(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: { provider?: unknown }) {
    // 이미 로그인했으면 가입 전 인증이 아니다 — 회원 인증(/me/identity)으로
    if (await this.auth.resolveFromRequest(req)) {
      throw new HttpException("이미 로그인했습니다. 회원 정보에서 본인인증을 해주세요.", HttpStatus.CONFLICT);
    }
    // 손님에게 열린 유료 호출이다 — 주소마다 한도를 둔다(회원 인증보다 좁게)
    const { allowed } = await this.rateLimit.consume(`identity-signup-start:${req.ip ?? "?"}`, 10, 60 * 60_000);
    if (!allowed) {
      throw new HttpException("본인인증을 너무 많이 시도했습니다. 잠시 후 다시 시도해주세요.", HttpStatus.TOO_MANY_REQUESTS);
    }
    let token = signupCookie(req);
    if (!token) token = this.identity.newGuestToken();
    const r = await this.identity.startSignup(token, String(body?.provider ?? ""));
    if (!r.ok) throw new HttpException(r.message, HttpStatus.BAD_REQUEST);
    reply.setCookie(SIGNUP_COOKIE, token, SIGNUP_COOKIE_OPTS);
    return { requestId: r.requestId };
  }

  @Post("identity/signup/complete")
  @HttpCode(200)
  async signupComplete(@Req() req: FastifyRequest, @Body() body: { requestId?: unknown }) {
    const { allowed } = await this.rateLimit.consume(`identity-signup-complete:${req.ip ?? "?"}`, 30, 60 * 60_000);
    if (!allowed) {
      throw new HttpException("본인인증을 너무 많이 시도했습니다. 잠시 후 다시 시도해주세요.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const r = await this.identity.completeSignup(signupCookie(req), String(body?.requestId ?? ""));
    if (!r.ok) throw new HttpException(r.message, r.status);
    return { verified: true, adult: r.adult };
  }

  /** 쓸 수 있는 인증 수단 — 공개 (화면이 버튼을 그릴지 정한다) */
  @Get("identity/providers")
  async providers() {
    const items = await this.identity.readyProviders();
    return {
      items: items.map(({ plugin, provider }) => ({
        name: provider.name,
        displayName: this.loader.trCatalog(plugin, provider.displayName),
      })),
    };
  }

  @Get("me/identity")
  @UseGuards(AuthGuard)
  async mine(@Req() req: AuthedRequest) {
    const s = await this.identity.status(req.user.id);
    // required — 이 사이트가 회원에게 본인인증을 요구하는가(로그인 화면이 인증 화면으로 보낼지 정한다)
    const required = req.user.role === "member" && (await this.identity.isRequired());
    return { verified: s.verified, adult: s.adult, verifiedAt: s.verifiedAt, required };
  }

  /**
   * 인증 시작 — 서버가 인증 ID 를 만들어 이 회원에게 묶는다.
   *
   * **본인인증은 건당 요금이 나간다.** 한도 없이 열어 두면 로그인한 누구든 인증창을 수백 번
   * 열어 운영자에게 청구서를 보낼 수 있다. 정상적인 사람은 한 시간에 몇 번이면 끝난다.
   */
  @Post("me/identity/start")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async start(@Req() req: AuthedRequest, @Body() body: { provider?: unknown }) {
    const { allowed } = await this.rateLimit.consume(`identity-start:${req.user.id}`, 10, 60 * 60_000);
    if (!allowed) {
      throw new HttpException("본인인증을 너무 많이 시도했습니다. 잠시 후 다시 시도해주세요.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const r = await this.identity.start(req.user.id, String(body?.provider ?? ""));
    if (!r.ok) throw new HttpException(r.message, HttpStatus.BAD_REQUEST);
    return { requestId: r.requestId };
  }

  /** 인증창에서 돌아왔다 — 공급자에게 직접 조회해 결과를 저장한다 */
  @Post("me/identity/complete")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async complete(@Req() req: AuthedRequest, @Body() body: { requestId?: unknown }) {
    // 조회도 공급자 API 를 부른다 — 시작보다 넉넉하게, 그러나 끝없이는 아니다
    const { allowed } = await this.rateLimit.consume(`identity-complete:${req.user.id}`, 30, 60 * 60_000);
    if (!allowed) {
      throw new HttpException("본인인증을 너무 많이 시도했습니다. 잠시 후 다시 시도해주세요.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const r = await this.identity.complete(req.user.id, String(body?.requestId ?? ""));
    if (!r.ok) throw new HttpException(r.message, r.status);
    return { verified: r.status.verified, adult: r.status.adult, verifiedAt: r.status.verifiedAt };
  }
}
