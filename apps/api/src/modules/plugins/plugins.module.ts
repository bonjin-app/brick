import { Module } from "@nestjs/common";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { PluginsController } from "./plugins.controller.js";

@Module({
  providers: [PluginLoaderService],
  controllers: [PluginsController],
  exports: [PluginLoaderService],
})
export class PluginsModule {}
