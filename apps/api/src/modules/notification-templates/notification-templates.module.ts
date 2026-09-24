import { Module } from "@nestjs/common";
import { PluginsModule } from "../plugins/plugins.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { NotificationTemplatesController } from "./notification-templates.controller.js";

/**
 * 알림 문구 편집 — 알림 종류는 플러그인 등록부(로더)에서, 저장·발송은 알림 서비스에서.
 * 알림 모듈이 로더를 가져오면 순환이 되므로 따로 둔다.
 */
@Module({
  imports: [PluginsModule, NotificationsModule, AuditModule],
  controllers: [NotificationTemplatesController],
})
export class NotificationTemplatesModule {}
