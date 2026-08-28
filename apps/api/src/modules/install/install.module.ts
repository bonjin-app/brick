import { Module } from "@nestjs/common";
import { InstallController } from "./install.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

@Module({
  // 스타터가 플러그인을 활성화하므로 loader 가 필요하다
  imports: [PluginsModule],
  controllers: [InstallController],
})
export class InstallModule {}
