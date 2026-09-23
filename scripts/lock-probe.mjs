#!/usr/bin/env node
/**
 * 잠금 공급자 검증 — 잠금 중에 풀의 다른 쿼리가 끼어들어도 **해제가 되는가**,
 * 잡혀 있으면 **두 번째는 들어오지 못하는가**.
 *
 * 전에는 풀에 대고 try_lock 과 unlock 을 따로 보냈다. 그 사이에 쿼리가 하나만 끼어도
 * 해제가 다른 연결로 가서 false 를 돌려주고, 잠금은 원래 연결에 남았다(재 보니 그랬다).
 * 부팅 중에는 요청과 다른 플러그인의 쿼리가 늘 끼어드므로 이것이 기본 상황이다.
 *
 * 출력: "released=<남은 잠금 수> second=<두 번째 시도 결과> after=<해제 뒤 재획득>"
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { createDb } = await import(`${ROOT}apps/api/node_modules/@brick/database/dist/index.js`);
const { sql } = await import(`${ROOT}apps/api/node_modules/drizzle-orm/index.js`);
const { PostgresLockProvider, lockId } = await import(`${ROOT}apps/api/dist/providers/postgres-lock.provider.js`);

const db = createDb(process.env.DATABASE_URL);
const lock = new PostgresLockProvider(db);
const key = `lock-probe-${Date.now()}`;

let second = "not-run";
await lock.withLock(key, async () => {
  // 잠금을 쥔 채로 풀을 바쁘게 만든다 — 해제가 다른 연결로 갈 조건
  await Promise.all([
    db.execute(sql`SELECT pg_sleep(0.2)`),
    db.execute(sql`SELECT pg_sleep(0.2)`),
    (async () => {
      const r = await lock.withLock(key, async () => "entered");
      second = r === null ? "blocked" : String(r);
    })(),
  ]);
  return true;
});
const { rows } = await db.execute(
  sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
      AND ((classid::bigint << 32) | objid::bigint) = ${lockId(key)}::bigint`,
);
const after = await lock.withLock(key, async () => "ok");
console.log(`released=${rows[0].n === 0} second=${second} after=${after}`);
process.exit(0);
