#!/usr/bin/env node
/**
 * 큐 하트비트 검증 — 긴 작업을 두 워커가 동시에 폴링해도 **한 번만** 실행되는가.
 *
 * 스모크의 큐 절은 실제 서버에 "죽은 워커가 남긴 행"을 넣어 회수를 본다. 그런데
 * 그 핸들러(메일 발송)는 없는 캠페인 id 를 받아 즉시 끝나므로, **살아서 오래 일하는
 * 작업의 임대를 하트비트가 지키는지**는 거기서 드러나지 않는다. 그것이 가장 위험한
 * 쪽이다: 수만 명 발송은 몇 시간이 걸리고, 임대가 만료되면 다른 워커가 같은 캠페인을
 * 집어 같은 메일을 다시 보낸다.
 *
 * 그래서 임대를 짧게(1초) 줄이고 그보다 네 배 긴 작업을 두 워커에 걸어 둔다.
 * 하트비트가 없으면 이 작업은 네 번 실행된다(역검증에서 실제로 4회였다).
 *
 * 사용법: DATABASE_URL=... node scripts/queue-lease-probe.mjs [하트비트ms] [임대ms]
 * 출력:   "runs=<실행 횟수> status=<최종 상태>"
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { createDb } = await import(`${ROOT}apps/api/node_modules/@brick/database/dist/index.js`);
const { sql } = await import(`${ROOT}apps/api/node_modules/drizzle-orm/index.js`);
const { PostgresQueueProvider } = await import(`${ROOT}apps/api/dist/providers/postgres-queue.provider.js`);

const [hb = 300, lease = 1000] = process.argv.slice(2).map(Number);
const db = createDb(process.env.DATABASE_URL);
const name = `lease-probe-${Date.now()}`;
let runs = 0;
const handler = async () => { runs++; await new Promise((r) => setTimeout(r, lease * 4)); };

// 폴링 100ms — 두 워커가 임대 만료 순간을 놓치지 않을 만큼 촘촘히 본다
const a = new PostgresQueueProvider(db, 100, hb, lease);
const b = new PostgresQueueProvider(db, 100, hb, lease);
await a.enqueue(name, {}, { maxAttempts: 10 });
const stops = [a.process(name, handler), b.process(name, handler)];
await new Promise((r) => setTimeout(r, lease * 6));
stops.forEach((s) => s());

const { rows } = await db.execute(sql`SELECT status FROM queue_jobs WHERE name = ${name}`);
await db.execute(sql`DELETE FROM queue_jobs WHERE name = ${name}`);
console.log(`runs=${runs} status=${rows[0]?.status ?? "없음"}`);
process.exit(0);
