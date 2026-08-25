import { pgTable, varchar, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * 설치된 플러그인/테마 레지스트리.
 * 파일시스템(plugins/, themes/)이 원본이고 이 테이블은 활성화 상태를 기록한다.
 * → 컨테이너 재생성 시에도 볼륨의 파일 + 이 테이블로 상태가 복원된다.
 */
export const installedPlugins = pgTable("installed_plugins", {
  name: varchar("name", { length: 100 }).primaryKey(),
  version: varchar("version", { length: 50 }).notNull(),
  manifest: jsonb("manifest").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
});

export const installedThemes = pgTable("installed_themes", {
  name: varchar("name", { length: 100 }).primaryKey(),
  version: varchar("version", { length: 50 }).notNull(),
  manifest: jsonb("manifest").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 플러그인별 마이그레이션 이력 (플러그인이 자기 테이블을 소유하기 위한 장치) */
export const pluginMigrations = pgTable("plugin_migrations", {
  id: varchar("id", { length: 255 }).primaryKey(), // "<plugin>:<filename>"
  pluginName: varchar("plugin_name", { length: 100 }).notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
