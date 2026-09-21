#!/usr/bin/env node
/*
 * **페이지를 만드는 화면만 한국어였다.**
 *
 * 관리 화면은 전부 번역돼 있는데, 페이지 빌더가 여는 블록 서랍은 서버가 준
 * `displayName` 과 속성 `title` 을 그대로 그린다. 그래서 영어 사이트의 운영자에게도
 * "제목 · 문단 · 히어로 (큰 제목 영역)" 이 보였다 — 사이트를 만드는 첫 화면이다.
 *
 * 규칙은 선언 라벨·오류 문장과 같다(gettext): **원문(한국어)이 곧 키**다.
 * 플러그인 블록은 각자의 locales/en.json 이, 코어 블록은 코어 카탈로그
 * (`CORE_LABEL_EN`)가 받는다. 번역이 없으면 원문이 그대로 나간다.
 *
 * 선언의 **머리만** 본다 — render 안쪽은 화면 문자열이고, 그쪽은
 * check-screen-i18n.mjs 가 본다.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CORE_LABEL_SOURCES } from "../packages/core/dist/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const HANGUL = /[가-힣]/;

/** 블록 선언이 시작되는 세 가지 모양 (이 저장소에서 쓰는 전부) */
const STARTS = [
  /ctx\.registerBlock\(\s*\{/g,
  /Parameters<PluginContext\["registerBlock"\]>\[0\]\s*=\s*\{/g,
  /b\.set\("core\/[\w-]+",\s*\{/g,
];
const LABEL = /(displayName|title|description):\s*"((?:[^\\"]|\\.)*)"/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** `{` 부터 짝이 맞는 `}` 까지 */
function objectAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** 한 디렉터리의 블록 선언에서 보이는 라벨을 모은다 */
function labelsIn(dir) {
  const labels = new Set();
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    for (const re of STARTS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const body = objectAt(src, open);
        const cut = body.indexOf("render:");
        const head = cut === -1 ? body : body.slice(0, cut);
        for (const l of head.matchAll(LABEL)) {
          const text = l[2];
          if (!HANGUL.test(text)) continue;
          // 이어 붙인 문장은 실행 시점 값이 리터럴과 달라 원문=키가 성립하지 않는다
          const after = head.slice(l.index + l[0].length).trimStart();
          if (after.startsWith("+")) continue;
          labels.add(text);
        }
      }
    }
  }
  return labels;
}

let bad = 0;
let checked = 0;
console.log("▶ 페이지 빌더의 블록 이름·속성 제목이 사이트 언어를 따른다");

for (const plugin of readdirSync(join(ROOT, "plugins"))) {
  const src = join(ROOT, "plugins", plugin, "src");
  if (!existsSync(src)) continue;
  const labels = labelsIn(src);
  if (labels.size === 0) continue;
  const enPath = join(ROOT, "plugins", plugin, "locales", "en.json");
  const en = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};
  const missing = [...labels].filter((l) => typeof en[l] !== "string");
  checked += 1;
  if (missing.length === 0) {
    console.log(`  ✅ ${plugin}: 블록 라벨 ${labels.size}개가 모두 번역됩니다`);
  } else {
    bad += missing.length;
    console.log(`  ❌ ${plugin}: 번역 없는 블록 라벨 ${missing.length}개 — locales/en.json 에 원문을 키로 더하세요`);
    for (const m of missing.slice(0, 8)) console.log(`     · ${m}`);
  }
}

{
  const labels = labelsIn(join(ROOT, "apps/api/src/modules/pages"));
  const core = new Set(CORE_LABEL_SOURCES);
  const missing = [...labels].filter((l) => !core.has(l));
  checked += 1;
  if (missing.length === 0) {
    console.log(`  ✅ 코어 블록: 라벨 ${labels.size}개가 모두 번역됩니다`);
  } else {
    bad += missing.length;
    console.log(`  ❌ 코어 블록: 번역 없는 라벨 ${missing.length}개 — packages/core/src/i18n.ts 의 CORE_LABEL_EN 에 더하세요`);
    for (const m of missing.slice(0, 8)) console.log(`     · ${m}`);
  }
}

console.log();
if (bad) {
  console.log("사이트를 만드는 첫 화면이 블록 서랍입니다 — 거기가 한국어면 관리 화면 번역은 반쪽입니다.");
  process.exit(1);
}
console.log(`${checked}곳의 블록 라벨이 사이트 언어를 따릅니다.`);
