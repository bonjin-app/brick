import { pgTable, varchar, jsonb, timestamp, integer, text, index, uuid } from "drizzle-orm/pg-core";

/**
 * Redis 없이 동작하기 위한 인프라 테이블들 — 캐시·큐·잠금이 전부 여기 있다.
 * (Redis 구현은 아직 없다. `REDIS_URL` 을 설정해도 이 테이블들이 쓰인다.)
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
    // pending | running | done | failed | merged(대기 중인 같은 작업에 합쳐짐)
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /** 임대 시각 — 일하는 워커가 주기적으로 갱신한다. 끊기면 다른 워커가 되찾는다 */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** 같은 키로 대기 중인 작업은 하나만 (0017 의 부분 유니크 인덱스) */
    dedupeKey: varchar("dedupe_key", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("queue_poll_idx").on(t.status, t.name, t.runAt),
    index("queue_lease_idx").on(t.status, t.lockedAt),
  ],
);

/**
 * 감사 로그 — 누가·언제·무엇을 바꿨는가.
 *
 * 프로덕션에서 사고가 났을 때 추적할 수 없으면 원인을 찾을 수 없다.
 * 콘텐츠 본문 같은 큰 데이터는 담지 않고 "무엇에 대한 어떤 동작"만 기록한다.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    /** 행위자. 시스템 동작이면 null */
    actorId: uuid("actor_id"),
    actorEmail: varchar("actor_email", { length: 255 }),
    /** 예: "page.update", "user.role_change", "plugin.activate" */
    action: varchar("action", { length: 80 }).notNull(),
    /** 대상 종류와 식별자. 예: ("page", "<uuid>") */
    targetType: varchar("target_type", { length: 40 }),
    targetId: varchar("target_id", { length: 100 }),
    /** 사람이 읽는 요약. 예: "슬러그 about → about-us" */
    summary: varchar("summary", { length: 500 }),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId),
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
  ],
);
