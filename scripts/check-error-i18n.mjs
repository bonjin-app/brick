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
 * 이 검사는 두 가지를 막는다.
 *
 *  1. 새로 더한 오류 문장이 **번역 없이** 남는 것.
 *  2. 플러그인이 값을 문장에 **박아 넣는** 것(`재고가 ${n}개 남았습니다`).
 *     그런 문장은 실행 시점 값이 리터럴과 달라 원문=키가 성립하지 않는다 —
 *     `ctx.t("...", { n })` 로 카탈로그에서 꺼내 맞춰야 번역된다. 플러그인은
 *     활성화 때 바인딩된 `t` 를 어디서든 부를 수 있으므로 예외를 두지 않는다.
 *
 * 코어·API 는 (2)를 아직 요구하지 않는다: 던지는 자리에 번역기가 없어서
 * (`ctx.t` 는 플러그인의 것이다) 예외에 키와 파라미터를 실어 응답 경계에서
 * 조립하는 별도 설계가 필요하다 — 로드맵에 남겼다.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CORE_ERROR_SOURCES } from "../packages/core/dist/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS = join(ROOT, "plugins");

/** throw new XxxError(400, "…") · throw new XxxException("…") */
const THROW_RE = /throw new \w*(?:Error|Exception)\(\s*(?:\d{3},\s*)?(["'`])((?:[^\\]|\\.)*?)\1/g;
const HANGUL = /[가-힣]/;

/**
 * 던진 문장이 **그 자체로 완결된 원문**인가.
 *
 * 값이 박힌 것(템플릿 보간)과 이어 붙인 것("…" + variable)은 실행 시점의 문장이
 * 코드의 리터럴과 달라서 원문=키가 성립하지 않는다 — 번역을 넣어도 걸리지 않으므로
 * 요구하지 않는다(그런 문장은 ctx.t 에 파라미터로 넘겨야 한다).
 */
/**
 * 던지는 자리에 **상수 이름**만 있는 경우 — `throw new X(BAD_CREDENTIALS)`.
 *
 * 로그인 실패 문장이 이 모양이라 오래 빠져 있었다: 제품 전체에서 가장 많이
 * 읽히는 오류 문장인데, 리터럴만 보는 검사에는 보이지 않았다.
 */
const CONST_RE = /^\s*const ([A-Z][A-Z0-9_]*) = (["'])((?:[^\\]|\\.)*?)\2;/gm;
const THROW_CONST_RE = /throw new \w*(?:Error|Exception)\(\s*([A-Z][A-Z0-9_]*)\s*[,)]/g;

function constMessages(source) {
  const map = new Map();
  for (const m of source.matchAll(CONST_RE)) map.set(m[1], m[3]);
  const out = [];
  for (const m of source.matchAll(THROW_CONST_RE)) {
    const msg = map.get(m[1]);
    if (msg) out.push(msg);
  }
  return out;
}

function isWholeMessage(match, source) {
  const [whole, quote, msg] = match;
  if (quote === "`" && msg.includes("${")) return false;
  const after = source.slice(match.index + whole.length).trimStart();
  return !after.startsWith("+");
}

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
  const interpolated = new Set();
  let plain = 0;
  for (const file of walk(src)) {
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(THROW_RE)) {
      const msg = m[2];
      if (!HANGUL.test(msg)) continue;
      // 값을 박아 넣은 문장은 번역될 수 없다 — 카탈로그로 옮기라고 말한다
      if (m[1] === "`" && msg.includes("${")) { interpolated.add(msg); continue; }
      if (!isWholeMessage(m, code)) continue;
      plain += 1;
      if (typeof en[msg] !== "string") missing.add(msg);
    }
    for (const msg of constMessages(code)) {
      if (!HANGUL.test(msg)) continue;
      plain += 1;
      if (typeof en[msg] !== "string") missing.add(msg);
    }
  }
  if (!plain && interpolated.size === 0) continue;
  checked += 1;
  if (missing.size === 0 && interpolated.size === 0) {
    console.log(`  ✅ ${plugin}: 오류 문장 ${plain}개가 모두 번역됩니다`);
  }
  if (missing.size > 0) {
    bad += missing.size;
    console.log(`  ❌ ${plugin}: 번역 없는 오류 문장 ${missing.size}개 — locales/en.json 에 원문을 키로 더하세요`);
    for (const m of [...missing].slice(0, 8)) console.log(`     · ${m}`);
    if (missing.size > 8) console.log(`     · … 외 ${missing.size - 8}개`);
  }
  if (interpolated.size > 0) {
    bad += interpolated.size;
    console.log(`  ❌ ${plugin}: 값을 박아 넣은 오류 문장 ${interpolated.size}개 — ctx.t("키", { 값 }) 로 옮기세요`);
    for (const m of [...interpolated].slice(0, 8)) console.log(`     · ${m}`);
    if (interpolated.size > 8) console.log(`     · … 외 ${interpolated.size - 8}개`);
  }
}

/*
 * 코어·API 는 카탈로그가 코드 안에 있다 (packages/core/src/i18n.ts).
 * 플러그인처럼 locales/*.json 이 없으므로 그 목록과 대조한다.
 */
{
  const core = new Set(CORE_ERROR_SOURCES);
  const missing = new Set();
  let plain = 0;
  for (const dir of [join(ROOT, "apps/api/src"), join(ROOT, "packages/core/src")]) {
    for (const file of walk(dir)) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(THROW_RE)) {
        const msg = m[2];
        if (!HANGUL.test(msg)) continue;
        if (!isWholeMessage(m, code)) continue;
        plain += 1;
        if (!core.has(msg)) missing.add(msg);
      }
      for (const msg of constMessages(code)) {
        if (!HANGUL.test(msg)) continue;
        plain += 1;
        if (!core.has(msg)) missing.add(msg);
      }
    }
  }
  checked += 1;
  if (missing.size === 0) {
    console.log(`  ✅ 코어·API: 오류 문장 ${plain}개가 모두 번역됩니다`);
  } else {
    bad += missing.size;
    console.log(`  ❌ 코어·API: 번역 없는 오류 문장 ${missing.size}개 — packages/core/src/i18n.ts 의 CORE_ERROR_EN 에 원문을 키로 더하세요`);
    for (const m of [...missing].slice(0, 8)) console.log(`     · ${m}`);
    if (missing.size > 8) console.log(`     · … 외 ${missing.size - 8}개`);
  }
}

console.log();
if (bad) {
  console.log("영어 사이트의 손님은 가장 중요한 순간에만 한국어를 봅니다 — 오류 문장이 그 자리입니다.");
  process.exit(1);
}
console.log(`${checked}곳의 오류 문장이 사이트 언어를 따릅니다.`);
