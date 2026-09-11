/**
 * "오늘"을 사이트 시간대로 세는가.
 *
 * `date_trunc('day', now())` 는 **UTC 자정**으로 자른다. 한국에서 그것은 오전
 * 9시다 — "오늘 주문", "하루 발송 한도", "오늘 방문자"가 전부 아침 9시에
 * 바뀐다는 뜻이고, 그 사이에 일어난 일은 어제 것과 같은 칸에 들어간다.
 *
 * 실제로 쪽지의 하루 한도가 그랬다: 한도를 다 쓴 사람은 자정이 아니라 아침
 * 9시에 풀리고, 아침에 보낸 쪽지는 25시간 전 것과 같은 날로 묶였다. 다른
 * "오늘"(매출·게시글·방문 집계)은 전부 SITE_TZ 를 쓰고 있었으므로, 같은 사이트
 * 안에서 날짜 경계가 두 벌이었다.
 *
 * 규칙: `date_trunc('day'|'week'|'month'|'year', ...)` 이 있는 줄(또는 그 구문)
 * 에는 SITE_TZ 가 함께 있어야 한다. 시간대를 미리 적용해 둔 변수를 쓰는 경우도
 * 있으므로(brick-site 의 TODAY) 같은 구문 안에서 찾는다.
 *
 * 사용법: node scripts/check-site-timezone.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const files = [join(ROOT, "apps/api/src"), join(ROOT, "packages"), join(ROOT, "plugins")].flatMap((r) => walk(r));

console.log("▶ \"오늘\"은 사이트 시간대로 센다");
const bad = [];
let checked = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  // 줄 단위로 보되, 여러 줄에 걸친 SQL 이 흔하므로 앞뒤 한 줄까지 함께 본다
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!/date_trunc\(/.test(line)) return;
    if (/^\s*(\*|\/\/)/.test(line)) return;            // 주석 안의 설명
    checked++;
    const around = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join("\n");
    if (/SITE_TZ|AT TIME ZONE|\$\{TODAY\}/.test(around)) return;
    bad.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim().slice(0, 72)}`);
  });
}

if (bad.length) {
  for (const b of bad) console.log(`  ❌ ${b}`);
  console.log(`\n${bad.length}곳이 UTC 자정으로 자릅니다 — 한국에서는 아침 9시입니다.`);
  process.exit(1);
}
console.log(`  ✅ date_trunc ${checked}곳이 모두 사이트 시간대를 쓴다`);
