#!/usr/bin/env node
/*
 * 실패를 **성공 색**으로 보여주고 있지 않은가.
 *
 * 왜 필요했나: 페이지 빌더에서 저장이 실패하면 "저장 실패: …" 가 뜬다.
 * 그런데 그 문단은 언제나 `color: var(--color-success)` 였다 — 초록 글씨로
 * "실패" 라고 적혀 있었고, `role` 도 없어 스크린리더에는 아무 일도 일어나지
 * 않았다. 같은 모양이 관리 화면 여섯 곳, 상품 재입고 알림 폼까지 일곱 곳에서
 * 나왔다. 성공과 실패가 **같은 자리**를 쓰는데 색만 성공에 고정돼 있던 것이다.
 *
 * 왜 문구로 판별하면 안 되나: 이 저장소는 메뉴 화면에서 이미 겪었다 — 문구
 * 앞 두 글자로 성공/실패를 가르고 있어서 번역을 고치자 색이 뒤집혔다.
 * 색은 **상태**를 따라야 한다.
 *
 * 검사
 *  1) 관리·손님 화면(React): 실패 문구를 담는 상태 변수를 찾아, 그 변수를
 *     그리는 자리의 색이 성공 색으로 **고정**돼 있으면 잡는다.
 *  2) 플러그인(서버가 HTML 로 그리는 화면): 클라이언트 스크립트가
 *     querySelector 로 찾는 메시지 칸의 CSS 색이 성공 색뿐이면 잡는다.
 *     (실패용 색이 어딘가에 있으면 통과 — 클래스를 바꾸든 style 을 주든)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SUCCESS = "--color-success";
/** 실패를 담았다는 표시 — 번역 키와 코드 어느 쪽으로 적었든 */
const FAILISH = /[Ff]ail|실패|catch\s*\(|\.message|errors/;

let checked = 0;
const bad = [];

/* ── 1) React 화면 ─────────────────────────────────── */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

for (const file of walk(join(ROOT, "apps/web/src"))) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  // 메시지 상태 변수 가운데 **실패도 담는** 것들
  const carriesFail = new Set();
  for (const m of src.matchAll(/const \[(\w*(?:essage|[Mm]sg|otice)\w*), (set\w+)\]/g)) {
    const setter = new RegExp(`\\b${m[2]}\\(([\\s\\S]{0,400}?)\\);`, "g");
    for (const call of src.matchAll(setter)) {
      if (FAILISH.test(call[1])) { carriesFail.add(m[1]); break; }
    }
  }
  if (!carriesFail.size) continue;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(SUCCESS)) continue;
    const blob = lines.slice(Math.max(0, i - 3), i + 2).join("\n");
    // 결과에 따라 갈리는 색이면 통과 (failed ? danger : success 등)
    if (blob.includes("--color-danger")) continue;
    const shown = [...blob.matchAll(/\{(?:props\.)?(\w+)\}/g)].map((m) => m[1]);
    if (!shown.some((v) => carriesFail.has(v))) continue;
    checked++;
    bad.push([`${file.slice(ROOT.length)}:${i + 1}`, lines[i].trim().slice(0, 80)]);
  }
  checked += carriesFail.size; // 실패를 담는 자리를 본 것 자체를 센다
}

/* ── 2) 플러그인이 HTML 로 그리는 메시지 칸 ────────── */
const pluginFiles = [];
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) pluginFiles.push(join(dir, f));
}
const sources = pluginFiles.map((f) => [f, readFileSync(f, "utf8")]);
const msgClasses = new Set();
for (const [, src] of sources) {
  for (const m of src.matchAll(/querySelector\(['"]\.([a-z0-9-]*(?:msg|message|error|status)[a-z0-9-]*)['"]\)/g)) {
    msgClasses.add(m[1]);
  }
}
for (const cls of msgClasses) {
  for (const [f, src] of sources) {
    // `.cls{…}` 선언 가운데 성공 색을 쓰는 것
    // 앞에 태그가 붙을 수 있다 — 테마의 `.brick-main p` 를 이기려면 `p.클래스` 로 적는다
    for (const m of src.matchAll(new RegExp(`^[a-z]*\\.${cls}\\s*\\{[^}]*\\}`, "gm"))) {
      if (!m[0].includes(SUCCESS)) continue;
      checked++;
      // 실패용 색이 같은 파일 어딘가에 있으면 통과
      const hasFailColor = new RegExp(`\\.${cls}[.:][^{]*\\{[^}]*--color-danger`).test(src)
        || new RegExp(`${cls}[^\\n]{0,120}--color-danger`).test(src);
      if (hasFailColor) continue;
      bad.push([`${f.slice(ROOT.length)}:${src.slice(0, m.index).split("\n").length}`, m[0].slice(0, 80)]);
    }
  }
}

console.log("▶ 실패를 성공 색으로 보여주지 않는다");
if (!checked) { console.log("  ❌ 메시지 자리를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 메시지 자리: ${checked}군데`);
for (const [where, text] of bad) console.log(`  ❌ ${where}  ${text}`);
console.log(bad.length
  ? "\n초록 글씨로 \"실패\" 라고 적힌 화면입니다 — 색을 상태에 따라 가르세요(문구로 판별하지 마세요)."
  : "\n실패는 실패 색으로 보입니다.");
process.exit(bad.length ? 1 : 0);
