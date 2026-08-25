import { Module } from "@nestjs/common";
import { SetupController } from "./setup.controller.js";

/** DB 설정이 없을 때만 등록되는 모듈 (RuntimeModule을 의존하지 않는다) */
@Module({ controllers: [SetupController] })
export class SetupModule {}
