import { Module } from "@nestjs/common";
import { SiteController } from "./site.controller.js";

@Module({ controllers: [SiteController] })
export class SiteModule {}
