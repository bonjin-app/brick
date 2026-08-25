import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthService } from "./auth.service.js";

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

/** 관리자 전용 */
@Injectable()
export class AdminGuard extends AuthGuard {
  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { role: string } }>();
    if (req.user?.role !== "admin") throw new ForbiddenException("admin only");
    return true;
  }
}
