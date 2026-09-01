import { Module } from "@nestjs/common";
import { PluginsModule } from "../plugins/plugins.module.js";
import { ThemesModule } from "../themes/themes.module.js";
import { SearchModule } from "../search/search.module.js";
import { PagesController } from "./pages.controller.js";
import { PageRenderService } from "./page-render.service.js";
import { CoreBlocksService } from "./core-blocks.service.js";

@Module({
  // SearchModule 은 core/search 블록(통합검색 화면)이 쓴다 — 역방향 의존 없음
  imports: [PluginsModule, ThemesModule, SearchModule],
  providers: [PageRenderService, CoreBlocksService],
  controllers: [PagesController],
  exports: [PageRenderService],
})
export class PagesModule {}
