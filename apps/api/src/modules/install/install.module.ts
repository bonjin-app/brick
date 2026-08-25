import { Module } from "@nestjs/common";
import { InstallController } from "./install.controller.js";

@Module({ controllers: [InstallController] })
export class InstallModule {}
