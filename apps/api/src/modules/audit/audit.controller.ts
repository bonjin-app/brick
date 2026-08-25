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
  ) {
    return this.audit.list({ page: Number(page ?? 1), action, targetType });
  }
}
