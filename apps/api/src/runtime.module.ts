import { Global, Module } from "@nestjs/common";
import { createDb } from "@brick/database";
import { HookBus } from "@brick/core";
import { PostgresCacheProvider } from "./providers/postgres-cache.provider.js";
import { PostgresQueueProvider } from "./providers/postgres-queue.provider.js";
import { LocalStorageProvider } from "./providers/local-storage.provider.js";

export const DB = "BRICK_DB";
export const HOOKS = "BRICK_HOOKS";
export const CACHE = "BRICK_CACHE";
export const QUEUE = "BRICK_QUEUE";
export const STORAGE = "BRICK_STORAGE";

/**
 * RuntimeModule — Provider 조립 지점.
 *
 * 원칙: Brick Core는 PostgreSQL만으로 완전히 동작한다.
 *  - REDIS_URL 있음  → RedisCache/RedisQueue (추후 @brick/redis 패키지)
 *  - REDIS_URL 없음  → Postgres 기반 기본 구현 (지금)
 *  - STORAGE_DRIVER  → local(기본) | s3 | r2
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is required");
        return createDb(url);
      },
    },
    { provide: HOOKS, useValue: new HookBus() },
    {
      provide: CACHE,
      useFactory: (db: unknown) => new PostgresCacheProvider(db as never),
      inject: [DB],
    },
    {
      provide: QUEUE,
      useFactory: (db: unknown) => new PostgresQueueProvider(db as never),
      inject: [DB],
    },
    {
      provide: STORAGE,
      useFactory: () => new LocalStorageProvider(process.env.BRICK_UPLOADS_DIR ?? "uploads"),
    },
  ],
  exports: [DB, HOOKS, CACHE, QUEUE, STORAGE],
})
export class RuntimeModule {}
