import { Module } from "@nestjs/common";
import { RuntimeModule } from "./runtime.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { CaptchaModule } from "./modules/captcha/captcha.module.js";
import { ExtensionsModule } from "./modules/extensions/extensions.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { InstallModule } from "./modules/install/install.module.js";
import { MaintenanceModule } from "./modules/maintenance/maintenance.module.js";
import { MediaModule } from "./modules/media/media.module.js";
import { MembersModule } from "./modules/members/members.module.js";
import { MigrateModule } from "./modules/migrate/migrate.module.js";
import { PagesModule } from "./modules/pages/pages.module.js";
import { PluginsModule } from "./modules/plugins/plugins.module.js";
import { SeoModule } from "./modules/seo/seo.module.js";
import { SiteModule } from "./modules/site/site.module.js";
import { StaticModule } from "./modules/static/static.module.js";
import { ThemesModule } from "./modules/themes/themes.module.js";
import { UsersModule } from "./modules/users/users.module.js";

@Module({
  imports: [
    RuntimeModule,
    AuditModule,
    AuthModule,
    CaptchaModule,
    ExtensionsModule,
    HealthModule,
    MaintenanceModule,
    InstallModule,
    UsersModule,
    MediaModule,
    MembersModule,
    MigrateModule,
    SeoModule,
    SiteModule,
    PluginsModule,
    ThemesModule,
    PagesModule,
    StaticModule,
  ],
})
export class AppModule {}
