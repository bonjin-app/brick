import { Module } from "@nestjs/common";
import { RuntimeModule } from "../../runtime.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { MailingService } from "./mailing.service.js";
import { MailingController } from "./mailing.controller.js";

/**
 * 회원 단체메일 — 코어 기능.
 *
 * 플러그인으로 두면 플러그인을 끄는 순간 광고 수신 동의 검사가 사라진다.
 * 그건 위법 발송으로 이어진다.
 */
@Module({
  imports: [RuntimeModule, AuditModule],
  controllers: [MailingController],
  providers: [MailingService],
  exports: [MailingService],
})
export class MailingModule {}
