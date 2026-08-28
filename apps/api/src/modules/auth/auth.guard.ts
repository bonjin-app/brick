import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { AuthService } from "./auth.service.js";
import { DB } from "../../runtime.module.js";
import type { BrickDb } from "@brick/database";

/** 로그인 필수 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(protected readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const user = await this.auth.resolveFromRequest(req);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

/**
 * 관리자 전용.
 *
 * 2단계 인증 강제(`security.require_2fa_for_staff`)가 켜져 있으면, 2FA 를
 * 켜지 않은 관리자의 **관리 작업을 막는다.**
 *
 * 로그인 자체를 막지 않는 이유: 설정을 켠 순간 아무도 못 들어오게 되면
 * 등록할 방법이 없어 사이트가 잠긴다. 등록 경로(`/api/me/security/*`)는
 * AuthGuard 만 쓰므로 열려 있고, 관리 화면만 닫힌다.
 */
@Injectable()
export class AdminGuard extends AuthGuard {
  constructor(
    auth: AuthService,
    @Inject(DB) private readonly db: BrickDb,
  ) {
    super(auth);
  }

  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { id: string; role: string } }>();
    if (req.user?.role !== "admin") throw new ForbiddenException("admin only");

    const { rows } = await this.db.execute(sql`
      SELECT
        (SELECT value FROM site_settings WHERE key = 'security.require_2fa_for_staff') AS required,
        EXISTS (SELECT 1 FROM user_totp
                WHERE user_id = ${req.user.id}::uuid AND is_enabled = true) AS has_totp
    `);
    const required = rows[0]?.required === true || rows[0]?.required === "true";
    if (required && rows[0]?.has_totp !== true) {
      throw new ForbiddenException(
        "이 사이트는 관리자에게 2단계 인증을 요구합니다. 계정 보안 설정에서 먼저 등록해주세요.",
      );
    }
    return true;
  }
}
