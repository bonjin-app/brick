#!/usr/bin/env node
/*
 * **테마의 본문 기본값이 확장의 스타일을 이기고 있었다.**
 *
 * 테마는 클래스 없는 본문 요소를 위해 `.brick-main p`·`.brick-main button` 같은
 * 규칙을 둔다(에디터로 쓴 글에는 클래스가 없다). 그런데 그 선택자의 특이도는
 * (0,1,1) 이라 **플러그인이 자기 클래스로 쓴 (0,1,0) 을 이긴다.** 그래서
 * 위시리스트 버튼의 여백·간격, 상품 상세 탭의 색과 여백, 안내 문단의 여백이
 * 블록이 정한 값이 아니라 테마의 기본값으로 그려졌다 — 한 화면에서 44곳이었다.
 *
 * 고치는 방법은 특이도를 0 으로 만드는 것이다: `:where(.brick-main p)`.
 * 기본값은 **아무 클래스에게나 진다** — 그것이 기본값의 뜻이다.
 *
 * 테마가 특정 블록을 **일부러** 다시 그리는 것은 그대로 이긴다:
 * `.brick-main .brick-product-detail` 처럼 **클래스로** 겨냥하면 되고,
 * 이 검사는 그것을 막지 않는다(쇼핑몰 테마가 실제로 그렇게 쓴다).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const THEMES = join(ROOT, "themes");
const SCOPE = /\.brick-(main|page)\b/;

/** 선택자의 마지막 복합 조각 (결합자로 나눈 뒤) */
function lastCompound(sel) {
  const parts = sel.trim().split(/\s*[>+~]\s*|\s+/);
  return parts[parts.length - 1] ?? "";
}

/** `.brick-main p` 처럼 **요소로 끝나는** 규칙인가 (클래스로 끝나면 의도된 덮어쓰기다) */
function isElementDefault(sel) {
  const s = sel.trim();
  if (!SCOPE.test(s)) return false;
  if (s.startsWith(":where(")) return false;
  const last = lastCompound(s);
  if (!last || last.includes(".") || last.includes("#")) return false;
  if (SCOPE.test(last)) return false;
  return /^[a-z][\w-]*(\[|:|$)/.test(last) || last.startsWith("[");
}

let bad = 0;
let checked = 0;
console.log("▶ 테마의 본문 기본값은 확장의 스타일에 진다");

for (const theme of readdirSync(THEMES)) {
  const src = join(THEMES, theme, "src", "style.css");
  if (!existsSync(src)) continue;
  const css = readFileSync(src, "utf8");
  const offenders = new Set();
  let wrapped = 0;
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    let head = m[1];
    const cut = head.lastIndexOf("*/");
    if (cut !== -1) head = head.slice(cut + 2);
    if (head.trim().startsWith("@")) continue;
    for (const sel of head.split(",")) {
      const core = sel.trim();
      if (!core) continue;
      if (core.startsWith(":where(") && SCOPE.test(core)) wrapped += 1;
      if (isElementDefault(core)) offenders.add(core);
    }
  }
  checked += 1;
  if (offenders.size === 0) {
    console.log(`  ✅ ${theme}: 본문 기본값 ${wrapped}개가 :where() 안에 있다`);
  } else {
    bad += offenders.size;
    console.log(`  ❌ ${theme}: 특이도를 가진 본문 기본값 ${offenders.size}개 — :where(…) 로 감싸세요`);
    for (const o of [...offenders].slice(0, 8)) console.log(`     · ${o}`);
    if (offenders.size > 8) console.log(`     · … 외 ${offenders.size - 8}개`);
  }
}

console.log();
if (bad) {
  console.log("기본값이 블록을 이기면, 확장은 자기 화면의 모양을 정할 수 없습니다.");
  process.exit(1);
}
console.log(`테마 ${checked}개의 본문 기본값이 확장에 자리를 내줍니다.`);
