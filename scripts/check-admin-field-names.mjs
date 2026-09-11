/**
 * 관리 화면이 보내는 이름을 서버가 읽는가.
 *
 * 화면은 `AdminResource.fields[].name` 그대로 보낸다. 그런데 플러그인 핸들러는
 * 자기 코드 관례대로 카멜을 읽는 경우가 있었다 — 선언은 `approval_no` 인데
 * 핸들러는 `b.approvalNo` 만 읽는 식이다. 그러면 **운영자가 적은 값이 서버에
 * 도착하지 않는다.** 타입은 통과한다(둘 다 Record<string, unknown> 이다).
 *
 * 실제로 이렇게 새고 있었다:
 *   - 개인결제 청구: 받는 분·연락처·이메일이 저장되지 않았다.
 *   - 현금영수증·세금계산서: 승인번호를 적고 저장하면 "국세청 승인번호를
 *     입력해주세요" 가 떴다 — 방금 적은 그 칸을 두고. 화면으로는 수동 발급을
 *     끝낼 방법이 아예 없었다.
 *
 * 규칙: 스네이크로 선언한 편집 칸은, 핸들러가 그 이름으로 읽어야 한다.
 * 카멜도 함께 받는 것은 괜찮다(예전 API 호출자) — **스네이크를 안 읽는 것**이
 * 문제다.
 *
 * 한계: 정적 검사라 "읽는 모양"을 패턴으로 본다(b.x·body.x·req.body.x·["x"]).
 * 이름을 한 번도 안 쓰는 칸은 여기서 걸리지 않는다 —
 * 그쪽은 smoke-admin-resources.sh 가 실제로 왕복시켜 본다.
 *
 * 사용법: node scripts/check-admin-field-names.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function arrayBlocks(src, key) {
  const out = [];
  const re = new RegExp(`${key}\\s*:\\s*\\[`, "g");
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < src.length && depth > 0) {
      if (src[j] === "[") depth++;
      else if (src[j] === "]") depth--;
      j++;
    }
    out.push(src.slice(m.index + m[0].length, j));
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const toCamel = (s) =>
  s.split("_").map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");

console.log("▶ 화면이 보내는 이름을 서버가 읽는다");
let fail = 0;
let checked = 0;
for (const plugin of readdirSync(join(ROOT, "plugins"))) {
  let files;
  try { files = walk(join(ROOT, "plugins", plugin, "src")); } catch { continue; }
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");

  const declared = new Set();
  for (const block of arrayBlocks(src, "fields")) {
    for (const m of block.matchAll(/\{[^{}]*name\s*:\s*"([\w]+)"[^{}]*\}/g)) {
      if (/readOnly\s*:\s*true/.test(m[0])) continue; // 폼에 없으므로 보내지 않는다
      declared.add(m[1]);
    }
  }

  const bad = [];
  for (const name of [...declared].sort()) {
    if (!name.includes("_")) continue;
    checked++;
    const camel = toCamel(name);
    const readsSnake =
      new RegExp(`\\b(?:b|body|input|req\\.body)\\s*\\.\\s*${name}\\b`).test(src) ||
      src.includes(`["${name}"]`);
    const readsCamel = new RegExp(`\\b(?:b|body|input|req\\.body)\\s*\\.\\s*${camel}\\b`).test(src);
    if (readsCamel && !readsSnake) bad.push({ name, camel });
  }

  if (bad.length) {
    fail += bad.length;
    console.log(`  ❌ ${plugin}`);
    for (const b of bad) {
      console.log(`       "${b.name}" 로 선언했는데 핸들러는 b.${b.camel} 만 읽습니다 — 운영자가 적은 값이 사라집니다`);
    }
  } else {
    console.log(`  ✅ ${plugin}`);
  }
}

console.log(`\n스네이크 선언 ${checked}칸 확인.`);
if (fail > 0) {
  console.log("선언한 이름으로 읽거나, 둘 다 받도록 고치세요.");
  process.exit(1);
}
console.log("모두 선언한 이름으로 읽습니다.");
