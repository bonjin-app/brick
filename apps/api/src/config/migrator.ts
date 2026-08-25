import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

const LOCK_KEY = 74200001; // brick core migration advisory lock

export interface MigrationResult {
  applied: string[];
  alreadyUpToDate: boolean;
}

/**
 * 마이그레이션 락 획득.
 *
 * `pg_advisory_lock` 은 다른 세션이 락을 쥐고 있으면 **무한 대기**한다.
 * 이전 인스턴스가 마이그레이션 중 비정상 종료해 커넥션이 남아 있으면
 * 부팅이 아무 로그도 없이 멈춘다 — 운영자가 원인을 알 수 없다.
 *
 * 그래서 try 버전을 폴링하고, 제한 시간을 넘기면 명확한 에러로 실패시킨다.
 */
async function acquireLock(
  client: pg.Client,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [LOCK_KEY],
    );
    if (rows[0]?.locked) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `마이그레이션 락을 ${Math.round(timeoutMs / 1000)}초 안에 얻지 못했습니다.\n` +
          `  다른 인스턴스가 마이그레이션 중이거나, 이전 프로세스가 락을 쥔 채 남아 있습니다.\n` +
          `  확인: SELECT pid, state, query FROM pg_stat_activity WHERE datname = current_database();\n` +
          `  해제: SELECT pg_terminate_backend(<pid>);`,
      );
    }
    if (!notified) {
      log("다른 인스턴스가 마이그레이션 중입니다 — 락을 기다립니다...");
      notified = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 코어 마이그레이션 러너.
 *
 * 설계:
 *  - **부팅 시 자동 실행**된다. 사용자가 별도 명령을 외울 필요가 없다
 *    (`docker compose pull && up -d` 만으로 업데이트가 완결된다).
 *  - advisory lock으로 다중 인스턴스 동시 부팅에도 한 번만 적용된다.
 *  - 각 마이그레이션은 트랜잭션 안에서 실행된다 — 실패 시 부분 적용이 남지 않는다.
 *  - 실패하면 예외를 던진다. 깨진 스키마로 서버가 뜨는 것이 더 위험하다.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsDir: string,
  opts: { connectTimeoutMs?: number; lockTimeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dir = resolve(migrationsDir);
  const log = opts.log ?? (() => undefined);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const lockTimeoutMs = opts.lockTimeoutMs ?? 60_000;

  // 연결 타임아웃이 없으면 DB에 닿지 않을 때 부팅이 조용히 멈춘다.
  // (방화벽, 잘못된 호스트, DB 미기동 — 운영에서 흔한 상황)
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `데이터베이스에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}\n` +
        `  DATABASE_URL 또는 설정 파일의 접속 정보를 확인하세요.`,
    );
  }
  const applied: string[] = [];

  try {
    await acquireLock(client, lockTimeoutMs, log);
    await client.query(`
      CREATE TABLE IF NOT EXISTS core_migrations (
        id varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    if (!files.length) throw new Error(`no migration files found in ${dir}`);

    const { rows } = await client.query<{ id: string }>("SELECT id FROM core_migrations");
    const done = new Set(rows.map((r) => r.id));

    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO core_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration "${file}" failed: ${String(err)}`);
      }
    }
    return { applied, alreadyUpToDate: applied.length === 0 };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
