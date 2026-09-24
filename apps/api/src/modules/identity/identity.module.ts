import { Global, Module } from "@nestjs/common";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

/**
 * 본인인증 — 전역 모듈. 플러그인 로더(공급자 등록)·코어 블록(인증 화면)·정리 작업이 같은
 * 등록부를 본다.
 */
@Global()
@Module({
  // 컨트롤러가 공급자 표시 이름을 플러그인 카탈로그로 번역한다
  imports: [PluginsModule],
  providers: [IdentityService],
  controllers: [IdentityController],
  exports: [IdentityService],
})
export class IdentityModule {}
