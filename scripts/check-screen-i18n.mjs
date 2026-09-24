#!/usr/bin/env node
/*
 * 손님 화면을 그리는 코드에 **한국어가 박혀 있지 않은가**.
 *
 * 왜 필요했나: 사이트 언어를 en 으로 두고 1:1 문의를 열면 화면이 통째로
 * 한국어였다 — brick-helpdesk 의 손님 화면은 `t()` 를 일곱 번밖에 쓰지 않고
 * 문구를 코드에 박아 두고 있었다(게시판 159 · 쇼핑몰 358 과 비교된다).
 * 게시판도 절반만 옮겨져 있었다: 목록·상세는 번역되는데 **에디터와 댓글**의
 * prompt·alert·상태 문구 스물몇 개가 한국어로 남아, 영어 사이트에서 글을
 * 쓰기 시작하는 순간 한국어가 튀어나왔다. 팝업(brick-site)도 같았다.
 *
 * 검사: 화면을 그리는 파일(blocks · views · *-view · client-script)의
 * **템플릿 리터럴 안**에 한글이 남아 있으면 잡는다. `${t("…")}` 같은 보간은
 * 번역을 거치므로 지우고 보고, 주석(//, 슬래시-별, SQL 의 --)도 지운다.
 *
 * 한계 하나 더: 화면 코드가 index.ts 안에 있는 플러그인(포인트 내역)은 대상이
 * 아니다. index.ts 는 서버 오류 메시지가 가득한 파일이고, 그쪽 번역은 아직
 * 정해지지 않은 별도의 일이다(로드맵). 화면을 따로 빼면 이 검사가 받는다.
 *
 * 한계: 선언(registerBlock 의 displayName·propsSchema)은 보지 않는다 —
 * 그쪽은 "한국어 원문이 곧 키" 인 다른 길이고, 블록 카탈로그 번역은 아직
 * 정해지지 않았다(로드맵).
 *
 * 사용법: node scripts/check-screen-i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCREEN_FILE = /(^|[-/])(blocks|views|client-script|[a-z-]+-view)\.ts$/;
const HANGUL = /[가-힣]/;

/** `${ … }` 를 지운다 — 중첩 중괄호를 센다 */
function stripInterpolations(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
    } else out += src[i++];
  }
  return out;
}

/*
 * 주석을 지운다. **템플릿 리터럴을 찾기 전에** 파일 전체에 적용한다 —
 * 주석 안에 백틱으로 감싼 경로(`/shop/restock/cancel/<토큰>`)를 적어 두는
 * 일이 이 저장소에 흔하고, 나중에 지우면 그것이 화면 문자열로 잡힌다.
 * `//` 는 앞이 콜론이 아닐 때만 주석으로 본다(http:// 를 지우지 않게).
 */
function stripComments(src) {
  // 지우되 **자리는 남긴다**(공백으로) — 줄 번호가 원본과 맞아야 고칠 곳을 찾는다
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length))
    .replace(/(^|\s)--[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

/*
 * 문자열을 **모든 깊이에서** 모은다: 템플릿의 정적 부분과 따옴표 문자열.
 *
 * 전에는 백틱을 정규식으로 두 개씩 짝지었다. 보간 안에 템플릿이 또 있으면
 * (`${ cond ? `<a>더보기</a>` : "" }`) 짝이 어긋나 안쪽 문자열이 짝과 짝 **사이**에
 * 떨어져 한 번도 검사되지 않았다 — 게시판 최신글의 "더보기" 가 그렇게 남았다.
 * 따옴표 문자열도 보지 않았다: `{ label: "오늘" }` 로 담았다가 나중에 HTML 에 끼우면
 * 그대로 한국어가 나간다(방문자 블록이 그랬다 — 영어 카탈로그에 번역까지 있었는데
 * 코드가 부르지 않았다).
 */
function literals(src) {
  const parts = [];   // { kind: "template" | "quoted", text, index }
  let i = 0;
  const readQuoted = (q) => {
    const start = i + 1;
    i++;
    while (i < src.length && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") i++; i++; }
    parts.push({ kind: "quoted", text: src.slice(start, i), index: start });
    i++;
  };
  const readExpr = () => {
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"') { readQuoted(c); continue; }
      if (c === "`") { readTemplate(); continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { i++; return; }
      i++;
    }
  };
  const readTemplate = () => {
    i++;
    let start = i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        parts.push({ kind: "template", text: src.slice(start, i), index: start });
        i += 2; readExpr(); start = i; continue;
      }
      i++;
    }
    parts.push({ kind: "template", text: src.slice(start, i), index: start });
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { readQuoted(c); continue; }
    if (c === "`") { readTemplate(); continue; }
    i++;
  }
  return parts;
}

/*
 * 따옴표 문자열 중 **화면에 나가지 않는 것**: 번역 함수의 인자(원문이 곧 키),
 * 그리고 선언(블록 이름·속성 설명·편집기 초깃값 — 위의 "한계" 참고).
 */
const TRANSLATED_ARG = /(?:\bt|\.t|\btt|\blabel|\bwithJosa)\(\s*$/;
const DECLARATION = /(?:displayName|title|description|help|placeholder|summary|default)\s*:\s*$/;

console.log("▶ 손님 화면을 그리는 코드에 한국어가 박혀 있지 않다");

const bad = [];
let files = 0;
for (const plugin of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", plugin, "src");
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  for (const name of readdirSync(dir)) {
    if (!SCREEN_FILE.test(name)) continue;
    files++;
    const file = join(dir, name);
    const src = stripComments(readFileSync(file, "utf8"));
    // `"앞" + "뒤"` 로 이어 붙인 문자열은 앞 문자열의 분류를 따른다(긴 설명을 줄 나눠 적는다)
    let skippedEnd = -1;
    for (const part of literals(src)) {
      if (part.kind === "quoted") {
        const before = src.slice(Math.max(0, part.index - 60), part.index - 1);
        const continues = skippedEnd >= 0 && /^["']?\s*\+\s*$/.test(src.slice(skippedEnd, part.index - 1));
        if (continues || TRANSLATED_ARG.test(before) || DECLARATION.test(before)) {
          skippedEnd = part.index + part.text.length;
          continue;
        }
      }
      if (!HANGUL.test(part.text)) continue;
      const first = src.slice(0, part.index).split("\n").length;
      for (const [i, line] of part.text.split("\n").entries()) {
        if (HANGUL.test(line)) bad.push(`${file.slice(ROOT.length)}:${first + i}  ${line.trim().slice(0, 70)}`);
      }
    }
  }
}

if (!files) { console.log("  ❌ 화면 파일을 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 화면 파일: ${files}개`);
for (const b of bad) console.log(`  ❌ ${b}`);
console.log(bad.length
  ? "\n영어로 쓰는 사이트에서 이 문구만 한국어로 나옵니다 — t(\"키\") 로 옮기고 locales/{ko,en}.json 에 넣으세요."
  : "\n모두 카탈로그를 거칩니다.");
process.exit(bad.length ? 1 : 0);
