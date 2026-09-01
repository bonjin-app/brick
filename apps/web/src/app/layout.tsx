import type { ReactNode } from "react";

/**
 * 웹(CSR 화면: 로그인·가입·내 정보·관리자)의 루트.
 *
 * **여기서 사이트 테마와 이어붙인다.** 공개 화면은 API 가 테마 템플릿으로
 * 그리고, 이 화면들은 Next 가 그린다. 팔레트를 각자 들고 있으면 손님이
 * 로그인 화면으로 넘어가는 순간 사이트가 바뀐 것처럼 보이고, 다크 모드도
 * 거기서 끊긴다 — 실제로 그랬다.
 *
 *   - `/api/themes/tokens.css` = 활성 테마의 색 토큰(라이트 + 다크).
 *   - 인라인 스크립트 = 손님이 고른 화면 모드(localStorage) 를 CSS 보다 먼저
 *     적용한다. 없으면 다크 사용자에게 흰 화면이 한 프레임 번쩍인다.
 *
 * 토큰이 아직 안 왔을 때(설치 전, 네트워크 실패)도 화면이 읽혀야 하므로
 * 아래 :root 폴백을 함께 심는다.
 */
const FALLBACK_TOKENS = `
:root {
  --color-primary: #cf4437; --color-primary-hover: #b63a2e;
  --color-primary-soft: #fdeeec; --color-primary-text: #b63a2e;
  --color-on-primary: #ffffff;
  --color-bg: #ffffff; --color-bg-soft: #f6f6f9; --color-bg-sunken: #eeeef3;
  --color-text: #17171c; --color-text-soft: #45454f; --color-muted: #6c6c7a;
  --color-line: #e4e4ea; --color-line-strong: #d0d0d9;
  --color-danger: #c9342f; --color-success: #11795a; --color-warning: #96610a;
  --radius: 10px; --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(18,18,28,.07), 0 1px 8px rgba(18,18,28,.04);
  --shadow-md: 0 4px 12px rgba(18,18,28,.09), 0 12px 32px rgba(18,18,28,.07);
  --font-body: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, system-ui, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-primary: #ff6f5f; --color-primary-hover: #ff8b7d;
    --color-primary-soft: #2c1a18; --color-primary-text: #ff8f82;
    --color-on-primary: #26100c;
    --color-bg: #101116; --color-bg-soft: #17181f; --color-bg-sunken: #1c1d25;
    --color-text: #ececf1; --color-text-soft: #c3c3cd; --color-muted: #9797a6;
    --color-line: #292a33; --color-line-strong: #3b3c48;
    --color-danger: #ff7a72; --color-success: #3ec79d; --color-warning: #e5a844;
  }
}
:root[data-theme="dark"] {
  --color-primary: #ff6f5f; --color-primary-hover: #ff8b7d;
  --color-primary-soft: #2c1a18; --color-primary-text: #ff8f82;
  --color-on-primary: #26100c;
  --color-bg: #101116; --color-bg-soft: #17181f; --color-bg-sunken: #1c1d25;
  --color-text: #ececf1; --color-text-soft: #c3c3cd; --color-muted: #9797a6;
  --color-line: #292a33; --color-line-strong: #3b3c48;
  --color-danger: #ff7a72; --color-success: #3ec79d; --color-warning: #e5a844;
}
/* 손님이 고른 밝기를 UA 위젯(스크롤바·체크박스·파일 선택)에도 알린다 —
   meta 만으로는 OS 설정을 따라서, 토글로 다크를 골라도 흰 체크박스가 남는다 */
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
html, body { background: var(--color-bg-soft); color: var(--color-text); }
body { margin: 0; font-family: var(--font-body); -webkit-font-smoothing: antialiased; }
* { box-sizing: border-box; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
/* 체크박스·라디오는 accent-color 를 주지 않으면 다크에서 흰 사각형으로 남는다 */
input[type="checkbox"], input[type="radio"] { accent-color: var(--color-primary); width: 16px; height: 16px; }
input, select, textarea, button { font-family: inherit; }
input::placeholder, textarea::placeholder { color: var(--color-muted); }
`;

const THEME_BOOT = `(function(){try{var v=localStorage.getItem("brick-theme");
if(v==="dark"||v==="light")document.documentElement.dataset.theme=v;}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <style dangerouslySetInnerHTML={{ __html: FALLBACK_TOKENS }} />
        {/* 활성 테마의 실제 색 — 폴백 뒤에 와서 이긴다 */}
        <link rel="stylesheet" href="/api/themes/tokens.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
