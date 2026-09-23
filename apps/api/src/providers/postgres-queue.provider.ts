import { Logger } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { queueJobs } from "@brick/database";
import type { QueueProvider, QueueJob } from "@brick/core";

/**
 * Redis 없이 동작하는 기본 큐. `FOR UPDATE SKIP LOCKED` 폴링이다.
 * (Redis 구현은 아직 없다 — `REDIS_URL` 을 설정해도 이 구현이 돈다.)
 *
 * 'running' 은 소유가 아니라 **임대**다. 전에는 작업을 집을 때 status 를
 * 'running' 으로 바꾸고 **되돌리는 곳이 없었다.** 프로세스가 그 사이에 죽으면
 * — 배포·컨테이너 재시작·OOM·호스팅사 재부팅, 전부 일상이다 — 그 행은 영원히
 * 'running' 에 남고 폴링은 'pending' 만 보므로 아무도 다시 집지 않았다.
 * 메일 캠페인이 '발송중'에서 멈춘 채 한 통도 나가지 않고, 다시 시작하려 하면
 * "이미 발송 중입니다" 로 거절당하는 자리가 이것이다.
 *
 * 임대는 하트비트로 유지한다. 단순히 "오래된 running 은 되찾는다" 로 하면
 * **아직 살아서 일하는** 긴 작업을 빼앗아 같은 메일을 두 번 보낸다 —
 * 수만 명 발송은 몇 시간이 걸린다.
 */
export class PostgresQueueProvider implements QueueProvider {
  private readonly logger = new Logger("Queue");
  private timers = new Map<string, NodeJS.Timeout>();
  /** 같은 오류를 초당 한 줄씩 남기지 않기 위한 기억 */
  private lastFailure = { text: "", at: 0 };

  constructor(
    private readonly db: BrickDb,
    private readonly pollMs = 1000,
    /** 임대 갱신 주기. 일하는 동안 이 간격으로 locked_at 을 밀어 준다 */
    private readonly heartbeatMs = 15_000,
    /**
     * 임대 만료. 하트비트의 여러 배여야 한다 — GC 정지나 DB 순단으로 갱신이
     * 한두 번 밀리는 것과 워커가 죽은 것을 구별하지 못하면, 살아 있는 작업을
     * 빼앗아 중복 실행한다.
     */
    private readonly leaseMs = 90_000,
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
    const lease = sql.raw(`interval '${Math.round(this.leaseMs / 1000)} seconds'`);
    /*
     * 집을 수 있는 것은 둘이다:
     *   - 차례가 된 pending
     *   - 임대가 끊긴 running (워커가 죽었다)
     *
     * 되찾을 때도 attempts 를 올리므로, **작업 자체가 프로세스를 죽이는 경우**
     * 무한히 되살아나지 않는다. 한도를 넘긴 것은 아래 reapDead 가 failed 로
     * 끝낸다 — 되찾지 못하는 행을 running 에 남겨 두면 처음 문제로 돌아간다.
     */
    const claimed = await this.db.execute(sql`
      UPDATE queue_jobs SET status = 'running', attempts = attempts + 1, locked_at = now()
      WHERE id = (
        SELECT id FROM queue_jobs
        WHERE name = ${name} AND attempts < max_attempts AND (
          (status = 'pending' AND run_at <= now())
          OR (status = 'running' AND locked_at < now() - ${lease})
        )
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, name, payload, attempts, max_attempts
    `);
    const row = (claimed as unknown as { rows: Array<Record<string, unknown>> }).rows?.[0];
    if (!row) {
      // 집을 것이 없을 때만 청소한다 — 일이 밀려 있으면 일이 먼저다
      await this.reapDead(name);
      return;
    }

    const job: QueueJob<T> = {
      id: row.id as string,
      name: row.name as string,
      payload: row.payload as T,
      attempts: row.attempts as number,
    };
    /*
     * 일하는 동안 임대를 갱신한다. 이것이 없으면 긴 작업은 스스로 만료되어
     * 다른 워커에게 빼앗기고, 같은 메일이 두 번 나간다.
     * `unref()` — 하트비트 하나 때문에 프로세스가 종료되지 못하면 안 된다.
     */
    const beat = setInterval(() => {
      this.db
        .update(queueJobs)
        .set({ lockedAt: new Date() })
        .where(eq(queueJobs.id, job.id))
        .catch(() => { /* 다음 박동이 따라잡는다. 임대 만료보다 훨씬 자주 뛴다 */ });
    }, this.heartbeatMs);
    beat.unref?.();
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
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * 되찾을 수 없는 작업을 끝낸다.
   *
   * 임대가 끊겼는데 시도 횟수를 다 쓴 작업은 claim 조건에 걸리지 않는다.
   * 그대로 두면 'running' 에 영원히 남아, 고치려던 문제로 되돌아간다.
   * 운영자가 관리 화면에서 **실패한 작업**으로 볼 수 있어야 한다.
   *
   * 1초마다 도는 폴링에 매번 붙이지 않는다 — 잡을 것이 거의 없는 질의를
   * 작업 종류 수만큼 매초 돌릴 이유가 없다.
   */
  private lastReap = 0;
  private async reapDead(name: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastReap < 30_000) return;
    this.lastReap = now;
    const lease = sql.raw(`interval '${Math.round(this.leaseMs / 1000)} seconds'`);
    const { rows } = (await this.db.execute(sql`
      UPDATE queue_jobs SET status = 'failed',
        last_error = coalesce(last_error, '작업이 끝나지 않았습니다 — 워커가 중단된 것으로 보입니다 (시도 횟수 소진)')
      WHERE name = ${name} AND status = 'running'
        AND attempts >= max_attempts AND locked_at < now() - ${lease}
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    if (rows?.length) {
      this.logger.warn(`중단된 작업 ${rows.length}건을 실패로 정리했습니다 (${name})`);
    }
  }
}
