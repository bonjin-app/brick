import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { PluginsModule } from "../plugins/plugins.module.js";
import { OpenApiController } from "./openapi.controller.js";
import { OpenApiService } from "./openapi.service.js";

@Module({
  imports: [DiscoveryModule, PluginsModule],
  controllers: [OpenApiController],
  providers: [OpenApiService],
})
export class OpenApiModule {}
