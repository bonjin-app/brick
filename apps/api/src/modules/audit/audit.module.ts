import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";
import { AuditController } from "./audit.controller.js";

/** 전역 — 어느 모듈에서든 감사 기록을 남길 수 있어야 한다 */
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
