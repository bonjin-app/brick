#!/usr/bin/env node
/*
 * **관리 화면의 라벨이 사이트 언어를 따르는가.**
 *
 * 왜 필요했나: 손님 화면(check-screen-i18n)·오류 문장(check-error-i18n)·블록
 * 서랍(check-block-i18n)·메일(check-mail-i18n)은 검사가 있는데, **운영자가 하루
 * 종일 보는 관리 화면의 라벨**만 아무도 보지 않았다. 그래서 en 사이트의 관리
 * 화면에는 한국어가 섞여 있었다 — 새 확장을 하나 만들 때마다 조금씩 늘었고,
 * 늘어난 것을 아무도 몰랐다(문자 발송 확장은 열 개가 전부 한국어였다).
 *
 * 무엇을 보나: 플러그인 소스의 `label` · `title` · `itemLabel` · `help` ·
 * `description` · `placeholder` 값 중 **한글이 든 것**은 그 플러그인의
 * `locales/en.json` 에 키로 있어야 한다(원문이 곧 번역 키다 — gettext 방식).
 *
 * 이어붙인 문자열(`"앞" + "뒤"`)도 한 덩어리로 본다. 실행 시점의 키는 이어붙인
 * **전체 문장**이라, 앞 조각만 보면 번역이 있는데도 없다고 말한다.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KEYS = ["label", "title", "itemLabel", "help", "description", "placeholder"];
const HANGUL = /[가-힣]/;

/** 주석을 지운다 — 주석 속 예시 문구까지 번역하라고 하면 검사가 거짓말이 된다 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * `키: "값" + "값"` 에서 이어붙인 전체 문자열을 읽는다.
 * 문자열이 아닌 표현(변수·템플릿)을 만나면 그 자리에서 멈춘다 — 그건 값이
 * 실행 중에 정해지므로 이 검사의 대상이 아니다.
 */
function readConcat(src, from) {
  let i = from;
  let out = "";
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '"') return out ? { text: out, end: i } : null;
    i += 1;
    let buf = "";
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\") {
        buf += src[i + 1] === "n" ? "\n" : src[i + 1];
        i += 2;
        continue;
      }
      buf += src[i];
      i += 1;
    }
    i += 1;
    out += buf;
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    if (src[j] !== "+") return { text: out, end: i };
    i = j + 1;
  }
}

const problems = [];
let checked = 0;
const plugins = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const name of plugins) {
  const srcDir = join(ROOT, "plugins", name, "src");
  if (!existsSync(srcDir)) continue;
  const enPath = join(ROOT, "plugins", name, "locales", "en.json");
  const en = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};

  const missing = new Set();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const src = stripComments(readFileSync(join(srcDir, file), "utf8"));
    const re = new RegExp(`\\b(${KEYS.join("|")})\\s*:\\s*`, "g");
    for (const m of src.matchAll(re)) {
      const got = readConcat(src, m.index + m[0].length);
      if (!got || !HANGUL.test(got.text)) continue;
      // `#{글제목}` 처럼 알림 템플릿의 변수 자리 하나뿐인 값은 라벨이 아니다 — 변수 이름은 번역하지 않는다
      // (운영자가 템플릿에 적는 이름이 언어마다 달라지면 저장해 둔 템플릿이 깨진다)
      if (/^#\{[^}]+\}$/.test(got.text)) continue;
      checked += 1;
      if (!(got.text in en)) missing.add(got.text);
    }
  }
  if (missing.size) problems.push([name, [...missing]]);
}

console.log("▶ 관리 화면 라벨이 사이트 언어를 따른다");
if (!checked) {
  console.log("  ❌ 라벨을 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)");
  process.exit(1);
}
for (const [plugin, missing] of problems) {
  console.log(`  ❌ ${plugin}: 번역 없는 라벨 ${missing.length}개 — locales/en.json 에 더하세요`);
  for (const text of missing.slice(0, 6)) console.log(`     · ${text.slice(0, 70)}`);
  if (missing.length > 6) console.log(`     … 외 ${missing.length - 6}개`);
}
if (!problems.length) console.log(`  ✅ 관리 화면 라벨 ${checked}곳이 모두 번역됩니다`);
console.log(
  problems.length
    ? "\n운영자는 이 화면을 하루 종일 봅니다 — 절반만 영어인 관리 화면은 통째로 한국어인 것보다 나쁩니다."
    : "\n운영자가 보는 화면도 사이트 언어를 따릅니다.",
);
process.exit(problems.length ? 1 : 0);
