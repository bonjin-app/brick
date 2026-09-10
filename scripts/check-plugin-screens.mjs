/**
 * 플러그인이 내는 링크에 화면이 있는지 확인한다.
 *
 * 왜 필요한가: 쪽지 플러그인은 헤더에 "쪽지함"(`/memo`) 링크를 등록해 두었는데
 * 그 경로에 화면을 만드는 곳이 아무 데도 없어서 **모든 회원에게 404 가 보였다.**
 * 블록의 설명문은 "페이지 주소를 'memo' 로 만들면 동작합니다"라고 적고 있었다 —
 * 아무도 만들지 않았다. 메일이 보내는 링크에 화면이 있는지 보는 검사와 같은 종류다.
 *
 * 함께 보는 것:
 *   - 선언 화면이 **코어 정적 라우트**(/login·/account …)와 겹치는가 — 겹치면 Next 의
 *     정적 라우트가 catch-all 보다 우선하므로 그 선언은 절대 렌더되지 않는다
 *   - 같은 경로를 둘이 선언하는가 — 먼저 켜진 쪽만 그려지고, 어느 쪽이 이기는지는
 *     활성화 순서에 달려 사이트마다 달라진다
 *
 * 화면으로 인정하는 것:
 *   - 플러그인이 `registerScreen` 으로 선언한 경로 (하위 경로 포함)
 *   - 스타터가 만드는 페이지 slug (하위 경로 포함 — 페이지는 pathTail 매칭을 한다)
 *   - 코어 웹앱의 정적 라우트 (/account 등)
 *
 * 사용법: node scripts/check-plugin-screens.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** 플러그인이 선언한 화면 경로 — [경로, 플러그인] */
const screens = [];
/** 플러그인이 헤더에 내는 링크 */
const links = [];

for (const name of readdirSync(join(ROOT, "plugins"))) {
  const dir = join("plugins", name, "src");
  try {
    if (!statSync(join(ROOT, dir)).isDirectory()) continue;
  } catch { continue; }
  const src = readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => read(join(dir, f)))
    .join("\n");

  for (const m of src.matchAll(/registerScreen\(\{[^}]*?path:\s*"([^"]+)"/gs)) {
    screens.push({ path: m[1].replace(/^\/+|\/+$/g, ""), plugin: name });
  }
  for (const m of src.matchAll(/registerHeaderAction\(\{[^}]*?path:\s*"([^"]+)"/gs)) {
    links.push({ plugin: name, path: m[1], kind: "헤더" });
  }
}

/** 스타터가 만드는 페이지 slug */
const starters = read("apps/api/src/modules/install/starters.ts");
const pageSlugs = [...starters.matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]);

/** 코어 웹앱의 정적 라우트 */
const webRoutes = readdirSync(join(ROOT, "apps/web/src/app"))
  .filter((f) => !f.startsWith("[") && !f.includes("."));

const covered = [...screens.map((s) => s.path), ...pageSlugs, ...webRoutes];

/** 경로가 화면에 닿는가 — 자기 자신이거나 상위 경로가 화면이면 된다 (pathTail 매칭) */
const reachable = (path) => {
  const segs = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  for (let i = segs.length; i >= 1; i--) {
    if (covered.includes(segs.slice(0, i).join("/"))) return true;
  }
  return false;
};

console.log("▶ 플러그인이 내는 링크에 화면이 있다");
console.log(`  선언 화면 ${screens.length}개 · 스타터 페이지 ${new Set(pageSlugs).size}개 · 코어 라우트 ${webRoutes.length}개`);

let fail = 0;

/*
 * 선언 화면이 **코어 정적 라우트**와 겹치면 그 선언은 죽는다.
 *
 * 공개 사이트는 Next 의 catch-all 이 그리고, `/login`·`/account` 같은 정적 라우트가
 * 그보다 우선한다. 그래서 `path: "account"` 를 선언하면 코어 화면이 이기고 플러그인의
 * 화면은 **절대 렌더되지 않는다** — 저자는 화면을 만들었다고 믿는데 아무도 보지 못한다.
 */
for (const s of screens) {
  const head = s.path.split("/")[0];
  if (webRoutes.includes(head)) {
    console.log(`  ❌ ${s.plugin}: 화면 "${s.path}" 는 코어 라우트 /${head} 에 가려 렌더되지 않습니다`);
    fail++;
  }
}

/*
 * 같은 경로를 둘이 선언하면 먼저 켜진 쪽만 그려진다 — 조용한 가림이다.
 * 어느 쪽이 이기는지는 활성화 순서에 달려 있어 사이트마다 달라진다.
 */
const byPath = new Map();
for (const s of screens) {
  const seen = byPath.get(s.path);
  if (seen) {
    console.log(`  ❌ 화면 "${s.path}" 를 ${seen} 와 ${s.plugin} 가 함께 선언합니다 (먼저 켜진 쪽만 그려집니다)`);
    fail++;
  } else byPath.set(s.path, s.plugin);
}
for (const link of links) {
  if (reachable(link.path)) {
    console.log(`  ✅ ${link.plugin}: ${link.kind} "${link.path}"`);
  } else {
    console.log(`  ❌ ${link.plugin}: ${link.kind} "${link.path}" — 그 경로에 화면이 없습니다`);
    fail++;
  }
}
if (links.length === 0) console.log("  (헤더 링크를 내는 플러그인이 없습니다)");

if (fail > 0) {
  console.log('\nregisterScreen 으로 화면을 선언하거나, 스타터가 그 경로에 페이지를 만들어야 합니다.');
  process.exit(1);
}
console.log("\n모든 링크에 화면이 있습니다.");
