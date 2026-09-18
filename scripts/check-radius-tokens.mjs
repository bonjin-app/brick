#!/usr/bin/env node
/*
 * 화면을 그리는 확장이 **모서리 둥글기를 테마에서 가져오는가**.
 *
 * 왜 필요했나: 테마마다 둥글기의 언어가 다르다 — 부티크는 `0px`(각진 편집샵),
 * 에디토리얼 `2px`, 쇼핑몰 `3px`, 회사 `4px`, 기본 `10px`. 그런데 플러그인과
 * 코어 블록은 `border-radius: 8px` 같은 값을 **55곳에 박아** 두고 있었다.
 * 그래서 각진 테마를 골라도 상품 카드·구매 버튼·장바구니·게시판·문의·쪽지가
 * 둥글게 남는다 — 테마를 바꿔도 사이트의 인상이 바뀌지 않는다.
 *
 * 실제로 확인했다: 부티크(0px)로 바꾸자 구매 버튼이 8px 그대로였고, 토큰을
 * 쓰게 고친 뒤에는 0px 이 됐다.
 *
 * 규칙: 플러그인 화면 코드와 코어 블록의 `border-radius` 는 `var(--radius…)`
 * 를 쓴다. 예외는 **모양 자체가 의도인 것**뿐이다:
 *   - `999px` · `50%` — 알약과 원(아바타·점). 테마가 각져도 원은 원이다.
 *   - 주석에 이유를 적어 둔 곳 ("둥글기 고정: …").
 *
 * 테마는 이 검사의 대상이 아니다 — 둥글기를 정하는 것이 테마의 일이다.
 *
 * 사용법: node scripts/check-radius-tokens.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = [];
for (const plugin of readdirSync(join(ROOT, "plugins"))) {
  walk(join(ROOT, "plugins", plugin, "src"), files);
}
walk(join(ROOT, "apps/api/src/modules/pages"), files);

console.log("▶ 확장의 모서리 둥글기는 테마가 정한다");

const bad = [];
let checked = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/border-radius:\s*([^;}"'`]+)/g)) {
      const value = m[1].trim();
      checked++;
      if (value.includes("var(--radius")) continue;
      /*
       * 모양 자체가 의도인 것만 통과시킨다.
       *  999px·50% — 알약과 원(아바타·점). 테마가 각져도 원은 원이다.
       *  0        — 되돌리기. 글자처럼 보여야 하는 버튼(작성자 이름)이
       *             브라우저 기본 둥글기를 벗는 자리다. 테마가 둥글어도
       *             그것은 글자여야 한다.
       */
      if (/^(999px|9999px|50%|0|0px)$/.test(value)) continue;
      // 이유를 적어 둔 제외는 인정한다 (다른 검사들과 같은 원칙)
      if (/둥글기 고정/.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"))) continue;
      bad.push(`${file.slice(ROOT.length)}:${i + 1}  border-radius: ${value}`);
    }
  });
}

if (!checked) { console.log("  ❌ border-radius 를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 둥글기: ${checked}군데`);
for (const b of bad) console.log(`  ❌ ${b}`);
console.log(bad.length
  ? "\n각진 테마를 골라도 이 자리는 둥글게 남습니다 — var(--radius) · var(--radius-lg) 를 쓰세요."
  : "\n모두 테마를 따릅니다.");
process.exit(bad.length ? 1 : 0);
