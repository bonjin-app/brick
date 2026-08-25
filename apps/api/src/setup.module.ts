import { Module } from "@nestjs/common";
import { SetupModule } from "./modules/setup/setup.module.js";
import { SetupHealthController } from "./modules/setup/setup-health.controller.js";

/**
 * setup 모드 루트 모듈.
 *
 * DB가 없으므로 RuntimeModule(연결 풀)을 올리지 않는다.
 * 설치 마법사와 헬스체크만 제공한다.
 */
@Module({
  imports: [SetupModule],
  controllers: [SetupHealthController],
})
export class SetupAppModule {}
