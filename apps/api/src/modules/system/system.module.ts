import { Module } from "@nestjs/common";
import { RuntimeModule } from "../../runtime.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { SystemController } from "./system.controller.js";
import { SystemService } from "./system.service.js";

@Module({
  imports: [RuntimeModule, AuthModule],
  controllers: [SystemController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
