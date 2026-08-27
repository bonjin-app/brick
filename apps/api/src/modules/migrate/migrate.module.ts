import { Module } from "@nestjs/common";
import { RuntimeModule } from "../../runtime.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { PluginsModule } from "../plugins/plugins.module.js";
import { MigrateService } from "./migrate.service.js";
import { MigrateController } from "./migrate.controller.js";

/** 그누보드 데이터 이전 — 코어 기능 (플러그인이 꺼져도 이전 경로는 있어야 한다) */
@Module({
  imports: [RuntimeModule, AuditModule, PluginsModule],
  controllers: [MigrateController],
  providers: [MigrateService],
  exports: [MigrateService],
})
export class MigrateModule {}
