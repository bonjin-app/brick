import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { RuntimeModule } from "../../runtime.module.js";
import { ModerationService } from "./moderation.service.js";
import { IpBlockGuard } from "./ip-block.guard.js";

/**
 * 모더레이션 — 금지 단어 · 가입 금지 · 접속 차단 IP.
 *
 * 전역 모듈이다: 회원(가입·이름 변경), 플러그인 로더(ctx.moderation), 사이트 설정(캐시
 * 무효화), 그리고 전 요청 가드가 같은 서비스를 쓴다. RuntimeModule 안에 두지 않는 이유:
 * 서비스가 RuntimeModule 의 DB 토큰을 import 하므로 거기 넣으면 순환 import 가 되어
 * 부팅 시 토큰이 undefined 로 평가된다(실제로 그렇게 죽었다).
 */
@Global()
@Module({
  imports: [RuntimeModule],
  providers: [ModerationService, { provide: APP_GUARD, useClass: IpBlockGuard }],
  exports: [ModerationService],
})
export class ModerationModule {}
