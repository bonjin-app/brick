import { Module } from "@nestjs/common";
import { MaintenanceService } from "./maintenance.service.js";
import { AuditModule } from "../audit/audit.module.js";
import { SearchModule } from "../search/search.module.js";
import { MembersModule } from "../members/members.module.js";
import { AuthModule } from "../auth/auth.module.js";

// 정리 대상의 주인들을 가져온다 — 보관 정책은 각 서비스에 있고 여기는 일정만 갖는다
import { NotificationsModule } from "../notifications/notifications.module.js";
@Module({
  imports: [AuditModule, SearchModule, MembersModule, AuthModule, NotificationsModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
