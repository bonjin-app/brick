import { Module } from "@nestjs/common";
import { SiteController } from "./site.controller.js";
import { PluginsModule } from "../plugins/plugins.module.js";

// PluginsModule — 로그인·가입 화면에 확장이 등록한 비회원용 링크(주문조회·고객센터)를 함께 준다
@Module({ imports: [PluginsModule], controllers: [SiteController] })
export class SiteModule {}
