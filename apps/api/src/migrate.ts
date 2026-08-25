import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

/**
 * 코어 마이그레이션 러너.
 * advisory lock으로 다중 컨테이너 동시 부팅에도 안전하다.
 * (drizzle-kit은 개발용, 이 러너는 배포 컨테이너용)
 */
const MIGRATIONS_DIR = resolve(process.env.BRICK_MIGRATIONS_DIR ?? "/app/migrations");
const LOCK_KEY = 7420_0001; // brick core migration lock

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS core_migrations (
        id varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rows } = await client.query("SELECT 1 FROM core_migrations WHERE id = $1", [file]);
      if (rows.length) continue;
      const sqlText = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO core_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
