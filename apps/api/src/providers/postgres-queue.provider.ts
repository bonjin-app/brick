import { Logger } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { queueJobs } from "@brick/database";
import type { QueueProvider, QueueJob, EnqueueOptions, ProcessOptions, QueueFailure } from "@brick/core";
import { isUniqueViolation } from "@brick/core";

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

  /** 끝내 실패했을 때 알릴 곳 — 이름별. process() 가 등록한다 */
  private readonly onFailed = new Map<string, NonNullable<ProcessOptions["onFailed"]>>();

  async enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string> {
    const id = uuidv7();
    const runAt = opts?.delaySeconds ? new Date(Date.now() + opts.delaySeconds * 1000) : new Date();
    const maxAttempts = opts?.maxAttempts ?? 3;
    if (!opts?.dedupeKey) {
      await this.db.insert(queueJobs).values({ id, name, payload: payload as never, maxAttempts, runAt });
      return id;
    }
    /*
     * 같은 키로 대기 중인 것이 있으면 넣지 않는다. 먼저 보고 넣는 방식은 인스턴스 둘이
     * 동시에 부팅하면 둘 다 "없다" 를 보고 둘 다 넣는다 — 유일성은 DB 가 지킨다
     * (0017 의 부분 유니크 인덱스). ON CONFLICT 의 대상은 그 인덱스의 조건과 같아야 한다.
     */
    const inserted = (await this.db.execute(sql`
      INSERT INTO queue_jobs (id, name, payload, max_attempts, run_at, dedupe_key)
      VALUES (${id}, ${name}, ${JSON.stringify(payload ?? null)}::jsonb, ${maxAttempts}, ${runAt}, ${opts.dedupeKey})
      ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    if (inserted.rows?.length) return id;
    const existing = (await this.db.execute(sql`
      SELECT id FROM queue_jobs WHERE dedupe_key = ${opts.dedupeKey} AND status = 'pending' LIMIT 1
    `)) as unknown as { rows: Array<{ id: string }> };
    return existing.rows?.[0]?.id ?? id;
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>, opts?: ProcessOptions<T>): () => void {
    if (opts?.onFailed) this.onFailed.set(name, opts.onFailed as NonNullable<ProcessOptions["onFailed"]>);
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
      this.onFailed.delete(name);
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
      maxAttempts: row.max_attempts as number,
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
      const failedFinally = job.attempts >= job.maxAttempts;
      const error = String(err).slice(0, 2000);
      try {
        await this.db
          .update(queueJobs)
          .set({
            status: failedFinally ? "failed" : "pending",
            lastError: error,
            runAt: new Date(Date.now() + 2 ** job.attempts * 1000), // 지수 백오프
          })
          .where(and(eq(queueJobs.id, job.id), lte(queueJobs.attempts, job.maxAttempts)));
      } catch (updateErr) {
        /*
         * 재시도로 되돌리려는데 같은 dedupe 키의 작업이 이미 대기 중이다(그 사이 부팅이
         * 사슬을 다시 심었다). 대기 중인 것은 하나만 둔다는 약속을 지키려면 이쪽이
         * 물러나야 한다 — 같은 일을 하는 작업이 곧 돈다.
         */
        if (!isUniqueViolation(updateErr)) throw updateErr;
        await this.db.update(queueJobs)
          .set({ status: "merged", lastError: `${error}\n(대기 중인 같은 작업에 합쳐짐)` })
          .where(eq(queueJobs.id, job.id));
        return;
      }
      if (failedFinally) await this.notifyFailed(job, error);
    } finally {
      clearInterval(beat);
    }
  }

  /** 끝내 실패한 작업을 그 주인에게 알린다. 알림이 실패해도 폴링은 계속한다 */
  private async notifyFailed<T>(job: QueueJob<T>, error: string): Promise<void> {
    const hook = this.onFailed.get(job.name);
    if (!hook) return;
    try {
      await hook(job as QueueJob<unknown>, error);
    } catch (err) {
      this.logger.warn(`실패 처리기 오류 (${job.name}): ${String(err)}`);
    }
  }

  /**
   * 되찾을 수 없는 작업을 끝낸다.
   *
   * 임대가 끊겼는데 시도 횟수를 다 쓴 작업은 claim 조건에 걸리지 않는다.
   * 그대로 두면 'running' 에 영원히 남아, 고치려던 문제로 되돌아간다.
   * (실패한 작업을 운영자에게 보여 주는 화면은 **아직 없다** — last_error 는
   * DB 와 이 경고 로그에만 남는다. roadmap 의 열린 항목이다.)
   *
   * 1초마다 도는 폴링에 매번 붙이지 않는다 — 잡을 것이 거의 없는 질의를
   * 작업 종류 수만큼 매초 돌릴 이유가 없다.
   */
  /*
   * 이름별로 센다. 처음에는 필드 하나였는데, 그러면 30초마다 **가장 먼저 도착한
   * 이름 하나만** 청소되고 나머지 이름은 계속 건너뛰어진다 — 폴링 주기가 같으므로
   * 매번 같은 이름이 이긴다.
   */
  private readonly lastReap = new Map<string, number>();
  private async reapDead(name: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastReap.get(name) ?? 0) < 30_000) return;
    this.lastReap.set(name, now);
    const lease = sql.raw(`interval '${Math.round(this.leaseMs / 1000)} seconds'`);
    const { rows } = (await this.db.execute(sql`
      UPDATE queue_jobs SET status = 'failed',
        last_error = coalesce(last_error, '작업이 끝나지 않았습니다 — 워커가 중단된 것으로 보입니다 (시도 횟수 소진)')
      WHERE name = ${name} AND status = 'running'
        AND attempts >= max_attempts AND locked_at < now() - ${lease}
      RETURNING id, name, payload, attempts, max_attempts, last_error
    `)) as unknown as { rows: Array<Record<string, unknown>> };
    if (!rows?.length) return;
    this.logger.warn(`중단된 작업 ${rows.length}건을 실패로 정리했습니다 (${name})`);
    // 마지막 시도 중에 워커가 죽은 경우다 — 핸들러의 catch 로는 알 수 없으므로 여기서 알린다
    for (const r of rows) {
      await this.notifyFailed(
        { id: String(r.id), name: String(r.name), payload: r.payload,
          attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts) },
        String(r.last_error ?? ""),
      );
    }
  }

  /**
   * 끝난 작업 기록을 지운다 — 주기 작업만으로 하루 수백 행이 쌓이는데 아무도 지우지 않았다.
   *
   * 성공은 7일(무슨 일이 있었는지 볼 여유), 실패와 합쳐진 것은 30일(운영자가 대시보드에서
   * 보고 원인을 찾을 여유). **대기·실행 중인 것은 절대 지우지 않는다** — 오래전에 만든
   * 예약 작업도 아직 할 일이다. 기준 시각은 locked_at 이다: 끝난 작업은 모두 한 번은
   * 집혔으므로 값이 있고, queue_lease_idx(status, locked_at)를 그대로 쓴다.
   */
  async prune(): Promise<number> {
    const { rows } = (await this.db.execute(sql`
      DELETE FROM queue_jobs
      WHERE (status = 'done' AND locked_at < now() - interval '7 days')
         OR (status IN ('failed', 'merged') AND locked_at < now() - interval '30 days')
      RETURNING id
    `)) as unknown as { rows: unknown[] };
    return rows?.length ?? 0;
  }

  /** 최근 끝내 실패한 작업 — 이름별 건수와 가장 최근의 이유 */
  async recentFailures(days = 7): Promise<QueueFailure[]> {
    const span = sql.raw(`interval '${Math.max(1, Math.floor(days))} days'`);
    const { rows } = (await this.db.execute(sql`
      SELECT name, count(*)::int AS n, max(locked_at) AS last_at,
             (array_agg(last_error ORDER BY locked_at DESC))[1] AS last_error
      FROM queue_jobs
      WHERE status = 'failed' AND locked_at > now() - ${span}
      GROUP BY name
      ORDER BY max(locked_at) DESC
    `)) as unknown as { rows: Array<Record<string, unknown>> };
    return (rows ?? []).map((r) => ({
      name: String(r.name),
      count: Number(r.n),
      lastError: r.last_error == null ? null : String(r.last_error),
      lastAt: r.last_at ? new Date(String(r.last_at)) : null,
    }));
  }
}
