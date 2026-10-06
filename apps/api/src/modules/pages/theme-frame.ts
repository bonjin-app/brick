/**
 * 테마 틀 — Next 가 그리는 화면(로그인 · 가입 · 마이페이지)에 입힐 사이트의 머리 · 푸터.
 *
 * 공개 화면은 API 가 테마 템플릿으로 그리고, 로그인·가입·마이페이지는 Next 가 그린다. 그래서 손님이 로그인으로 넘어가는
 * 순간 머리(로고 · 검색 · 메뉴 · 장바구니)와 푸터(사업자정보 · 약관)가 사라지고 가운데 카드만 남았다 — 다른 사이트로
 * 간 것처럼 보이고, 주문만 찾으러 온 비회원이 메뉴도 검색도 없는 화면에 서 있었다. 색 토큰만 나눠 쓰던 것(루트 레이아웃의
 * tokens.css)을 한 걸음 더 나아가, **테마가 본문 자리만 비운 문서를 그리게 하고 그 머리와 푸터를 잘라** Next 가 입힌다.
 *
 * 조각은 균형 잡힌 요소로 자른다: 머리 쪽(`before`)과 푸터 쪽(`after`)은 각각 닫힌 요소들의 나열이고, 본문(`<main>`)은
 * Next 가 자기 요소로 그린다(속성만 받아 간다). `<main ...>` 을 두 조각에 걸쳐 열고 닫으면 브라우저가 균형을 맞추면서
 * 하이드레이션이 깨진다.
 *
 * **못 자르면 null 이다** — 테마에 `<main>` 이 없거나 모양이 낯설면 Next 화면은 지금처럼 단독으로 뜬다. 틀은 꾸밈이고,
 * 로그인을 막으면 안 된다.
 */
export interface ThemeFrame {
  /** 같은 출처의 스타일시트 주소 — 바깥 주소(웹폰트 CDN 등)는 Next 화면의 CSP 가 막으므로 걸러 낸다 */
  stylesheets: string[];
  /** 머리의 인라인 `<style>` 내용 */
  styles: string[];
  /** `<main>` 앞 — 스프라이트 · 건너뛰기 링크 · 맨 위 띠 · 머리 */
  before: string;
  /** 테마가 `<main>` 에 단 클래스와 id (건너뛰기 링크가 가리키는 자리) */
  mainClass: string;
  mainId: string;
  /** `</main>` 뒤 — 푸터 · 스크립트 */
  after: string;
}

/** 본문 자리를 표시하는 글 — 테마가 그린 문서에서 `<main>` 안은 버리므로 어떤 글이든 되지만, 비면 테마가 건너뛸 수 있다 */
export const FRAME_SLOT = "BRICK_FRAME_SLOT";

/** 틀 전용 경로 — 공개 경로(`/api/render/page`)로는 열리지 않는다(renderPath 의 frame 옵션이 있어야 한다) */
export const FRAME_PATH = "__frame__";

function attr(attrs: string, name: string): string {
  // 따옴표 안의 값만 읽는다 — 테마 템플릿은 늘 따옴표를 쓴다
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? "") : "";
}

export function splitThemeFrame(html: string): ThemeFrame | null {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html);
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const mainOpen = /<main\b([^>]*)>/i.exec(html);
  const mainClose = html.toLowerCase().lastIndexOf("</main>");
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (!head || !bodyOpen || !mainOpen || mainClose < 0 || bodyClose < 0) return null;
  const bodyStart = bodyOpen.index + bodyOpen[0].length;
  const mainStart = mainOpen.index + mainOpen[0].length;
  // 순서가 뒤집힌 문서는 믿지 않는다
  if (!(bodyStart <= mainOpen.index && mainStart <= mainClose && mainClose + 7 <= bodyClose)) return null;

  const stylesheets: string[] = [];
  for (const m of head[1].matchAll(/<link\b([^>]*)>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(m[1])) continue;
    const href = attr(m[1], "href");
    // 사이트 안 경로만 — 프로토콜 상대(//…)와 바깥 주소는 Next 화면의 CSP(style-src 'self')가 막는다
    if (/^\/(?![/\\])/.test(href)) stylesheets.push(href);
  }
  const styles = [...head[1].matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).filter((s) => s.trim());

  return {
    stylesheets,
    styles,
    before: html.slice(bodyStart, mainOpen.index),
    mainClass: attr(mainOpen[1], "class"),
    mainId: attr(mainOpen[1], "id"),
    after: html.slice(mainClose + 7, bodyClose),
  };
}
