#!/usr/bin/env node
/*
 * 스모크가 **미래 날짜를 못박아 두지 않았는가**.
 *
 * 왜 필요했나: 판매 리포트 수트가 주문의 결제 시각을 `2026-09-15` 로 적어 두고
 * 그 하루만 조회해 금액을 단언하고 있었다. 적을 때는 먼 미래라 안전했다.
 * **그날이 오자** 수트가 그날 만든 다른 주문들과 같은 버킷에 섞여 순매출이
 * 어긋났다(기대 20000, 실제 56000). 내가 건드리지 않은 수트가 CI 에서 갑자기
 * 빨개진 이유가 그것이었다 — 코드가 바뀐 것이 아니라 날짜가 도착한 것이다.
 *
 * 검사하는 것은 **하루짜리 창**뿐이다:
 *   - `paid_at='YYYY-MM-DD …'` 처럼 시각을 심는 리터럴
 *   - `from=X&to=X` 처럼 같은 날 하루만 조회하는 창
 *
 * 범위의 끝(`to=2026-12-31`)은 보지 않는다 — 미래여도 해롭지 않고, 오히려
 * "지금까지 전부"를 뜻하는 흔한 표현이다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const today = new Date();
today.setHours(0, 0, 0, 0);

const parse = (y, m, d) => {
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  return dt.getFullYear() === Number(y) && dt.getMonth() === Number(m) - 1 && dt.getDate() === Number(d) ? dt : null;
};

let checked = 0;
const bad = [];
for (const name of readdirSync(join(ROOT, "scripts"))) {
  if (!name.endsWith(".sh")) continue;
  const rel = `scripts/${name}`;
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  lines.forEach((line, i) => {
    // 시각을 심는 리터럴
    for (const m of line.matchAll(/_at\s*=\s*'(\d{4})-(\d{2})-(\d{2})/g)) {
      checked++;
      const d = parse(m[1], m[2], m[3]);
      if (d && d >= today) bad.push([`${rel}:${i + 1}`, `${m[1]}-${m[2]}-${m[3]}`, "심는 시각이 오늘이거나 미래입니다"]);
    }
    // 하루짜리 조회 창
    for (const m of line.matchAll(/from=(\d{4})-(\d{2})-(\d{2})&to=(\d{4})-(\d{2})-(\d{2})/g)) {
      if (`${m[1]}${m[2]}${m[3]}` !== `${m[4]}${m[5]}${m[6]}`) continue;
      checked++;
      const d = parse(m[1], m[2], m[3]);
      if (d && d >= today) bad.push([`${rel}:${i + 1}`, `${m[1]}-${m[2]}-${m[3]}`, "하루짜리 조회 창이 오늘이거나 미래입니다"]);
    }
  });
}

console.log("▶ 스모크가 미래 날짜를 못박아 두지 않았다");
if (!checked) { console.log("  ❌ 날짜 리터럴을 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
const todayLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
console.log(`  ✅ 검사한 날짜: ${checked}건 (오늘 ${todayLabel} 기준)`);
for (const [where, date, why] of bad) console.log(`  ❌ ${where}  ${date} — ${why}`);
console.log(bad.length
  ? "\n그날이 오면 수트가 깨집니다 — 코드가 바뀌지 않았는데 CI 가 빨개집니다. 지난 날로 적으세요."
  : "\n모두 지난 날입니다.");
process.exit(bad.length ? 1 : 0);
