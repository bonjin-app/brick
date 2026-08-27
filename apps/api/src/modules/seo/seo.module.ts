import { Module } from "@nestjs/common";
import { RuntimeModule } from "../../runtime.module.js";
import { PluginsModule } from "../plugins/plugins.module.js";
import { SeoService } from "./seo.service.js";
import { SeoController } from "./seo.controller.js";

@Module({
  imports: [RuntimeModule, PluginsModule],
  controllers: [SeoController],
  providers: [SeoService],
})
export class SeoModule {}
