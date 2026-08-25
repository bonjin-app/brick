import { eq, lt, sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { cacheEntries } from "@brick/database";
import type { CacheProvider } from "@brick/core";

/** Redis 없이 동작하는 기본 캐시. cache_entries는 마이그레이션에서 UNLOGGED로 생성한다 */
export class PostgresCacheProvider implements CacheProvider {
  constructor(private readonly db: BrickDb) {}

  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(cacheEntries).where(eq(cacheEntries.key, key)).limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < new Date()) {
      await this.del(key);
      return null;
    }
    return row.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.setWithTags(key, value, [], ttlSeconds);
  }

  async setWithTags<T>(key: string, value: T, tags: string[], ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
    await this.db
      .insert(cacheEntries)
      .values({ key, value: value as never, tags, expiresAt })
      .onConflictDoUpdate({
        target: cacheEntries.key,
        set: { value: value as never, tags, expiresAt },
      });
  }

  async del(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) await this.db.delete(cacheEntries).where(eq(cacheEntries.key, k));
  }

  async invalidateTag(tag: string): Promise<void> {
    await this.db.delete(cacheEntries).where(sql`${cacheEntries.tags} @> ${JSON.stringify([tag])}::jsonb`);
  }

  /** 주기 정리 작업에서 호출 */
  async sweepExpired(): Promise<void> {
    await this.db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, new Date()));
  }
}
