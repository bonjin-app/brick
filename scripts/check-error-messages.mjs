#!/usr/bin/env node
/*
 * 손님과 운영자에게 **영어 오류 메시지**가 가지 않는가.
 *
 * 왜 필요했나: 비밀번호를 틀리면 로그인 화면에 `invalid credentials` 가 떴다.
 * 화면은 서버가 준 message 를 그대로 보여주고(한국어 대체 문구는 message 가
 * 아예 없을 때만 쓰인다), 그래서 한국어 사이트의 가장 흔한 오류 화면이 영어였다.
 * 관리자가 상품 설명을 한참 쓰고 저장을 눌렀을 때 뜨는 것은 `Unauthorized`
 * 였고(메시지를 비우면 Nest 가 넣는 기본값이다), 페이지 주소가 겹치면
 * `slug "..." already exists`, 테마 zip 이 잘못되면 zip 구조 설명이 영어로 나왔다.
 *
 * 그래서 HTTP 예외의 메시지에 한글이 있는지 본다. 예외를 던지는 곳은 대부분
 * **화면에 그대로 뜨는 자리**다.
 *
 * 예외로 두는 것:
 *   - 메시지가 변수인 경우 (그 값이 이미 한국어일 수 있다)
 *   - 사람이 읽지 않는 응답 — 헬스 체크 JSON, 정적 파일 404
 *   - ALLOW 에 이유와 함께 적어 둔 것
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// 사람이 읽지 않는 응답만 면제한다 — 이유를 적지 않은 면제는 두지 않는다
const ALLOW = [
  ["modules/health/health.controller.ts", "기계가 읽는 헬스 체크 JSON"],
  ["modules/setup/setup-health.controller.ts", "기계가 읽는 헬스 체크 JSON"],
  ["modules/static/static.controller.ts", "정적 파일 404 — 브라우저가 처리한다"],
  ["modules/media/media.controller.ts:", "본문 없는 404 (파일 스트림 경로)"],
];

const EXC = /new (BadRequest|Unauthorized|Forbidden|NotFound|Conflict|Gone|PayloadTooLarge|UnprocessableEntity|InternalServerError|ServiceUnavailable|Http)\w*Exception\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const roots = [join(ROOT, "apps/api/src")];
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const src = join(ROOT, "plugins", p, "src");
  try { if (statSync(src).isDirectory()) roots.push(src); } catch { /* 없으면 건너뛴다 */ }
}

let total = 0;
const bad = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(ROOT.length);
    if (ALLOW.some(([frag]) => rel.includes(frag.split(":")[0]))) continue;
    for (const m of [...src.matchAll(EXC)]) {
      total++;
      // 여는 괄호부터 짝이 맞는 닫는 괄호까지가 인자다
      let depth = 0, end = m.index;
      for (let j = m.index + m[0].length - 1; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) { end = j; break; }
      }
      const arg = src.slice(m.index + m[0].length, end);
      /*
       * 인자가 **문자열로 시작**할 때만 검사한다. 안에 따옴표가 섞여 있는 것만
       * 보면 `errors.join(" ")` 이나 객체를 만드는 삼항식까지 문자열로 읽힌다
       * (실제로 둘 다 걸렸다) — 그 값이 한국어인지는 여기서 알 수 없다.
       *
       * 다만 **같은 파일의 상수**는 따라간다. 문구를 한 곳에 모으는 것은 좋은
       * 습관이고(로그인 거절 문구가 그렇다), 그때 검사가 눈을 감으면 이 검사를
       * 피해 가는 가장 쉬운 길이 된다 — 실제로 처음 판은 그렇게 놓쳤다.
       */
      let text = arg.trim();
      const ident = text.match(/^([A-Z][A-Z0-9_]*)$/);
      if (ident) {
        const def = src.match(new RegExp(`const ${ident[1]}\\s*=\\s*(["\'\`][^"\'\`]*["\'\`])`));
        if (!def) continue;
        text = def[1];
      } else if (!/^["'`]/.test(text)) continue;
      if (/[가-힣]/.test(text)) continue;
      bad.push([`${rel}:${src.slice(0, m.index).split("\n").length}`, text.replace(/\s+/g, " ").slice(0, 70)]);
    }
  }
}

console.log("▶ 오류 메시지가 한국어다");
if (!total) { console.log("  ❌ 예외를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 HTTP 예외: ${total}건`);
for (const [where, text] of bad) console.log(`  ❌ ${where}  ${text}`);
console.log(bad.length
  ? "\n화면은 서버가 준 message 를 그대로 보여줍니다 — 영어로 적으면 손님이 영어를 봅니다."
  : "\n모두 한국어입니다.");
process.exit(bad.length ? 1 : 0);
