import { Module } from "@nestjs/common";
import { PluginsModule } from "../plugins/plugins.module.js";
import { ThemesModule } from "../themes/themes.module.js";
import { PagesController } from "./pages.controller.js";
import { PageRenderService } from "./page-render.service.js";
import { CoreBlocksService } from "./core-blocks.service.js";

@Module({
  imports: [PluginsModule, ThemesModule],
  providers: [PageRenderService, CoreBlocksService],
  controllers: [PagesController],
  exports: [PageRenderService],
})
export class PagesModule {}
