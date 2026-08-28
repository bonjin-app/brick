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

/** 전역 모듈 — 어느 모듈에서든 AuthService/가드를 주입할 수 있다 */
@Global()
@Module({
  providers: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService, OAuthService, TwoFactorService, ReauthService],
  controllers: [AuthController, AccountSecurityController],
  exports: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService, TwoFactorService, ReauthService],
})
export class AuthModule {}
