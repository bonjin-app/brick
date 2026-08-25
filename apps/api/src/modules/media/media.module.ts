import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";

@Module({ controllers: [MediaController] })
export class MediaModule {}
