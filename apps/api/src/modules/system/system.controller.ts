import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/auth.guard.js";
import { SystemService } from "./system.service.js";

/**
 * 시스템 정보 — 관리자만.
 * 버전은 공개 헬스체크에 싣지 않는다: 어떤 버전이 돌고 있는지는 공격자에게 유용한 정보다.
 */
@Controller("api/admin")
@UseGuards(AdminGuard)
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get("version")
  version() {
    return this.system.versionInfo();
  }

  @Post("version/recheck")
  async recheck() {
    this.system.invalidate();
    return this.system.versionInfo();
  }
}
