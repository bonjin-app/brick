import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { FramedProvider } from "./frame-context";

interface Frame {
  stylesheets: string[];
  styles: string[];
  before: string;
  mainClass: string;
  mainId: string;
  after: string;
}

/**
 * 로그인한 회원의 머리(마이페이지 · 알림 · 로그아웃)가 나오도록 쿠키를 넘겨 가져온다. 못 가져오면 null —
 * 틀은 꾸밈이고 로그인을 막으면 안 된다(API 가 늦거나 죽어도, 테마가 낯선 모양이어도 화면은 단독으로 뜬다).
 */
async function loadFrame(): Promise<Frame | null> {
  const api = (process.env.BRICK_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  try {
    const cookie = (await cookies()).toString();
    const res = await fetch(`${api}/api/render/frame`, {
      cache: "no-store",
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { frame?: Frame | null };
    return data.frame ?? null;
  } catch {
    return null;
  }
}

/**
 * Next 가 그리는 화면(로그인 · 가입 · 마이페이지)에 사이트의 머리 · 푸터를 입힌다.
 *
 * 머리 조각과 푸터 조각은 API 가 테마로 그린 닫힌 요소들이다. 감싸는 `<div>` 는 `display: contents` 로 상자를 만들지
 * 않는다 — 머리가 `position: sticky` 로 붙고 본문이 남은 높이를 채우는 것은 둘 다 `<body>` 의 직계 자식이라는 전제인데,
 * 상자를 하나 끼우면 머리는 그 상자가 끝나는 곳에서 놓여난다.
 *
 * 스타일시트는 같은 출처의 것만(API 가 걸러서 준다) — 이 화면들의 CSP 는 고정이다.
 */
export async function ThemeFrame({ children }: { children: ReactNode }) {
  const frame = await loadFrame();
  if (!frame) return <>{children}</>;
  return (
    <FramedProvider>
      {frame.stylesheets.map((href) => (
        <link key={href} rel="stylesheet" href={href} precedence="brick-theme" />
      ))}
      {frame.styles.map((css, i) => (
        <style key={i} dangerouslySetInnerHTML={{ __html: css }} />
      ))}
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: frame.before }} />
      <main className={frame.mainClass || undefined} id={frame.mainId || undefined}>
        {children}
      </main>
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: frame.after }} />
    </FramedProvider>
  );
}
