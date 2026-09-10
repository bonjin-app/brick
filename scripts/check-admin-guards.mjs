/**
 * 플러그인의 관리 라우트가 **스스로** 권한을 정하는지 확인한다.
 *
 * 층이 둘이다.
 *  - 디스패처(plugins.controller)가 `/admin/*` 에 운영자(manager) 이상을 요구한다.
 *    저자가 잊어도 열리지 않게 하는 바닥이다.
 *  - 핸들러는 그보다 좁힐 수 있다. 상품·쿠폰·환불처럼 admin 만 해야 하는 일은
 *    자기 줄에서 다시 막아야 한다 — 바닥은 manager 까지 통과시킨다.
 *
 * 이 검사는 두 번째 층을 본다: 관리 라우트가 역할에 대해 **명시적으로** 결정했는가.
 * 아무 검사도 없으면 그 라우트는 "운영자면 누구나"가 되는데, 그것이 의도였는지
 * 잊은 것인지 코드만 보고는 알 수 없다.
 *
 * 사용법: node scripts/check-admin-guards.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 역할을 명시적으로 결정하는 표현 — 헬퍼 호출이거나 role 을 직접 비교하거나 */
const DECIDES = /require(Admin|Manager|Staff|Owner)\s*\(|hasRole\s*\(|user\??\.role\s*(!==|===)|rankOf\s*\(/;

let fail = 0;
console.log("▶ 플러그인 관리 라우트는 스스로 권한을 정한다");

for (const name of readdirSync(join(ROOT, "plugins"))) {
  const file = join(ROOT, "plugins", name, "src", "index.ts");
  try {
    if (!statSync(file).isFile()) continue;
  } catch { continue; }

  const src = readFileSync(file, "utf8");
  // registerRoute 호출 단위로 자른다 — 다음 호출까지가 그 핸들러 본문이다
  const chunks = src.split("ctx.registerRoute(").slice(1);
  const missing = [];
  let total = 0;

  for (const chunk of chunks) {
    const m = /^\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)"/.exec(chunk);
    if (!m) continue;
    const [, method, path] = m;
    if (path !== "/admin" && !path.startsWith("/admin/")) continue;
    total++;
    if (!DECIDES.test(chunk)) missing.push(`${method} ${path}`);
  }

  if (total === 0) continue;
  if (missing.length) {
    console.log(`  ❌ ${name}: ${missing.length}/${total} 개가 권한을 정하지 않습니다`);
    for (const r of missing) console.log(`     - ${r}`);
    fail++;
  } else {
    console.log(`  ✅ ${name}: 관리 라우트 ${total}개 모두 명시`);
  }
}

if (fail > 0) {
  console.log("\n관리 라우트는 자기 줄에서 역할을 정해야 합니다 (디스패처는 manager 까지 통과시킵니다).");
  process.exit(1);
}
console.log("\n모두 명시되어 있습니다.");
