"use client";

import { useEffect, useState, type ReactNode } from "react";

interface NavResource { plugin: string; name: string; title: string }
interface NavMenu { plugin: string; label: string; path: string; icon?: string }

/**
 * 관리자 셸 레이아웃.
 * 사이드바는 코어 메뉴 + 활성 플러그인이 등록한 리소스/메뉴로 구성된다
 * (플러그인이 ZIP으로 설치되어도 관리 화면이 즉시 나타난다).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ displayName: string } | null | undefined>(undefined);
  const [nav, setNav] = useState<{ menus: NavMenu[]; resources: NavResource[] }>({ menus: [], resources: [] });

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setUser(d.user);
        return fetch("/api/admin/nav").then((r) => (r.ok ? r.json() : { menus: [], resources: [] }));
      })
      .then(setNav)
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

  return (
    <div style={{ fontFamily: "sans-serif", display: "flex", minHeight: "100vh" }}>
      <aside style={{ width: 210, background: "#1e1e2e", color: "#fff", flexShrink: 0 }}>
        <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>BRICK</div>
        <nav>
          <a style={link} href="/admin">대시보드</a>
          <a style={link} href="/admin/pages">페이지</a>
          <a style={link} href="/admin/media">미디어</a>
          <a style={link} href="/admin/menus">메뉴</a>
          <a style={link} href="/admin/users">회원</a>

          {(nav.resources.length > 0 || nav.menus.length > 0) && (
            <>
              <div style={sectionLabel}>플러그인</div>
              {nav.resources.map((r) => (
                <a key={`${r.plugin}/${r.name}`} style={link} href={`/admin/x/${r.plugin}/${r.name}`}>
                  {r.title}
                </a>
              ))}
              {nav.menus.map((m) => (
                <a key={m.path} style={link} href={m.path}>{m.icon ? `${m.icon} ` : ""}{m.label}</a>
              ))}
            </>
          )}

          <div style={sectionLabel}>시스템</div>
          <a style={link} href="/admin/plugins">플러그인</a>
          <a style={link} href="/admin/themes">테마</a>
          <a style={link} href="/admin/settings">설정</a>
          <a style={link} href="/admin/search">검색 분석</a>
          <a style={link} href="/admin/audit">감사 로그</a>
        </nav>
        <div style={{ padding: 16, marginTop: 20, fontSize: 13, color: "#aaa", borderTop: "1px solid #2c2c40" }}>
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>로그아웃</button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 32, background: "#f6f6f9", minWidth: 0 }}>{children}</main>
    </div>
  );
}

const link = { display: "block", padding: "9px 16px", color: "#ddd", textDecoration: "none", fontSize: 14.5 };
const sectionLabel = {
  padding: "16px 16px 6px", fontSize: 11.5, color: "#6b6b85",
  textTransform: "uppercase" as const, letterSpacing: ".5px", fontWeight: 700,
};
