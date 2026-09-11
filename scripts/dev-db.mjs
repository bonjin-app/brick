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
import { createConnection } from "node:net";

const PORT = Number(process.env.BRICK_DEV_DB_PORT ?? 55432);
const DIR = resolve(process.env.BRICK_DEV_DB_DIR ?? ".dev-db");
const URL = `postgresql://brick:brick@127.0.0.1:${PORT}/postgres`;

const reset = process.argv.includes("--reset");
if (reset) {
  console.log(`데이터를 지웁니다: ${DIR}`);
  await rm(DIR, { recursive: true, force: true });
}

/**
 * 먼저 포트를 확인한다.
 *
 * 이미 뭔가 듣고 있는데 그대로 start() 하면 postmaster 가 "lock file
 * postmaster.pid already exists" 로 죽는데, embedded-postgres 는 그 실패를
 * **빈 값으로** 거절한다 — 그래서 화면에는 `undefined` 한 줄만 남고 무엇을
 * 해야 할지 알 수 없었다. 실제로 여러 번 그렇게 막혔다.
 */
if (await inUse(PORT)) {
  console.error(`\n❌ :${PORT} 를 이미 무언가 쓰고 있습니다.`);
  console.error(`
전에 띄운 개발 DB 가 아직 살아 있을 가능성이 큽니다. 확인하고 정리하세요:

  lsof -nP -iTCP:${PORT}      무엇이 쓰는지 본다
  pkill -f postgres            이전 개발 DB 를 멈춘다

이미 쓸 수 있는 DB 라면 그대로 쓰면 됩니다:

  export DATABASE_URL=${URL}
`);
  process.exit(1);
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
try {
  await pg.start();
} catch (err) {
  const detail = String(err?.message ?? err ?? "").trim();
  console.error(`\n❌ PostgreSQL 을 띄우지 못했습니다.${detail && detail !== "undefined" ? ` (${detail})` : ""}`);
  console.error(`
데이터 디렉터리(${DIR})가 어중간한 상태일 때 이렇게 됩니다 — 초기화가 중간에
끊겼거나, 이전 프로세스가 잠금 파일을 남겼거나. **개발용 데이터**이므로 지우고
다시 만드는 것이 가장 빠릅니다:

  pkill -f postgres
  node scripts/dev-db.mjs --reset

위에 출력된 initdb·postmaster 메시지에 실제 원인이 적혀 있습니다.
`);
  process.exit(1);
}

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

/** 그 포트에 이미 듣고 있는 것이 있는가 */
function inUse(port) {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v) => { sock.destroy(); res(v); };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}
