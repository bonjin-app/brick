#!/usr/bin/env node
/**
 * 한 사람 한 계정이 **동시에** 들어와도 지켜지는가 — 실제 DB 로.
 *
 * 스모크는 HTTP 로 여러 계정을 한꺼번에 보내지만, 요청이 앞단(요청 한도·공급자 조회)에서
 * 줄지어 들어와 "다른 계정 없음 → 저장" 사이의 몇 ms 짜리 틈이 좀처럼 겹치지 않는다. 사람 단위
 * 잠금을 빼도 스모크가 세 번에 한 번만 잡았다. 여기서는 서비스를 직접, 같은 순간에 부른다.
 *
 *   concurrent: 같은 사람(CI)으로 20 계정이 동시에 인증을 끝내도 저장되는 것은 하나
 *
 * 출력: "concurrent=<인증된 계정 수>"
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { createDb } = await import(`${ROOT}apps/api/node_modules/@brick/database/dist/index.js`);
const { sql } = await import(`${ROOT}apps/api/node_modules/drizzle-orm/index.js`);
const { IdentityService } = await import(`${ROOT}apps/api/dist/modules/identity/identity.service.js`);

const db = createDb(process.env.DATABASE_URL);
const svc = new IdentityService(db, { secret: "identity-race-probe" });
const tag = `probe${Date.now()}`;
const N = 20;

// 공급자는 즉시 같은 사람을 돌려준다 — 조회 시간이 없으니 틈이 가장 좁게 겹친다
svc.setProvider("probe", {
  name: "probe",
  displayName: "probe",
  clientScript: "",
  isReady: async () => true,
  verify: async () => ({ ok: true, person: { ci: `CI-${tag}`, name: "x", birthDate: "1990-01-01" } }),
});

const { rows: before } = await db.execute(sql`SELECT value FROM site_settings WHERE key = 'member.one_person_one_account'`);
await db.execute(sql`
  INSERT INTO site_settings (key, value) VALUES ('member.one_person_one_account', 'true'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb
`);

const users = [];
for (let i = 0; i < N; i++) {
  const { rows } = await db.execute(sql`
    INSERT INTO users (id, email, password_hash, display_name) VALUES (gen_random_uuid(), ${`${tag}-${i}@probe.invalid`}, 'x', 'probe')
    RETURNING id
  `);
  const userId = String(rows[0].id);
  const started = await svc.start(userId, "probe");
  users.push({ userId, requestId: started.requestId });
}

const results = await Promise.all(users.map((u) => svc.complete(u.userId, u.requestId)));
const concurrent = results.filter((r) => r.ok).length;

await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${tag}-%`}`);
if (before.length) {
  await db.execute(sql`UPDATE site_settings SET value = ${JSON.stringify(before[0].value)}::jsonb WHERE key = 'member.one_person_one_account'`);
} else {
  await db.execute(sql`DELETE FROM site_settings WHERE key = 'member.one_person_one_account'`);
}
console.log(`concurrent=${concurrent}`);
process.exit(0);
