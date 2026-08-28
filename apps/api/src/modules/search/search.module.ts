import { Module } from "@nestjs/common";
import { SearchService } from "./search.service.js";
import { SearchController } from "./search.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

@Module({
  imports: [PluginsModule],
  providers: [SearchService],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
