import { pgTable, varchar, jsonb, timestamp, integer, text, index } from "drizzle-orm/pg-core";

/**
 * Redis 없이 동작하기 위한 인프라 테이블들.
 * REDIS_URL이 설정되면 이 테이블들 대신 Redis 구현이 쓰인다.
 */

/** PostgresCacheProvider 백엔드. UNLOGGED로 생성해 WAL 부하를 없앤다(마이그레이션에서 처리) */
export const cacheEntries = pgTable(
  "cache_entries",
  {
    key: varchar("key", { length: 500 }).primaryKey(),
    value: jsonb("value").notNull(),
    tags: jsonb("tags").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("cache_expires_idx").on(t.expiresAt)],
);

/** PostgresQueueProvider 백엔드. FOR UPDATE SKIP LOCKED로 소비 */
export const queueJobs = pgTable(
  "queue_jobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | running | done | failed
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("queue_poll_idx").on(t.status, t.name, t.runAt)],
);
