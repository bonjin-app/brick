#!/usr/bin/env node
/**
 * 개발·검증용 PostgreSQL — `pnpm db:dev` (멈추려면 Ctrl+C)
 *
 * 기여자가 처음 만나는 벽이 "PostgreSQL 을 어디서 구하나" 였다. CONTRIBUTING 은 Docker 를
 * 안내했지만 Docker 가 없는 사람(맥에서 Colima·Docker Desktop 을 안 쓰는 개발자)은 거기서 막힌다.
 * 이 스크립트는 **진짜 PostgreSQL 바이너리**를 내려받아 데이터 디렉터리와 함께 띄운다 —
 * SQLite 로 흉내내지 않는다(우리는 jsonb·CTE·advisory lock 을 쓴다).
 *
 *   pnpm db:dev                 :55432 에 띄우고 접속 주소를 알려 준다
 *   pnpm db:dev --reset         데이터를 지우고 새로 초기화한다
 *
 * 데이터는 .dev-db/ 에 남으므로 다시 띄우면 그대로다(.gitignore 에 있다).
 */
import EmbeddedPostgres from "embedded-postgres";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.BRICK_DEV_DB_PORT ?? 55432);
const DIR = resolve(process.env.BRICK_DEV_DB_DIR ?? ".dev-db");
const URL = `postgresql://brick:brick@127.0.0.1:${PORT}/postgres`;

const reset = process.argv.includes("--reset");
if (reset) {
  console.log(`데이터를 지웁니다: ${DIR}`);
  await rm(DIR, { recursive: true, force: true });
}

const pg = new EmbeddedPostgres({
  databaseDir: DIR,
  user: "brick",
  password: "brick",
  port: PORT,
  persistent: true,
});

// initialise() 는 이미 초기화된 디렉터리에서 실패한다 — 처음인지 여부로 갈라 준다
try {
  await pg.initialise();
} catch (err) {
  if (!/exists|not empty|initialised|initialized/i.test(String(err?.message ?? err))) throw err;
}
await pg.start();

console.log(`\n✅ PostgreSQL 준비됨\n`);
console.log(`   export DATABASE_URL=${URL}\n`);
console.log(`   pnpm dev                      개발 서버`);
console.log(`   bash scripts/smoke-test.sh    스모크\n`);
console.log(`(Ctrl+C 로 멈춥니다. 데이터는 ${DIR} 에 남습니다)`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
