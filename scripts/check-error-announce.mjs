#!/usr/bin/env node
/*
 * 오류를 **눈으로만** 알려주고 있지 않은가.
 *
 * 왜 필요했나: 로그인 화면에서 비밀번호를 틀리면 버튼 아래에 빨간 글씨가
 * 나타난다. 그런데 그 문단에는 `role="alert"` 도 `aria-live` 도 없었다 —
 * 브라우저로 확인했더니 라이브 영역이 **하나도 없었다**(`live: []`).
 * 스크린리더 사용자에게는 버튼을 눌렀는데 아무 일도 일어나지 않은 화면이다.
 * 초점은 버튼에 남아 있고, 화면 어딘가에 생긴 글씨는 읽히지 않는다.
 *
 * 가입 화면만 `role="alert"` 를 갖고 있었다 — 한 곳에서 고치고 나머지
 * 열한 곳이 남은, 이 저장소가 여러 번 겪은 모양이다(키보드 접근, 표 접기,
 * 작은 터치 영역이 모두 그랬다).
 *
 * 검사: 오류 색(--color-danger)으로 그리는 **상태 변수**(error·message·msg·fail)
 * 를 찾아, 그 요소에 role/aria-live 가 있는지 본다. 색만 쓰는 버튼이나 필수
 * 표시(*)는 상태 변수가 아니므로 걸리지 않는다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "apps/web/src");

/*
 * {error && …} · {msg ? …} 처럼 **상태를 조건으로** 그리는 자리.
 *
 * 처음에는 여는 중괄호 **바로 뒤**의 변수만 봤다. 그래서 `{(notice || error) && …}`
 * 를 놓쳤고, 마이페이지의 알림 배너가 검사에 걸리지 않은 채 남아 있었다 —
 * 비밀번호를 틀렸다는 안내가 화면에는 뜨는데 스크린리더에는 아무것도 가지
 * 않았다. 괄호와 앞선 조건을 건너뛰고 본다.
 */
const STATEFUL = /\{[^{}]{0,60}\b\w*(?:rror|essage|[Mm]sg|[Ff]ail)\w*\b[^{}]{0,20}(?:\?|&&)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

let checked = 0;
const bad = [];
for (const file of walk(WEB)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!STATEFUL.test(lines[i])) continue;
    /*
     * 한 줄로 끝나지 않는 JSX 가 많다. 뒤 세 줄만 보면 **여는 태그가 위에 있는**
     * 경우를 놓친다(role 은 태그에 붙고 색은 다음 줄 style 에 있다) — 앞 두 줄도
     * 함께 본다.
     */
    const blob = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
    if (!blob.includes("color-danger")) continue;
    checked++;
    /*
     * 이유를 적어 둔 제외는 인정한다 — "읽어주지 않음: …". 빠뜨린 것과 정한 것을
     * 구별하는 것이 이 검사의 요지다(autocomplete 검사의 off 와 같은 원칙).
     */
    if (/role="alert"|role="status"|aria-live|role=\{/.test(blob)) continue;
    // 이유를 적어 둔 제외는 바로 위 주석 블록에 있을 수 있다 — 조금 더 위까지 본다
    if (/읽어주지 않음/.test(lines.slice(Math.max(0, i - 8), i + 1).join("\n"))) continue;
    bad.push([`${file.slice(ROOT.length)}:${i + 1}`, lines[i].trim().slice(0, 80)]);
  }
}

/*
 * 플러그인이 **서버에서 그리는** 메시지 자리도 같이 본다.
 *
 * 관리·손님 화면은 React 지만, 상품·게시판·후기는 플러그인이 HTML 문자열로
 * 그리고 클라이언트 스크립트가 그 안에 메시지를 써 넣는다. 그쪽만 보고 끝냈다면
 * 후기 작성 폼 둘을 놓쳤을 것이다 — 실제로 이 절을 더하자마자 나왔다.
 *
 * 판정: 클라이언트 스크립트가 `querySelector('.…-msg')` 로 찾는 클래스가
 * 선언된 태그에 role/aria-live 가 있는가.
 */
const pluginFiles = [];
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) pluginFiles.push(join(dir, f));
}
const msgClasses = new Set();
for (const f of pluginFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/querySelector\(['"]\.([a-z0-9-]*(?:msg|message|error|status)[a-z0-9-]*)['"]\)/g)) {
    msgClasses.add(m[1]);
  }
}
for (const cls of msgClasses) {
  for (const f of pluginFiles) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(new RegExp(`<[^>]*class=\\\\?"[^"]*\\b${cls}\\b[^"]*\\\\?"[^>]*>`, "g"))) {
      checked++;
      if (/role=\\?"(alert|status)\\?"|aria-live/.test(m[0])) continue;
      bad.push([`${f.slice(ROOT.length)}:${src.slice(0, m.index).split("\n").length}`, m[0].slice(0, 80)]);
    }
  }
}

console.log("▶ 오류를 눈으로만 알려주지 않는다");
if (!checked) { console.log("  ❌ 오류 표시를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 오류 표시: ${checked}군데`);
for (const [where, text] of bad) console.log(`  ❌ ${where}  ${text}`);
console.log(bad.length
  ? "\n스크린리더에는 아무 일도 일어나지 않은 화면입니다 — role=\"alert\" 를 붙이세요."
  : "\n모두 읽어줍니다.");
process.exit(bad.length ? 1 : 0);
