#!/usr/bin/env node
/*
 * 손님 화면의 목록 표가 폰에서 카드로 접히는가.
 *
 * 왜 필요했나: 영어로 쓰는 사이트에서 장바구니를 폰(375px)으로 열면 표가
 * 391px 로 벌어져 문서가 가로로 밀렸다 — 밀려난 자리에 수량 칸과 삭제 버튼이
 * 있다. 한국어에서는 우연히 들어맞아 보이지 않던 문제다("Product/Price/Qty/
 * Total" 이 "상품/단가/수량/합계" 보다 넓다). 상품 이름이 길어지면 어느 언어에서나
 * 밀린다. 관리 화면은 이미 같은 일을 두 번 겪고 `.brick-x-table` 로 막아 두었는데,
 * **손님 화면에는 그 짝이 없었다.**
 *
 * 규칙: 플러그인이 그리는 표 가운데 **머리글(`<thead>`)이 있는 목록 표**는
 *   (가) `brick-stack-table` 을 달거나 (SDK 의 STACK_TABLE_CSS 가 접어 준다),
 *   (나) 그 표에 쓰인 클래스가 `@media(max-width:…)` 규칙에 나타나야 한다
 *        (게시판 목록·쪽지함처럼 스스로 좁은 화면을 따로 그리는 경우).
 * 머리글이 없는 표(주문 상세의 항목 나열 같은 두 칸짜리)는 접을 것이 없다.
 *
 * 사용법: node scripts/check-guest-tables.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS = join(ROOT, "plugins");

console.log("▶ 손님 화면의 목록 표는 좁은 화면에서 카드로 접힌다");

const bad = [];
let tables = 0;

for (const plugin of readdirSync(PLUGINS)) {
  const dir = join(PLUGINS, plugin, "src");
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
  const sources = files.map((f) => [f, readFileSync(f, "utf8")]);

  // 이 플러그인이 좁은 화면용으로 따로 그리는 클래스들
  const responsive = new Set();
  for (const [, src] of sources) {
    for (const m of src.matchAll(/@media\s*\([^)]*max-width[^)]*\)\s*\{/g)) {
      // 중괄호 균형을 세어 미디어 블록의 끝을 찾는다
      let depth = 1, i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      for (const c of src.slice(m.index, i).matchAll(/\.([a-z][a-z0-9-]*)/g)) responsive.add(c[1]);
    }
  }

  for (const [file, src] of sources) {
    for (const m of src.matchAll(/<table\b[^>]*>/g)) {
      const body = src.slice(m.index, m.index + 2500);
      const end = body.indexOf("</table>");
      const markup = end >= 0 ? body.slice(0, end) : body;
      if (!/<thead\b/.test(markup)) continue; // 목록 표가 아니다
      tables++;
      const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((c) => c[1].split(/\s+/)).filter(Boolean);
      if (classes.includes("brick-stack-table")) {
        /*
         * 칸 이름이 있어야 접힌 카드가 제목 없이 값만 나열되지 않는다.
         * 행은 대개 표와 **다른 변수**에서 만들어 붙이므로(`'<tbody>' + rows`)
         * 표 안이 아니라 같은 파일에서 찾는다.
         */
        // `<td … data-label=` 로 본다 — 주석에 적힌 "data-label" 이 단언을 통과시키면 안 된다
        if (!/<t[dh][^>]*data-label=/.test(src)) {
          bad.push(`${file.slice(ROOT.length)}:${src.slice(0, m.index).split("\n").length}  data-label 이 없습니다 — 접히면 제목 없이 값만 나열됩니다`);
        }
        continue;
      }
      if (classes.some((c) => responsive.has(c))) continue;
      const line = src.slice(0, m.index).split("\n").length;
      bad.push(`${file.slice(ROOT.length)}:${line}  ${m[0].slice(0, 60)}`);
    }
  }
}

if (!tables) { console.log("  ❌ 표를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 목록 표: ${tables}개`);
for (const b of bad) console.log(`  ❌ ${b}`);
console.log(bad.length
  ? "\n폰에서 가로로 밀립니다 — brick-stack-table 을 달고 각 <td> 에 data-label 을 주세요."
  : "\n모두 접힙니다.");
process.exit(bad.length ? 1 : 0);
