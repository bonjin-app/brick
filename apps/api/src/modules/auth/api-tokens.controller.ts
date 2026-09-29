import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { SessionUser } from "@brick/shared";
import { AdminGuard } from "./auth.guard.js";
import { ApiTokensService, API_TOKEN_PATHS } from "./api-tokens.service.js";
import { PasswordConfirmService } from "./password-confirm.service.js";
import { AuditService } from "../audit/audit.service.js";

const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;
const MAX_ACTIVE = 20;

/**
 * 읽기 전용 API 토큰 관리 (관리자, 로그인 세션으로만).
 *
 * 토큰 자체로는 이 경로에 닿을 수 없다 — 허용목록 밖이라 인증 서비스가 거절한다. 그래서 토큰이 새 토큰을 만들거나
 * 자기 폐기를 취소하는 일은 없다. 만들 때 비밀번호를 다시 묻는다: 이것은 로그인 없이 쓰는 자격증명이다.
 */
@Controller("api/admin/api-tokens")
@UseGuards(AdminGuard)
export class ApiTokensController {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly passwordConfirm: PasswordConfirmService,
    private readonly audit: AuditService,
  ) {}

  /** 목록 + 토큰이 열어 주는 경로 (무엇을 주는 것인지 눈으로 확인하게) */
  @Get()
  async list() {
    return { items: await this.tokens.list(), paths: API_TOKEN_PATHS };
  }

  /** 만든다. 원문(`token`)은 이 응답에만 있다 */
  @Post()
  async create(@Req() req: FastifyRequest & { user: SessionUser }, @Body() body: { name?: string; expiresInDays?: number; password?: string }) {
    const name = String(body?.name ?? "").trim().slice(0, 100);
    if (!name) throw new BadRequestException("토큰 이름을 적어 주세요.");
    const days = body?.expiresInDays === undefined ? DEFAULT_DAYS : Number(body.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      throw new BadRequestException("유효 기간은 1일에서 365일 사이의 정수여야 합니다.");
    }
    await this.passwordConfirm.assertConfirmed(req.user.id, String(body?.password ?? ""), () => new BadRequestException("비밀번호가 올바르지 않습니다."));
    // 쓰지 않는 토큰이 쌓이는 것을 막는다 — 새로 만들기 전에 안 쓰는 것을 폐기하게 한다
    const active = (await this.tokens.list()).filter((t) => t.active).length;
    if (active >= MAX_ACTIVE) throw new BadRequestException("사용 중인 토큰이 너무 많습니다. 쓰지 않는 토큰을 먼저 폐기하세요.");

    const created = await this.tokens.create({ name, createdBy: req.user.id, expiresInDays: days });
    await this.audit.record({ action: "apitoken.create", targetType: "api_token", targetId: created.id, summary: `${name} (${days}일)`, actor: req.user, ip: req.ip });
    return { id: created.id, token: created.token, expiresAt: created.expiresAt, paths: API_TOKEN_PATHS };
  }

  @Delete(":id")
  async revoke(@Req() req: FastifyRequest & { user: SessionUser }, @Param("id") id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException();
    const done = await this.tokens.revoke(id);
    if (!done) throw new NotFoundException("이미 폐기됐거나 없는 토큰입니다.");
    await this.audit.record({ action: "apitoken.revoke", targetType: "api_token", targetId: id, actor: req.user, ip: req.ip });
    return { ok: true };
  }
}
