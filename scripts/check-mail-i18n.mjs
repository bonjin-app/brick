/**
 * 메일 문구가 사이트 언어를 따르는가.
 *
 * **메일은 사이트 밖에서 혼자 읽힌다.** 화면은 옆에 다른 번역된 것이 있어 문맥이
 * 있지만, 메일은 받은편지함에 한 통으로 도착한다 — 영어를 쓰는 회원이 비밀번호를
 * 잃어버린 순간 받는 것이 한국어 한 통이면 그것으로 끝이다.
 *
 * 실제로 주문 안내 메일만 카탈로그를 타고 있었다. 비밀번호 재설정·이메일 인증
 * (코어), 1:1 문의 답변, 재입고 알림, 정기배송 중지·결제 실패가 전부 한국어로
 * 박혀 있었고, 재입고 메일은 **가격 줄만** 번역되어 더 나빴다(반쪽으로 섞인
 * 메일은 통째로 한 언어인 것보다 나쁘다).
 *
 * 규칙: `subject:` 에 한국어가 든 리터럴을 두지 않는다. 번역기를 통과시키면
 * (`t(...)`·`ctx.t(...)`) 본문도 자연히 따라온다 — 제목만 번역하고 본문을
 * 한국어로 두는 코드는 없었다.
 *
 * 한계: 제목을 표지로 삼는다. 본문만 한국어인 경우는 잡지 못한다 —
 * 그쪽은 smoke-i18n.sh 가 실제로 메일을 발송시켜 본다.
 *
 * 사용법: node scripts/check-mail-i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const HANGUL = /[가-힣]/;

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const roots = [join(ROOT, "apps/api/src"), join(ROOT, "packages"), join(ROOT, "plugins")];
const files = roots.flatMap((r) => walk(r));

console.log("▶ 메일 문구가 사이트 언어를 따른다");
const bad = [];
let checked = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const m = /\bsubject:\s*(.+)$/.exec(line);
    if (!m) return;
    const value = m[1].trim().replace(/,$/, "");
    checked++;
    if (/\bt\(/.test(value)) return;          // 번역기를 통과한다
    if (!HANGUL.test(value)) return;          // 한국어 리터럴이 아니다
    bad.push(`${file.slice(ROOT.length)}:${i + 1}  ${value.slice(0, 70)}`);
  });
}

if (bad.length) {
  for (const b of bad) console.log(`  ❌ ${b}`);
  console.log(`\n메일 제목 ${checked}개 중 ${bad.length}개가 한국어로 박혀 있습니다.`);
  console.log("카탈로그로 옮기세요 — 받은 사람 옆에는 번역된 화면이 없습니다.");
  process.exit(1);
}
console.log(`  ✅ 메일 제목 ${checked}개가 모두 카탈로그를 탑니다`);
