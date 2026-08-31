"use client";

import type { ReactNode } from "react";
import { useSiteName } from "../lib/i18n";

/**
 * 로그인·가입·비밀번호 화면의 공용 껍데기.
 *
 * 색을 전부 명시한다 — 루트 레이아웃이 배경을 정하지 않으면 브라우저
 * 다크 모드의 UA 스타일이 배경만 검게 칠해서, 검정 라벨이 검정 배경에
 * 묻히는 화면이 나온다 (실제로 그랬다). 인증 화면은 테마 밖의 코어
 * 화면이므로 스스로 완결적이어야 한다.
 *
 * 사이트 이름을 머리글로 보여주고 홈으로 돌아가는 길을 항상 둔다 —
 * 로그인 화면에서 사이트로 돌아갈 방법이 없으면 손님은 뒤로가기뿐이다.
 */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  const siteName = useSiteName();

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        background: "#f5f6f8",
        color: "#1a1a1a",
        colorScheme: "light",
        fontFamily: "'Pretendard', 'Apple SD Gothic Neo', sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "9vh 16px 48px",
        boxSizing: "border-box",
      }}
    >
      <a
        href="/"
        style={{
          textDecoration: "none",
          color: "#e2574c",
          fontWeight: 800,
          fontSize: 22,
          letterSpacing: "-0.5px",
          marginBottom: 22,
        }}
      >
        {siteName || " "}
      </a>
      <section
        style={{
          width: "100%",
          maxWidth: 400,
          background: "#fff",
          border: "1px solid #e7e7ec",
          borderRadius: 14,
          padding: "30px 28px 26px",
          boxShadow: "0 8px 28px rgba(20,20,31,.06)",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ margin: "0 0 18px", fontSize: 21, letterSpacing: "-0.4px" }}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** 인증 화면 공용 입력 스타일 */
export const authInput = {
  width: "100%",
  padding: "10px 12px",
  marginTop: 6,
  boxSizing: "border-box" as const,
  border: "1px solid #d9d9e0",
  borderRadius: 8,
  font: "inherit",
  background: "#fff",
  color: "#1a1a1a",
};

/** 인증 화면 공용 제출 버튼 스타일 */
export const authButton = {
  width: "100%",
  padding: 12,
  marginTop: 22,
  cursor: "pointer",
  border: 0,
  borderRadius: 8,
  background: "#e2574c",
  color: "#fff",
  font: "inherit",
  fontWeight: 600 as const,
};

/** 라벨(작은 글씨) 스타일 */
export const authLabel = { display: "block", marginTop: 14, fontSize: 13.5, color: "#4b4b55" };
