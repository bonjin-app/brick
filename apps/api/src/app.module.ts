import { Module } from "@nestjs/common";
import { InstallModule } from "./modules/install/install.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { ExtensionsModule } from "./modules/extensions/extensions.module.js";
import { PagesModule } from "./modules/pages/pages.module.js";
import { PluginsModule } from "./modules/plugins/plugins.module.js";
import { ThemesModule } from "./modules/themes/themes.module.js";
import { StaticModule } from "./modules/static/static.module.js";
import { RuntimeModule } from "./runtime.module.js";

@Module({
  imports: [RuntimeModule, AuthModule, ExtensionsModule, InstallModule, PluginsModule, ThemesModule, PagesModule, StaticModule],
})
export class AppModule {}
