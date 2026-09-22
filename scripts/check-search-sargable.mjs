#!/usr/bin/env node
/*
 * **검색 조건이 인덱스를 쓸 수 있는 모양인가.**
 *
 * 왜 필요했나: 상품 검색이 `p.name ILIKE … OR coalesce(p.summary,'') ILIKE …`
 * 였다. `coalesce()` 로 감싸는 순간 그 조각은 컬럼이 아니라 **식**이 되어
 * 인덱스를 못 쓰고, OR 로 묶인 나머지 조각까지 함께 순차 스캔으로 떨어진다 —
 * 이름 쪽에 trgm 인덱스가 있어도 한 번도 쓰이지 않았다. 12만 건에서 재어 보니
 * 24.5ms 대 0.14ms 였고, **결과는 완전히 같았다**(NULL 을 ILIKE 로 비교하면
 * NULL 이고, WHERE 의 OR 안에서 NULL 은 참이 아니다 — 감쌀 이유가 없었다).
 *
 * 눈으로는 티가 나지 않는 종류다: 코드는 멀쩡해 보이고, 결과도 맞고, 작은
 * 사이트에서는 빠르다. 데이터가 쌓인 뒤에야 느려지고 그때는 원인을 찾기 어렵다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
/** 컬럼을 감싸면 인덱스를 못 쓰는 함수들 */
const WRAPPERS = ["coalesce", "lower", "upper", "trim", "concat"];
const RE = new RegExp(`\\b(${WRAPPERS.join("|")})\\s*\\([^()]*\\)\\s*ILIKE`, "gi");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const problems = [];
let checked = 0;
for (const dir of [join(ROOT, "apps/api/src"), join(ROOT, "plugins")]) {
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8")
      // 주석은 지운다 — 이 함정을 설명하는 주석이 스스로 걸리면 검사가 거짓말이 된다
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const line of src.split("\n")) {
      if (/ILIKE/i.test(line)) checked += 1;
      const m = line.match(RE);
      if (m) problems.push([file.replace(ROOT, ""), m[0].trim()]);
    }
  }
}

console.log("▶ 검색 조건이 인덱스를 쓸 수 있는 모양이다");
if (!checked) {
  console.log("  ❌ ILIKE 를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)");
  process.exit(1);
}
console.log(`  ✅ ILIKE 를 쓰는 ${checked}줄을 살펴봤습니다`);
for (const [where, what] of problems) {
  console.log(`  ❌ ${where} — ${what} … 컬럼을 감싸면 인덱스를 못 씁니다`);
}
console.log(
  problems.length
    ? "\n결과는 같고 작은 사이트에서는 빨라서, 데이터가 쌓인 뒤에야 느려집니다 — 그때는 원인을 찾기 어렵습니다."
    : "\n감싸지 않은 컬럼 비교라 인덱스가 실제로 쓰입니다.",
);
process.exit(problems.length ? 1 : 0);
