/**
 * 문서가 세는 숫자를 실제와 대조한다.
 *
 * 왜 필요한가: 문서의 숫자는 조용히 썩는다. 수트를 늘려도 README 의 표는 그대로고,
 * 플러그인을 더해도 저장소 구조는 다섯 개로 남는다. 그리고 **틀린 숫자는 틀린
 * 설명보다 발견되기 어렵다** — 읽는 사람은 그것이 사실인지 셀 방법이 없다.
 *
 * 실제로 이 검사가 만들어지기 전까지: 스모크 표가 아홉 수트에서 어긋나 있었고,
 * 저장소 구조는 플러그인 여덟 개를 다섯 개로, 테마 다섯 벌을 두 벌로 적고 있었으며,
 * 스모크 종류는 34종을 9종으로 적고 있었다.
 *
 * 세는 것: 스모크 수트 수·항목 합계·배지, 플러그인 수, 테마 수, 정적 검사 수.
 * 항목 합계는 표 자체의 합이므로 **표가 총계의 유일한 출처**라는 규칙을 지킨다
 * (개별 숫자가 맞는지는 수트를 돌려야 알 수 있고, 그것은 CI 가 한다).
 *
 * 사용법: node scripts/check-doc-counts.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const dirs = (p) => readdirSync(join(ROOT, p)).filter((d) => {
  try { return statSync(join(ROOT, p, d)).isDirectory(); } catch { return false; }
});

const smokeFiles = readdirSync(join(ROOT, "scripts")).filter((f) => /^smoke-.*\.sh$/.test(f));
const checkFiles = readdirSync(join(ROOT, "scripts")).filter((f) => /^check-.*\.mjs$/.test(f));
const plugins = dirs("plugins");
const themes = dirs("themes");

const rows = [...readme.matchAll(/\| `(smoke-[a-z0-9-]+\.sh)` \| (\d+) \|/g)];
const rowTotal = rows.reduce((n, m) => n + Number(m[2]), 0);

const claims = [
  ["스모크 표의 행 수", rows.length, smokeFiles.length, "README 표에 빠진 수트가 있습니다"],
  [
    "배지의 항목 수",
    Number((readme.match(/E2E-(\d+)%20passing/) ?? [])[1] ?? -1),
    rowTotal,
    "배지와 표의 합이 다릅니다",
  ],
  [
    "본문의 항목 수",
    Number(((readme.match(/\(총 ([\d,]+)개 항목\)/) ?? [])[1] ?? "-1").replace(/,/g, "")),
    rowTotal,
    "본문 총계와 표의 합이 다릅니다",
  ],
  [
    "저장소 구조의 스모크 종류",
    Number((readme.match(/스모크 테스트 (\d+)종/) ?? [])[1] ?? -1),
    smokeFiles.length,
    "저장소 구조의 수트 수가 실제와 다릅니다",
  ],
  [
    "저장소 구조의 정적 검사 수",
    Number((readme.match(/정적 검사 (\d+)종/) ?? [])[1] ?? -1),
    checkFiles.length,
    "정적 검사 수가 실제와 다릅니다",
  ],
];

/** 저장소 구조 블록에 플러그인·테마가 모두 적혀 있는가 */
const missingPlugins = plugins.filter((p) => !readme.includes(`  ${p}/`));
const missingThemes = themes.filter((t) => !readme.includes(`  ${t}/`));

console.log("▶ 문서의 숫자가 실제와 맞는다");
let fail = 0;
for (const [label, claimed, actual, why] of claims) {
  if (claimed === actual) {
    console.log(`  ✅ ${label}: ${actual}`);
  } else {
    console.log(`  ❌ ${label}: 문서 ${claimed} · 실제 ${actual} — ${why}`);
    fail++;
  }
}
for (const [label, missing, all] of [["플러그인", missingPlugins, plugins], ["테마", missingThemes, themes]]) {
  if (missing.length) {
    console.log(`  ❌ 저장소 구조에 빠진 ${label}: ${missing.join(", ")} (전체 ${all.length}개)`);
    fail++;
  } else {
    console.log(`  ✅ 저장소 구조의 ${label} ${all.length}개 모두 적혀 있다`);
  }
}

if (fail > 0) {
  console.log("\n숫자는 조용히 썩습니다 — 늘렸으면 문서도 같이 고치세요.");
  process.exit(1);
}
console.log("\n모두 맞습니다.");
