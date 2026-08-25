import { pgTable, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * 사이트 전역 설정 key-value 저장소.
 * 설치 마법사 완료 여부(install.state), 사이트명, 활성 테마 등이 들어간다.
 * 플러그인 설정은 "plugin:<name>:" 접두사 네임스페이스를 쓴다.
 */
export const siteSettings = pgTable("site_settings", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
