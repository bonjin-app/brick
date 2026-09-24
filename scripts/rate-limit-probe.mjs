#!/usr/bin/env node
/**
 * 요청 제한(DB 판)이 약속을 지키는가 — 실제 DB 로.
 *
 *   exhausted : 한도를 채우면 막힌다
 *   after21m  : 60분 창 버킷은 21분 뒤에도 막혀 있다. 메모리 판은 정리가 **호출한 쪽의
 *               창**으로 판단해서, 15분 창 요청이 정리를 부르면 60분 한도가 21분에 풀렸다.
 *               (시간은 기록을 21분 전으로 옮겨 흉내 낸다)
 *   concurrent: 동시에 20번 세어도 한도(5)만큼만 허용된다 — 세기와 확인이 원자적이어야 한다.
 *               서버가 여러 대여도 같은 DB 에 세므로 이것이 곧 "여러 대여도 한도는 하나" 다.
 *
 * 출력: "exhausted=… after21m=… concurrent=<허용 수>"
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { createDb } = await import(`${ROOT}apps/api/node_modules/@brick/database/dist/index.js`);
const { sql } = await import(`${ROOT}apps/api/node_modules/drizzle-orm/index.js`);
const { RateLimitService } = await import(`${ROOT}apps/api/dist/modules/auth/rate-limit.service.js`);

const db = createDb(process.env.DATABASE_URL);
const rl = new RateLimitService(db);
const tag = `probe-${Date.now()}`;
const H = 60 * 60_000, Q = 15 * 60_000;

const reset = `reset-submit:${tag}`;
for (let i = 0; i < 20; i++) await rl.consume(reset, 20, H);
const exhausted = !(await rl.check(reset, 20, H)).allowed;
await db.execute(sql`UPDATE rate_limit_hits SET hit_at = hit_at - interval '21 minutes' WHERE key = ${reset}`);
await rl.consume(`login:${tag}`, 10, Q);   // 15분 창 요청
const after = !(await rl.check(reset, 20, H)).allowed;

const burst = `burst:${tag}`;
const results = await Promise.all(Array.from({ length: 20 }, () => rl.consume(burst, 5, Q)));
const concurrent = results.filter((r) => r.allowed).length;

await db.execute(sql`DELETE FROM rate_limit_hits WHERE key LIKE ${`%${tag}%`}`);
console.log(`exhausted=${exhausted} after21m=${after} concurrent=${concurrent}`);
process.exit(0);
