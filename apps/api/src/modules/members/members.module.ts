import { Module } from "@nestjs/common";
import { RuntimeModule } from "../../runtime.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { AgreementsService } from "./agreements.service.js";
import { EmailVerifyService } from "./email-verify.service.js";
import { WithdrawalService } from "./withdrawal.service.js";
import { DataErasers } from "./data-erasers.js";
import { MembersController } from "./members.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

/**
 * 회원 생애주기 — 약관 동의 · 이메일 인증 · 탈퇴 · 휴면.
 *
 * 코어 모듈이다. 플러그인으로 두면 플러그인을 끄는 순간 법적 요건이 사라진다.
 */
@Module({
  imports: [RuntimeModule, AuditModule, AuthModule, PluginsModule],
  controllers: [MembersController],
  providers: [AgreementsService, EmailVerifyService, WithdrawalService, DataErasers],
  exports: [AgreementsService, EmailVerifyService, WithdrawalService],
})
export class MembersModule {}
