import { Module } from "@nestjs/common";
import { InstallModule } from "./modules/install/install.module.js";
import { PluginsModule } from "./modules/plugins/plugins.module.js";
import { ThemesModule } from "./modules/themes/themes.module.js";
import { RuntimeModule } from "./runtime.module.js";

@Module({
  imports: [RuntimeModule, InstallModule, PluginsModule, ThemesModule],
})
export class AppModule {}
