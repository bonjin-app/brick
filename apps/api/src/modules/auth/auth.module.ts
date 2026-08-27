import { Global, Module } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard, AdminGuard } from "./auth.guard.js";
import { RateLimitService } from "./rate-limit.service.js";
import { PasswordResetService } from "./password-reset.service.js";
import { OAuthService } from "./oauth.service.js";

/** 전역 모듈 — 어느 모듈에서든 AuthService/가드를 주입할 수 있다 */
@Global()
@Module({
  providers: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService, OAuthService],
  controllers: [AuthController],
  exports: [AuthService, AuthGuard, AdminGuard, RateLimitService, PasswordResetService],
})
export class AuthModule {}
