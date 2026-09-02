import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ModerationService } from "./moderation.service.js";

/**
 * 접속 차단 IP — 전 요청에 앞서 검사한다 (그누보드의 cf_intercept_ip).
 *
 * 가드로 둔 이유: Nest 의 미들웨어는 Fastify 의 원시 요청을 받아 `req.ip`(trustProxy 를
 * 반영한 클라이언트 IP)가 없다. 가드는 Fastify 요청을 그대로 받는다.
 * 헬스 체크(/readyz, /healthz)는 예외 — 로드밸런서가 차단 목록에 걸리면 사이트가
 * "죽은 것"으로 보인다.
 */
@Injectable()
export class IpBlockGuard implements CanActivate {
  constructor(private readonly moderation: ModerationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const url = req.url ?? "";
    if (url.startsWith("/readyz") || url.startsWith("/healthz")) return true;
    if (await this.moderation.isBlockedIp(req.ip)) {
      throw new ForbiddenException("접속이 차단된 주소입니다.");
    }
    return true;
  }
}
