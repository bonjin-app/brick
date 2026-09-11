/**
 * README 의 스모크 표가 **실측**인가.
 *
 * check-doc-counts.mjs 는 표의 내부 일관성만 본다(행 수·합계·배지). 각 행의
 * 숫자가 그 수트를 실제로 돌렸을 때 나오는 값인지는 아무도 보지 않았다 —
 * 단언을 더해도 그 줄을 고치는 사람이 없으면 표는 조용히 낡는다. 실제로
 * 이번 라운드에만 tax(110→112)와 shop(256→258)이 어긋나 있었고, 그것을
 * 알아차린 것은 우연히 그 수트를 돌려 봤기 때문이다.
 *
 * 각 수트는 끝에서 `BRICK_SMOKE_LOG` 가 설정돼 있으면 "<파일> <통과> <실패>"
 * 한 줄을 덧붙인다. CI 는 그 파일을 이 검사에 넘긴다.
 *
 * 로그에 없는 수트는 **건너뛴다**(그 실행에서 돌지 않은 것뿐이다). 다만
 * 하나도 없으면 무언가 잘못 연결된 것이므로 실패시킨다 — 아무것도 보지 않는
 * 검사가 통과하는 것이 가장 나쁘다.
 *
 * 사용법: node scripts/check-smoke-counts.mjs <로그파일>
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const logPath = process.argv[2];
if (!logPath) {
  console.error("사용법: node scripts/check-smoke-counts.mjs <로그파일>");
  process.exit(2);
}

let log;
try {
  log = readFileSync(logPath, "utf8");
} catch {
  console.error(`로그 파일을 읽을 수 없습니다: ${logPath}`);
  process.exit(2);
}

/** 같은 수트가 여러 번 돌면 마지막 것을 쓴다 */
const actual = new Map();
for (const line of log.split("\n")) {
  const m = line.trim().match(/^(smoke-[a-z0-9-]+\.sh)\s+(\d+)\s+(\d+)$/);
  if (m) actual.set(m[1], { pass: Number(m[2]), fail: Number(m[3]) });
}

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const claimed = new Map(
  [...readme.matchAll(/\| `(smoke-[a-z0-9-]+\.sh)` \| (\d+) \|/g)].map((m) => [m[1], Number(m[2])]),
);

console.log("▶ README 의 스모크 표가 실측과 같다");
if (actual.size === 0) {
  console.log("  ❌ 실측 기록이 하나도 없습니다 — BRICK_SMOKE_LOG 가 전달되지 않았습니다");
  process.exit(1);
}

let fail = 0;
for (const [suite, { pass, fail: failed }] of [...actual].sort()) {
  const want = claimed.get(suite);
  if (want === undefined) {
    console.log(`  ❌ ${suite}: 돌았는데 README 표에 행이 없습니다`);
    fail++;
  } else if (failed > 0) {
    console.log(`  ·  ${suite}: 실패가 있어 개수는 비교하지 않습니다 (${pass} 통과 / ${failed} 실패)`);
  } else if (want !== pass) {
    console.log(`  ❌ ${suite}: README ${want} · 실측 ${pass}`);
    fail++;
  } else {
    console.log(`  ✅ ${suite}: ${pass}`);
  }
}

const notRun = [...claimed.keys()].filter((s) => !actual.has(s));
if (notRun.length) console.log(`  · 이 실행에서 돌지 않은 수트 ${notRun.length}개는 건너뜁니다`);

if (fail > 0) {
  console.log("\n표는 총계의 유일한 출처입니다 — 단언을 더했으면 그 줄도 고치세요.");
  process.exit(1);
}
console.log("\n표가 실측과 같습니다.");
