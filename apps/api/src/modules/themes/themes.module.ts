import { Module } from "@nestjs/common";
import { ThemesService } from "./themes.service.js";
import { ThemesController } from "./themes.controller.js";

@Module({
  providers: [ThemesService],
  controllers: [ThemesController],
  exports: [ThemesService],
})
export class ThemesModule {}
