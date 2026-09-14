/**
 * 누를 수 있는 것은 키보드로도 닿는가.
 *
 * `<div onClick={…}>` 은 마우스로만 눌린다. Tab 으로 닿지 않고, 스크린리더는
 * 그것을 "그냥 글"로 읽는다. 보기에는 버튼과 똑같아서 눈으로는 발견되지 않고,
 * 화면 감사(ui-audit)도 **이름 없는 버튼**은 잡지만 애초에 버튼이 아닌 것은
 * 잡지 못한다.
 *
 * 실제로 CMS 의 중심 화면 둘이 그랬다:
 *   - 페이지 편집기의 블록 고르기 — 열여덟 개 선택지가 전부 div 였다.
 *   - 메뉴의 연결 대상 고르기 — 같은 모양.
 * 그리고 페이지 목록은 **행 클릭이 유일한 진입로**여서, 키보드만 쓰는 사람은
 * 페이지를 열 수조차 없었다(수정 버튼이 따로 없다).
 *
 * 규칙: 상호작용 요소가 아닌 태그에 onClick 을 달려면 `role` 과 `tabIndex` 를
 * 함께 주거나, 그냥 `<button type="button">` 을 쓴다. `aria-hidden` 인 것은
 * 뺀다 — 배경 덮개처럼 **보조적인 클릭 영역**은 키보드 경로가 따로 있다.
 *
 * 사용법: node scripts/check-admin-keyboard.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "apps/web/src");
const PASSIVE = /^(div|span|li|td|tr|section|article|p|img|h[1-6]|ul|ol|label)$/;

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

console.log("▶ 누를 수 있는 것은 키보드로도 닿는다");
const bad = [];
let clicks = 0;
for (const file of walk(WEB)) {
  const src = readFileSync(file, "utf8");
  const re = /<([a-zA-Z][\w-]*)\b([^>]*?)onClick=/gs;
  let m;
  while ((m = re.exec(src))) {
    const [, tag, attrs] = m;
    if (!PASSIVE.test(tag)) continue;          // button·a 는 원래 닿는다
    clicks++;
    /*
     * 여는 태그의 끝을 찾는다. `indexOf(">")` 로는 안 된다 — onClick 의 화살표
     * 함수(`() => …`)에 들어 있는 `>` 에 먼저 걸려서, 그 뒤에 오는
     * aria-hidden·role 을 못 본다. 중괄호 깊이를 세면서 지나간다.
     */
    const opening = (() => {
      let depth = 0;
      for (let i = m.index; i < Math.min(src.length, m.index + 1200); i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) return src.slice(m.index, i);
      }
      return src.slice(m.index, m.index + 1200);
    })();
    if (/aria-hidden/.test(opening)) continue;  // 보조 클릭 영역 (배경 덮개 등)
    /*
     * 대화상자 자신의 onClick 은 "배경을 눌러 닫기"다. 키보드 경로는 Esc 와
     * 닫기 버튼이고, 그쪽은 useModalFocus 검사가 따로 본다(진입·트랩·복귀).
     */
    if (/role="dialog"/.test(opening)) continue;
    if (/role=/.test(opening) && /tabIndex/.test(opening)) continue;
    /*
     * 표의 행은 버튼이 될 수 없다. 행 클릭은 마우스 편의이고, **행 안에 키보드로
     * 닿는 조작이 있으면** 그것이 키보드 경로다(페이지 목록은 제목이 버튼이다).
     */
    if (tag === "tr") {
      const rowEnd = src.indexOf("</tr>", m.index);
      const row = src.slice(m.index, rowEnd > 0 ? rowEnd : m.index + 2000);
      if (/<button|<a\s/.test(row)) continue;
    }
    const line = src.slice(0, m.index).split("\n").length;
    bad.push(`${file.slice(ROOT.length)}:${line}  <${tag} … onClick> — 버튼으로 바꾸거나 role·tabIndex 를 주세요`);
  }
}

if (bad.length) {
  for (const b of bad) console.log(`  ❌ ${b}`);
  console.log(`\n마우스로만 눌립니다 — ${bad.length}곳.`);
  process.exit(1);
}
console.log(`  ✅ 상호작용이 아닌 태그의 onClick ${clicks}곳이 모두 키보드 경로를 가진다`);
