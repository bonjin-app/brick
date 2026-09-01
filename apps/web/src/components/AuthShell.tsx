"use client";

import type { CSSProperties, ReactNode } from "react";
import { useSiteName } from "../lib/i18n";

/**
 * 로그인·가입·비밀번호 화면의 공용 껍데기.
 *
 * **색은 사이트 테마 토큰을 쓴다** (루트 레이아웃이 /api/themes/tokens.css 를
 * 불러온다). 인증 화면이 자기 색을 들고 있으면 손님이 로그인으로 넘어가는
 * 순간 사이트가 바뀐 것처럼 보이고 다크 모드도 거기서 끊긴다 — 실제로 그랬다.
 * 토큰이 없는 상황(설치 전·네트워크 실패)에서는 레이아웃의 폴백 팔레트가
 * 같은 변수를 채워 준다.
 *
 * 사이트 이름을 머리글로 보여주고 홈으로 돌아가는 길을 항상 둔다 —
 * 로그인 화면에서 사이트로 돌아갈 방법이 없으면 손님은 뒤로가기뿐이다.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  /** 제목 아래 한 줄 설명 (무엇을 하는 화면인지) */
  subtitle?: string;
  children: ReactNode;
  /** 카드 아래 안내 (가입 링크 등) */
  footer?: ReactNode;
}) {
  const siteName = useSiteName();

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: "48px 16px",
        background: "var(--color-bg-soft)",
        color: "var(--color-text)",
      }}
    >
      <a
        href="/"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          textDecoration: "none",
          color: "var(--color-text)",
          fontWeight: 800,
          fontSize: 20,
          letterSpacing: "-0.6px",
        }}
      >
        <span
          aria-hidden
          style={{ width: 9, height: 9, borderRadius: 3, background: "var(--color-primary)" }}
        />
        {siteName || " "}
      </a>

      <section
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--color-bg)",
          border: "1px solid var(--color-line)",
          borderRadius: "var(--radius-lg)",
          padding: "30px 28px 28px",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: "-0.6px", fontWeight: 800 }}>{title}</h1>
        {subtitle ? (
          <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--color-muted)", lineHeight: 1.6 }}>
            {subtitle}
          </p>
        ) : null}
        <div style={{ marginTop: 22 }}>{children}</div>
      </section>

      {footer ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--color-muted)", textAlign: "center" }}>
          {footer}
        </p>
      ) : null}
    </main>
  );
}

/** 인증 화면 공용 입력 스타일 */
export const authInput: CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  marginTop: 6,
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius)",
  font: "inherit",
  fontSize: 15,
  background: "var(--color-bg)",
  color: "var(--color-text)",
};

/** 인증 화면 공용 제출 버튼 스타일 */
export const authButton: CSSProperties = {
  width: "100%",
  padding: 13,
  marginTop: 22,
  cursor: "pointer",
  border: 0,
  borderRadius: "var(--radius)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  font: "inherit",
  fontSize: 15,
  fontWeight: 700,
};

/** 라벨(작은 글씨) 스타일 */
export const authLabel: CSSProperties = {
  display: "block",
  marginTop: 16,
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--color-text-soft)",
};

/** 인증 화면 안의 링크 — 브랜드 색을 쓴다 (브라우저 기본 파란 링크 금지) */
export const authLink: CSSProperties = {
  color: "var(--color-primary-text)",
  fontWeight: 600,
  textDecoration: "none",
};
