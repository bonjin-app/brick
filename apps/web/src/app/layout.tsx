import type { ReactNode } from "react";

/**
 * 웹(CSR 화면: 로그인·가입·내 정보·관리자)의 루트.
 *
 * 배경과 색 스킴을 여기서 명시한다 — 정하지 않으면 브라우저 다크 모드의
 * UA 스타일이 html 배경을 검게 칠해서, 내용이 화면보다 길거나 오버스크롤될
 * 때 검은 영역이 드러나고 기본 글자색도 뒤집힌다. 코어 화면은 전부 밝은
 * 스킴으로 스스로 완결적이다.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" style={{ background: "#f5f6f8", colorScheme: "light" }}>
      <body style={{ margin: 0, background: "#f5f6f8", color: "#1a1a1a" }}>{children}</body>
    </html>
  );
}
