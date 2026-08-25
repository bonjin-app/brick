import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

const LOCK_KEY = 74200001; // brick core migration advisory lock

export interface MigrationResult {
  applied: string[];
  alreadyUpToDate: boolean;
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
export async function runMigrations(databaseUrl: string, migrationsDir: string): Promise<MigrationResult> {
  const dir = resolve(migrationsDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
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
