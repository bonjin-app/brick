import { Global, Module } from "@nestjs/common";
import { CspService } from "./csp.service.js";
import { ThemesModule } from "../themes/themes.module.js";

/** 응답 보안 헤더 — 테마·플러그인 선언을 읽어야 하므로 서비스로 둔다 */
@Global()
@Module({
  imports: [ThemesModule],
  providers: [CspService],
  exports: [CspService],
})
export class SecurityModule {}
