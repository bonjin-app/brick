import { Global, Module } from "@nestjs/common";
import { ExtensionInstallerService } from "./extension-installer.service.js";
import { ExtensionUpdaterService } from "./extension-updater.service.js";

@Global()
@Module({
  providers: [ExtensionInstallerService, ExtensionUpdaterService],
  exports: [ExtensionInstallerService, ExtensionUpdaterService],
})
export class ExtensionsModule {}
