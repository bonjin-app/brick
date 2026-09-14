/**
 * 관리 화면의 표가 좁은 화면에서 카드로 접히는가.
 *
 * 관리 셸은 `@media (max-width: 767.98px)` 에서 `.brick-x-table` 을 카드로
 * 접는다. 그것을 쓰지 않는 표는 폰에서 가로로 밀려나고, **밀려난 자리에 있던
 * 버튼은 닿을 수 없다** — 보이지 않는 버튼은 없는 버튼이다.
 *
 * 실제로 두 번 겪었다. 주문 목록에서는 상태·금액·수정 버튼이 오른쪽으로
 * 밀려 있었고(그때 선언형 리소스 표만 고쳤다), 플러그인 화면에서는 375px 에서
 * 표가 982px 로 벌어져 켜기·끄기 버튼 여덟 개가 전부 화면 밖에 있었다 —
 * 장애 때 플러그인 하나를 꺼 보는 것은 폰에서도 하는 일이다.
 *
 * 규칙: 관리 화면(`app/admin/**`)의 `<table` 에는 `brick-x-table` 이 있어야
 * 한다. 칸 이름(`data-label`)은 접혔을 때 제목 자리가 되므로 함께 본다 —
 * 없으면 카드가 값만 나열한 줄이 된다.
 *
 * 사용법: node scripts/check-admin-tables.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ADMIN = join(ROOT, "apps/web/src/app/admin");

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

console.log("▶ 관리 화면의 표는 좁은 화면에서 카드로 접힌다");
const bad = [];
let tables = 0;
for (const file of walk(ADMIN)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!/<table[\s>]/.test(line)) return;
    tables++;
    const where = `${file.slice(ROOT.length)}:${i + 1}`;
    if (!/brick-x-table/.test(line)) {
      bad.push(`${where}  className 에 brick-x-table 이 없습니다 — 폰에서 가로로 밀립니다`);
      return;
    }
    // 이 표의 본문에 data-label 이 하나라도 있는가 (표 끝까지 훑는다)
    const rest = lines.slice(i, i + 120).join("\n");
    const body = rest.slice(0, rest.indexOf("</table>") + 1 || rest.length);
    if (!/data-label/.test(body)) {
      bad.push(`${where}  칸에 data-label 이 없습니다 — 접히면 제목 없이 값만 나열됩니다`);
    }
  });
}

if (bad.length) {
  for (const b of bad) console.log(`  ❌ ${b}`);
  console.log(`\n관리 화면의 표 ${tables}개 중 ${bad.length}곳이 폰에서 읽거나 누를 수 없습니다.`);
  process.exit(1);
}
console.log(`  ✅ 관리 화면의 표 ${tables}개가 모두 카드로 접힌다`);
