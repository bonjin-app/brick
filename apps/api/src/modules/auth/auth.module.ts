import { Global, Module } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard, AdminGuard } from "./auth.guard.js";
import { RateLimitService } from "./rate-limit.service.js";
import { PasswordResetService } from "./password-reset.service.js";
import { OAuthService } from "./oauth.service.js";
import { TwoFactorService } from "./two-factor.service.js";
import { ReauthService } from "./reauth.service.js";
import { AccountSecurityController } from "./account-security.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

/** 전역 모듈 — 어느 모듈에서든 AuthService/가드를 주입할 수 있다 */
@Global()
@Module({
  // 재설정 메일이 사이트 언어를 따르려면 로더의 siteLocale 이 필요하다
  // (회원 탈퇴 화면이 같은 이유로 이미 같은 것을 쓴다)
  imports: [PluginsModule],
  providers: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService, OAuthService, TwoFactorService, ReauthService],
  controllers: [AuthController, AccountSecurityController],
  exports: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService, TwoFactorService, ReauthService],
})
export class AuthModule {}
