#!/usr/bin/env node
/*
 * **버튼 배경을 정한 규칙은 글자색도 정한다.**
 *
 * 왜 필요했나: 테마의 기본 버튼 hover 는 색을 뒤집는다 — 배경은 글자색으로, 글자는 배경색으로
 * (`:where(.brick-main button:hover)`, 특이도 0). 플러그인이 자기 버튼의 **배경만** 흰색으로
 * 고정하면 hover 에서 배경은 플러그인이 이기고 글자는 테마가 이겨 **흰 바탕에 흰 글자**가 된다.
 * 상품 상세의 장바구니 버튼과 게시판의 검색 버튼이 그랬다 — 테마 여섯 벌에서, 데스크톱으로
 * 마우스를 올린 모든 손님에게 빈 버튼이 보였다. 가만히 있는 화면을 재는 대비 검사로는 잡히지
 * 않는다(hover 는 진짜 포인터만 켠다). 헤드리스로 포인터를 올려 재서야 알았다(대비 1.0).
 *
 * 무엇을 보나: 플러그인 소스와 코어 블록 소스의 CSS 문자열에서, 선택자에 `button` 이 있고
 * 배경(background / background-color)을 정하는 규칙(hover·focus·disabled 상태 규칙은 빼고)은
 * `color` 도 정해야 한다. 배경이 none·transparent 면 뒤집혀도 읽히므로 괜찮다.
 * 글자색을 정해 두면 테마의 hover(특이도 0)가 글자를 바꾸지 못한다 — hover 모양을 바꾸고
 * 싶다면 그 버튼의 :hover 규칙을 따로 쓴다.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function* tsFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield p;
  }
}

const dirs = [
  ...readdirSync(join(ROOT, "plugins")).map((d) => join(ROOT, "plugins", d, "src")),
  join(ROOT, "apps/api/src/modules"),
];

/*
 * 버튼은 `button` 낱말 없이 클래스로만 꾸미기도 한다(`.brick-pd-more{…}` — "후기 더 보기" 버튼).
 * 소스에서 `<button … class="X">` 로 쓰인 클래스를 모아 그 클래스를 쓰는 규칙도 버튼 규칙으로 본다.
 */
const buttonClasses = new Set();
for (const dir of dirs) {
  for (const file of tsFiles(dir)) {
    for (const m of readFileSync(file, "utf8").matchAll(/<button\b[^>]*?\bclass="([^"$]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^brick-[\w-]+$/.test(c) && c !== "brick-btn" && c !== "brick-primary") buttonClasses.add(c);
    }
  }
}
const isButtonSelector = (sel) =>
  /\bbutton\b/.test(sel) || [...buttonClasses].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel));

const STATE = /:hover|:focus|:active|:disabled|\[disabled\]|\[aria-pressed|\[aria-selected|\.is-|\.on\b/;
const problems = [];
let rules = 0;
for (const dir of dirs) {
  for (const file of tsFiles(dir)) {
    const src = readFileSync(file, "utf8");
    // CSS 규칙 모양만 본다: `선택자{선언}` — 템플릿·주석 속 다른 중괄호는 선언에 콜론·세미콜론 모양이 없다
    const re = /([^{}`;]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const body = m[2];
      if (!isButtonSelector(sel) || STATE.test(sel)) continue;
      if (!/(^|;)\s*background(-color)?\s*:/.test(body)) continue;
      rules++;
      if (/(^|;)\s*color\s*:/.test(body)) continue;
      if (/(^|;)\s*background(-color)?\s*:\s*(none|transparent)\b/.test(body)) continue;
      const line = src.slice(0, m.index + m[0].indexOf(m[1].trimStart().slice(0, 10))).split("\n").length;
      problems.push(`${relative(ROOT, file)}:${line}  ${sel.split("\n").pop().slice(-80)}`);
    }
  }
}

console.log("▶ 버튼 배경을 정한 규칙은 글자색도 정한다 (테마 hover 가 글자만 뒤집지 않게)");
if (problems.length) {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log(`\n${problems.length}건 — 그 규칙에 color 를 더하세요(필요하면 :hover 규칙도 따로).`);
  process.exit(1);
}
console.log(`  ✅ 배경을 정한 버튼 규칙 ${rules}개 모두 글자색을 정한다`);
