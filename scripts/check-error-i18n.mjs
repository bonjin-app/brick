#!/usr/bin/env node
/*
 * **서버 오류 메시지가 어느 언어에서도 한국어였다.**
 *
 * 화면은 전부 번역돼 있는데(카탈로그 862개) 주문 버튼을 누르면 "재고가
 * 부족합니다." 가 떴다. 영어 사이트를 쓰는 손님은 **가장 중요한 순간에만**
 * 못 읽는 글자를 본다 — 무엇이 잘못됐고 무엇을 고쳐야 하는지가 거기 있다.
 *
 * 규칙은 선언 라벨과 같다(gettext): **원문(한국어)이 곧 카탈로그 키**다.
 * 플러그인은 locales/en.json 에 `"주문을 찾을 수 없습니다.": "Order not found."`
 * 를 더하면 되고, 던지는 코드는 한 줄도 바뀌지 않는다. 번역이 없으면 원문이
 * 그대로 나간다 — 조용히 비지 않는다.
 *
 * 이 검사는 **새로 더한 오류 문장이 번역 없이 남는 것**을 막는다. 값이 박힌
 * 문장(템플릿 리터럴)은 원문과 키가 달라 어차피 걸리지 않으므로 세지 않는다 —
 * 그런 문장은 ctx.t 에 파라미터로 넘겨야 한다(로드맵에 남겼다).
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS = join(ROOT, "plugins");

/** throw new XxxError(400, "…") · throw new XxxException("…") */
const THROW_RE = /throw new \w*(?:Error|Exception)\(\s*(?:\d{3},\s*)?(["'`])((?:[^\\]|\\.)*?)\1/g;
const HANGUL = /[가-힣]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

let bad = 0;
let checked = 0;
console.log("▶ 서버 오류 메시지가 사이트 언어를 따른다");

for (const plugin of readdirSync(PLUGINS)) {
  const src = join(PLUGINS, plugin, "src");
  if (!existsSync(src)) continue;
  const enPath = join(PLUGINS, plugin, "locales", "en.json");
  const en = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};

  const missing = new Set();
  let plain = 0;
  for (const file of walk(src)) {
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(THROW_RE)) {
      const msg = m[2];
      if (!HANGUL.test(msg)) continue;
      // 값이 박힌 문장은 원문=키가 성립하지 않는다 (ctx.t 로 옮겨야 하는 것들)
      if (m[1] === "`" && msg.includes("${")) continue;
      plain += 1;
      if (typeof en[msg] !== "string") missing.add(msg);
    }
  }
  if (!plain) continue;
  checked += 1;
  if (missing.size === 0) {
    console.log(`  ✅ ${plugin}: 오류 문장 ${plain}개가 모두 번역됩니다`);
  } else {
    bad += missing.size;
    console.log(`  ❌ ${plugin}: 번역 없는 오류 문장 ${missing.size}개 — locales/en.json 에 원문을 키로 더하세요`);
    for (const m of [...missing].slice(0, 8)) console.log(`     · ${m}`);
    if (missing.size > 8) console.log(`     · … 외 ${missing.size - 8}개`);
  }
}

console.log();
if (bad) {
  console.log("영어 사이트의 손님은 가장 중요한 순간에만 한국어를 봅니다 — 오류 문장이 그 자리입니다.");
  process.exit(1);
}
console.log(`플러그인 ${checked}개의 오류 문장이 사이트 언어를 따릅니다.`);
