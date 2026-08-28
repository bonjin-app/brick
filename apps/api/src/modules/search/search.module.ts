import { Module } from "@nestjs/common";
import { SearchService } from "./search.service.js";
import { SearchController } from "./search.controller.js";
import { LinkTargetsController } from "./link-targets.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

@Module({
  imports: [PluginsModule],
  providers: [SearchService],
  controllers: [SearchController, LinkTargetsController],
  exports: [SearchService],
})
export class SearchModule {}
