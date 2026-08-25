import { Global, Module } from "@nestjs/common";
import { ExtensionInstallerService } from "./extension-installer.service.js";

@Global()
@Module({
  providers: [ExtensionInstallerService],
  exports: [ExtensionInstallerService],
})
export class ExtensionsModule {}
