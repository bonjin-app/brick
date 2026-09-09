import { Logger } from "@nestjs/common";
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
  private readonly logger = new Logger("Queue");
  private timers = new Map<string, NodeJS.Timeout>();
  /** 같은 오류를 초당 한 줄씩 남기지 않기 위한 기억 */
  private lastFailure = { text: "", at: 0 };

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
    /*
     * 폴링 오류를 **삼켜야** 한다.
     *
     * 전에는 `void this.tick(...)` 이었다. tick 안의 try/catch 는 작업 핸들러만 감싸므로,
     * 작업을 집는 질의나 상태 업데이트가 던지면 미처리 프로미스 거부가 되고 Node 는
     * 프로세스를 죽인다 — 즉 **DB 가 잠시 끊기면 사이트가 내려갔다**(PostgreSQL 재시작,
     * 커넥션 풀 순단). Docker 라면 재시작되지만 FTP 배포본은 그냥 죽어 있는다.
     * 큐는 다음 주기에 다시 시도하면 되므로, 로그만 남기고 폴링을 계속한다.
     */
    const timer = setInterval(() => {
      this.tick(name, handler).catch((err) => this.reportPollFailure(name, err));
    }, this.pollMs);
    this.timers.set(name, timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(name);
    };
  }

  /** 1초마다 도는 폴링이다 — 같은 오류를 매초 남기면 진짜 로그가 묻힌다 */
  private reportPollFailure(name: string, err: unknown): void {
    const text = String(err);
    const now = Date.now();
    if (text === this.lastFailure.text && now - this.lastFailure.at < 30_000) return;
    this.lastFailure = { text, at: now };
    this.logger.warn(`작업 폴링 실패 (${name}) — 다음 주기에 다시 시도합니다: ${text}`);
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
