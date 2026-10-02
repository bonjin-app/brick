import { Module } from "@nestjs/common";
import { PluginsModule } from "../plugins/plugins.module.js";
import { ThemesModule } from "../themes/themes.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { SearchModule } from "../search/search.module.js";
import { MembersModule } from "../members/members.module.js";
import { PagesController } from "./pages.controller.js";
import { PageRenderService } from "./page-render.service.js";
import { CoreBlocksService } from "./core-blocks.service.js";
import { PublishSchedulerService } from "./publish-scheduler.service.js";
import { RevisionsService } from "./revisions.service.js";

@Module({
  // SearchModule 은 core/search 블록(통합검색 화면)이 쓴다 — 역방향 의존 없음
  // MembersModule 은 core/agreement 블록(공개 이용약관 화면)이 쓴다 — 역방향 의존 없음
  imports: [PluginsModule, ThemesModule, SearchModule, NotificationsModule, MembersModule],
  providers: [PageRenderService, CoreBlocksService, PublishSchedulerService, RevisionsService],
  controllers: [PagesController],
  exports: [PageRenderService, PublishSchedulerService],
})
export class PagesModule {}
