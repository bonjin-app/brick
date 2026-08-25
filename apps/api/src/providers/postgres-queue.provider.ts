import { and, eq, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { queueJobs } from "@brick/database";
import type { QueueProvider, QueueJob } from "@brick/core";

/**
 * Redis 없이 동작하는 기본 큐.
 * FOR UPDATE SKIP LOCKED 폴링 — 소규모 설치형에는 충분하고,
 * 대규모에서는 REDIS_URL만 설정하면 BullMQ 구현으로 교체된다.
 */
export class PostgresQueueProvider implements QueueProvider {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: BrickDb,
    private readonly pollMs = 1000,
  ) {}

  async enqueue<T>(name: string, payload: T, opts?: { delaySeconds?: number; maxAttempts?: number }): Promise<string> {
    const id = uuidv7();
    await this.db.insert(queueJobs).values({
      id,
      name,
      payload: payload as never,
      maxAttempts: opts?.maxAttempts ?? 3,
      runAt: opts?.delaySeconds ? new Date(Date.now() + opts.delaySeconds * 1000) : new Date(),
    });
    return id;
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): () => void {
    const timer = setInterval(() => void this.tick(name, handler), this.pollMs);
    this.timers.set(name, timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(name);
    };
  }

  private async tick<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    // 하나 집어서 running으로 마킹 (동시 워커 안전)
    const claimed = await this.db.execute(sql`
      UPDATE queue_jobs SET status = 'running', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM queue_jobs
        WHERE status = 'pending' AND name = ${name} AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, name, payload, attempts, max_attempts
    `);
    const row = (claimed as unknown as { rows: Array<Record<string, unknown>> }).rows?.[0];
    if (!row) return;

    const job: QueueJob<T> = {
      id: row.id as string,
      name: row.name as string,
      payload: row.payload as T,
      attempts: row.attempts as number,
    };
    try {
      await handler(job);
      await this.db.update(queueJobs).set({ status: "done" }).where(eq(queueJobs.id, job.id));
    } catch (err) {
      const failedFinally = job.attempts >= (row.max_attempts as number);
      await this.db
        .update(queueJobs)
        .set({
          status: failedFinally ? "failed" : "pending",
          lastError: String(err),
          runAt: new Date(Date.now() + 2 ** job.attempts * 1000), // 지수 백오프
        })
        .where(and(eq(queueJobs.id, job.id), lte(queueJobs.attempts, row.max_attempts as number)));
    }
  }
}
