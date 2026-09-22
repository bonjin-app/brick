import { Module } from "@nestjs/common";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { PluginsController } from "./plugins.controller.js";
import { ThemesModule } from "../themes/themes.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

@Module({
  imports: [ThemesModule, NotificationsModule],
  providers: [PluginLoaderService],
  controllers: [PluginsController],
  exports: [PluginLoaderService],
})
export class PluginsModule {}
