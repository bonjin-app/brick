import { Module } from "@nestjs/common";
import { StaticController } from "./static.controller.js";

@Module({ controllers: [StaticController] })
export class StaticModule {}
