#!/usr/bin/env node
/**
 * 되돌아갈 주소(`?next=`)를 읽는 곳은 **브라우저의 해석으로** 같은 사이트인지 판단한다.
 *
 * 로그인·카드 등록 화면이 "첫 글자가 / 이고 둘째가 / 가 아니면 통과" 라는 문자열 규칙을
 * 썼다. 브라우저는 역슬래시를 슬래시로 읽고 탭을 지우므로 `/\evil.example` 이 규칙을 지나
 * `https://evil.example/` 로 갔다 — 로그인 직후 공격자 사이트로 넘기는 열린 리다이렉트다.
 * 같은 규칙이 두 곳에 따로 있었고, 둘 다 같은 식으로 뚫려 있었다.
 *
 * 규칙: `next` 를 읽는 파일은 공용 `sameOriginPath` 를 쓰거나, `new URL(…)` 로 푼 뒤
 * `.origin` 을 비교해야 한다. 문자열 규칙의 흔적(`charAt(1) !== '/'`, `^\/(?!\/)`)은
 * 그 자체로 막는다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const roots = ["apps/web/src", "themes"];
for (const d of readdirSync(join(ROOT, "plugins"))) {
  try { if (statSync(join(ROOT, "plugins", d, "src")).isDirectory()) roots.push(`plugins/${d}/src`); } catch { /* */ }
}
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(rel); continue; }
    if (/\.(tsx?|m?js|html)$/.test(e.name)) files.push(rel);
  }
};
roots.forEach(walk);

const READS_NEXT = /\.get\(\s*['"]next['"]\s*\)/;
const STRING_RULE = /charAt\(1\)\s*!==?\s*['"]\/['"]|\^\\\/\(\?!\\\/\)/;
const problems = [];
let readers = 0;
for (const f of files) {
  const src = readFileSync(join(ROOT, f), "utf8");
  if (STRING_RULE.test(src)) {
    problems.push(`${f} — 문자열 규칙으로 같은 사이트를 판단합니다("/\\evil.example" 이 통과합니다)`);
  }
  if (!READS_NEXT.test(src)) continue;
  readers += 1;
  const usesShared = src.includes("sameOriginPath(");
  const usesParser = /new URL\(/.test(src) && /\.origin\s*[!=]==?\s*(location|window\.location)\.origin|\borigin\s*===?\s*location\.origin/.test(src);
  if (!usesShared && !usesParser) {
    problems.push(`${f} — ?next= 를 읽는데 브라우저 해석으로 출처를 비교하지 않습니다 (sameOriginPath 를 쓰세요)`);
  }
}

/*
 * 브라우저로 내려가는 스크립트 문자열 안의 safeNext 는 모양만으로는 모른다 — 본문을 꺼내
 * 격리된 VM 에서 **실제로 돌려** 우회 문자열을 넣어 본다(브라우저와 같은 WHATWG URL 해석).
 */
const ORIGIN = "https://shop.example";
const ATTACKS = [
  "//evil.example",
  "/\\evil.example",        // 역슬래시 — 브라우저는 슬래시로 읽는다
  "/\t/evil.example",       // 탭 — 해석 중에 지워진다
  "/\\\\evil.example/x",
  "https://evil.example",
  "javascript:alert(1)",
];
let exercised = 0;
for (const f of files) {
  const src = readFileSync(join(ROOT, f), "utf8");
  const at = src.indexOf("function safeNext(){");
  if (at < 0) continue;
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const fn = src.slice(at, end);
  const run = (next) => {
    const location = { search: `?next=${encodeURIComponent(next)}`, origin: ORIGIN };
    return vm.runInNewContext(`${fn}; safeNext()`, { location, URL, URLSearchParams });
  };
  exercised += 1;
  if (run("/account?tab=1") !== "/account?tab=1") problems.push(`${f} — safeNext 가 정상 경로를 거절합니다`);
  for (const a of ATTACKS) {
    const got = run(a);
    if (got) problems.push(`${f} — safeNext 가 ${JSON.stringify(a)} 를 통과시킵니다 → ${new URL(got, ORIGIN).href}`);
  }
}

if (!readers) {
  console.error("❌ ?next= 를 읽는 곳을 하나도 찾지 못했습니다 — 검사가 고장났을 수 있습니다");
  process.exit(1);
}
if (problems.length) {
  console.error("❌ 열린 리다이렉트가 될 수 있는 곳:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
console.log(`✅ ?next= 를 읽는 ${readers}곳이 모두 브라우저 해석으로 같은 사이트인지 판단합니다 (스크립트 안의 safeNext ${exercised}개는 우회 ${ATTACKS.length}가지로 실제 실행)`);
