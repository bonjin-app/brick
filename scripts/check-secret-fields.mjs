/**
 * 자격증명처럼 생긴 관리 입력칸이 실제로 가려지는가.
 *
 * 왜 필요한가: 토스페이먼츠 시크릿 키는 `type: "text"` 로 선언돼 있었다. 관리
 * 화면은 그것을 평범한 입력칸으로 그렸고, 관리자가 키를 붙여 넣는 동안 값이
 * 화면에 그대로 떠 있었다. 플러그인은 "저장 후 다시 표시되지 않습니다"라는
 * **설명문**과 짝 boolean 으로 쓰기 전용 동작을 흉내 내고 있었지만, 화면은
 * 설명문을 읽을 수 없다.
 *
 * 규칙: 이름이 자격증명을 가리키는 필드(secret·password·token·apiKey·
 * privateKey·credential)는 `secret: true` 여야 한다. 단 **boolean 은 예외**다 —
 * `allow_secret`(비밀글 허용), `is_secret`(비밀글 여부)처럼 이름만 닮은 스위치가
 * 있고, 스위치는 가릴 것이 없다. `readOnly` 인 상태 표시 칸도 마찬가지다
 * (`secretKeyConfigured` 는 "설정됨" 여부일 뿐 값이 아니다).
 *
 * 사용법: node scripts/check-secret-fields.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SECRETY = /(secret|password|passwd|token|apikey|api_key|privatekey|private_key|credential)/i;

/** `키: [ ... ]` 의 대괄호 짝을 세어 블록을 통째로 꺼낸다 (정규식으로는 중첩을 못 센다) */
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

console.log("▶ 자격증명 입력칸은 가려진다");
let fail = 0;
let seen = 0;
const pluginsDir = join(ROOT, "plugins");
for (const plugin of readdirSync(pluginsDir)) {
  const srcDir = join(pluginsDir, plugin, "src");
  let files;
  try { files = walk(srcDir); } catch { continue; }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const block of arrayBlocks(src, "fields")) {
      // 중첩 없는 필드 객체 하나씩
      for (const m of block.matchAll(/\{[^{}]*name\s*:\s*"([\w]+)"[^{}]*\}/g)) {
        const [obj, name] = [m[0], m[1]];
        if (!SECRETY.test(name)) continue;
        const isBoolean = /type\s*:\s*"boolean"/.test(obj);
        const isReadOnly = /readOnly\s*:\s*true/.test(obj);
        const marked = /secret\s*:\s*true/.test(obj);
        if (isBoolean || isReadOnly) continue; // 스위치·상태 표시는 값이 아니다
        seen++;
        if (marked) {
          console.log(`  ✅ ${plugin}: ${name}`);
        } else {
          console.log(
            `  ❌ ${plugin}: ${name} — 자격증명처럼 보이는데 secret: true 가 없습니다 ` +
              `(화면이 평문 입력칸으로 그립니다)`,
          );
          fail++;
        }
      }
    }
  }
}

if (seen === 0) console.log("  · 자격증명 입력칸이 없습니다");
if (fail > 0) {
  console.log("\n관리자가 키를 붙여 넣는 동안 화면에 그대로 떠 있게 됩니다.");
  process.exit(1);
}
console.log("\n모두 가려집니다.");
