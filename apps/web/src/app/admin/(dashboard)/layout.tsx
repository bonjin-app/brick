"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * 관리자 셸 레이아웃.
 * 세션 확인은 클라이언트에서 /api/auth/me 로 수행한다 (쿠키는 동일 오리진 rewrite로 전달됨).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ displayName: string } | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setUser(d.user))
      .catch(() => {
        window.location.href = "/admin/login";
      });
  }, []);

  if (user === undefined) return <p style={{ fontFamily: "sans-serif", padding: 40 }}>확인 중…</p>;
  if (!user) return null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  const link = { display: "block", padding: "10px 16px", color: "#ddd", textDecoration: "none" };
  return (
    <div style={{ fontFamily: "sans-serif", display: "flex", minHeight: "100vh" }}>
      <aside style={{ width: 200, background: "#1e1e2e", color: "#fff", flexShrink: 0 }}>
        <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>BRICK</div>
        <nav>
          <a style={link} href="/admin">대시보드</a>
          <a style={link} href="/admin/pages">페이지</a>
          <a style={link} href="/admin/media">미디어</a>
          <a style={link} href="/admin/menus">메뉴</a>
          <a style={link} href="/admin/users">회원</a>
          <a style={link} href="/admin/plugins">플러그인</a>
          <a style={link} href="/admin/themes">테마</a>
          <a style={link} href="/admin/settings">설정</a>
        </nav>
        <div style={{ padding: 16, marginTop: 24, fontSize: 13, color: "#aaa" }}>
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>
            로그아웃
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 32, background: "#f6f6f9" }}>{children}</main>
    </div>
  );
}
