import { Global, Module } from "@nestjs/common";
import { MaintenanceModeService } from "./maintenance-mode.service.js";

/**
 * 점검 모드 상태를 **아무 데서나** 읽을 수 있게 한다.
 *
 * 읽어야 하는 곳이 공개 렌더(PagesModule)와 플러그인 디스패처(PluginsModule)인데,
 * 그 둘은 이미 서로를 반대 방향으로 쓰고 있어 한쪽이 다른 쪽을 읽으면 모듈이
 * 순환한다. RuntimeModule 안에 넣지 않은 이유는 그쪽이 `DB` 토큰을 정의하는
 * 파일이라, 서비스가 그 파일을 import 하는 순간 **모듈 로드 시점에** 순환이
 * 생기기 때문이다(실제로 `Cannot access 'DB' before initialization` 이 났다).
 */
@Global()
@Module({
  providers: [MaintenanceModeService],
  exports: [MaintenanceModeService],
})
export class MaintenanceModeModule {}
