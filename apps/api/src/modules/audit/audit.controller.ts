import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "./audit.service.js";

@Controller("api/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @UseGuards(AdminGuard)
  list(
    @Query("page") page?: string,
    @Query("action") action?: string,
    @Query("targetType") targetType?: string,
    @Query("actor") actor?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.audit.list({ page: Number(page ?? 1), action, targetType, actor, from, to });
  }

  /** 화면의 동작 필터 선택지 — 무엇이 기록되는지는 플러그인에 따라 달라진다 */
  @Get("actions")
  @UseGuards(AdminGuard)
  async actions() {
    return { items: await this.audit.actions() };
  }
}
