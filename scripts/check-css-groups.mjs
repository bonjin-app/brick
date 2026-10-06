#!/usr/bin/env node
/*
 * 쇼핑몰 블록의 CSS 묶음(SHOP_*_CSS)이 지켜지는가.
 *
 * 왜 필요했나: 쇼핑몰 CSS 는 한 덩어리(약 22KB)였고, 홈의 상품 진열 블록 하나가 상세·장바구니·분류 레일·재입고·
 * 하단 구매 바 규칙까지 실었다 — 홈 CSS 의 78%. 화면별 묶음으로 나눴는데, 나누면 두 가지가 조용히 어긋난다:
 *
 *   1. **같은 요소를 겨냥한 규칙이 두 묶음에 걸치면** 묶음을 싣는 순서에 따라 결과가 달라진다(캐스케이드는 같은
 *      특이도에서 뒤의 것이 이긴다). 나누기 전 한 덩어리에서는 순서가 곧 소스 순서라 드러나지 않았다.
 *      → 같은 선택자가 두 묶음에 있으면 막는다(별 `.brick-stars` 는 상세·카드가 같이 써서 일부러 둘 다 둔다).
 *   2. **어느 블록도 싣지 않는 묶음**은 죽은 CSS 다 — 화면에서 규칙이 사라졌는데 아무도 모른다.
 *      → 모든 묶음은 정의 밖에서 한 번 이상 쓰여야 한다.
 *
 * 나눈 뒤 화면이 그대로인지는 이 검사가 아니라 브라우저에서 계산된 스타일을 나누기 전후로 비교해 확인했다
 * (장바구니의 버튼 줄이 상세 묶음의 규칙을 빌려 쓰는 것도 거기서 드러났다 — 그래서 BUY 묶음이 따로 있다).
 *
 * 사용법: node scripts/check-css-groups.mjs
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = "plugins/brick-shop/src/blocks.ts";
const src = readFileSync(ROOT + FILE, "utf8");

let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

// 두 묶음에 일부러 둔 선택자 — 이유는 위 주석
const SHARED = new Set([".brick-stars"]);

console.log("▶ 쇼핑몰 CSS 묶음");

const defs = [...src.matchAll(/const (SHOP_[A-Z]+_CSS) = `/g)];
if (defs.length < 5) bad(`묶음을 거의 찾지 못했다 (${defs.length}) — 검사가 헛돈다`);

/** 규칙 목록(@media 안은 안쪽 규칙마다, 바깥 조건을 붙여서) → 선택자 집합 */
function selectorsOf(css) {
  const out = [];
  const strip = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\$\{[^}]*\}/g, "");
  const walk = (text, ctx) => {
    let depth = 0, head = "", body = "";
    for (const ch of text) {
      if (depth === 0 && ch !== "{") { head += ch; continue; }
      if (ch === "{") { if (depth > 0) body += ch; depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const h = head.trim();
          if (h.startsWith("@")) walk(body, `${ctx}${h.replace(/\s+/g, "")}|`);
          else for (const sel of h.split(",")) out.push(`${ctx}${sel.trim().replace(/\s+/g, " ")}`);
          head = ""; body = "";
        } else body += ch;
        continue;
      }
      body += ch;
    }
  };
  walk(strip, "");
  return out;
}

const groups = {};
for (const m of defs) {
  const name = m[1];
  const start = m.index + m[0].length;
  const end = src.indexOf("</style>`;", start);
  if (end < 0) { bad(`${name}: 끝을 찾지 못했다`); continue; }
  const body = src.slice(start, end).replace(/^\s*<style>/, "");
  groups[name] = { sels: selectorsOf(body), bytes: end - start };
}

// 0 — 옛 한 덩어리가 남지 않았다
/\bSTOREFRONT_CSS\b/.test(src)
  ? bad("옛 STOREFRONT_CSS 가 남아 있다 — 묶음으로 나눈 뒤에는 쓰지 않는다")
  : ok("옛 한 덩어리(STOREFRONT_CSS)가 남아 있지 않다");

// 1 — 같은 선택자가 두 묶음에 걸치지 않는다
const owner = new Map();
const dup = [];
for (const [name, g] of Object.entries(groups)) {
  for (const sel of new Set(g.sels)) {
    if (SHARED.has(sel)) continue;
    if (owner.has(sel) && owner.get(sel) !== name) dup.push(`${sel}  (${owner.get(sel)} · ${name})`);
    else owner.set(sel, name);
  }
}
dup.length
  ? dup.slice(0, 15).forEach((d) => bad(`같은 선택자가 두 묶음에 있다 — ${d}`))
  : ok(`선택자 ${owner.size}개가 한 묶음에만 있다 (공용 ${[...SHARED].join(", ")})`);

// 2 — 모든 묶음이 정의 밖에서 쓰인다
for (const [name] of Object.entries(groups)) {
  const uses = [...src.matchAll(new RegExp(`\\$\\{[^}]*\\b${name}\\b[^}]*\\}`, "g"))].length;
  uses > 0 ? ok(`${name}: ${(groups[name].bytes / 1024).toFixed(1)}KB, ${uses}곳에서 싣는다`) : bad(`${name} 은 어디서도 싣지 않는다 — 죽은 CSS`);
}

console.log(fail ? `\n${fail}개 실패` : "\n통과");
process.exit(fail ? 1 : 0);
