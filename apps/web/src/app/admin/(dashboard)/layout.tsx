"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAdminT } from "../../../lib/i18n-admin";

interface NavResource { plugin: string; name: string; title: string }
interface NavMenu { plugin: string; label: string; path: string; icon?: string }

/**
 * 관리자 셸 레이아웃.
 * 사이드바는 코어 메뉴 + 활성 플러그인이 등록한 리소스/메뉴로 구성된다
 * (플러그인이 ZIP으로 설치되어도 관리 화면이 즉시 나타난다).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const t = useAdminT();
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

  if (user === undefined) return <p style={{ fontFamily: "sans-serif", padding: 40 }}>{t("nav.checking")}</p>;
  if (!user) return null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  /**
   * 관리자는 **라이트 고정**이다 — 색을 여기서 명시한다.
   *
   * 공개 화면과 인증 화면은 사이트 테마 토큰을 따라 다크로 바뀌지만
   * (루트 레이아웃이 /api/themes/tokens.css 를 불러온다), 관리 화면의 색은
   * 아직 라이트 디자인으로 하드코딩되어 있다. 글자색만 body 에서 상속받으면
   * **흰 카드 위에 흰 글자**가 되어 읽을 수 없다 — 실제로 그랬다.
   * 관리 화면의 다크 대응은 별도 작업이고, 그때까지 여기서 잠근다.
   */
  return (
    <div style={{
      fontFamily: "sans-serif", display: "flex", minHeight: "100dvh",
      color: "#17171c", background: "#f6f6f9", colorScheme: "light",
    }}>
      <aside style={{ width: 210, background: "#1e1e2e", color: "#fff", flexShrink: 0 }}>
        <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>BRICK</div>
        <nav>
          <a style={link} href="/admin">{t("nav.dashboard")}</a>
          <a style={link} href="/admin/pages">{t("nav.pages")}</a>
          <a style={link} href="/admin/media">{t("nav.media")}</a>
          <a style={link} href="/admin/menus">{t("nav.menus")}</a>
          <a style={link} href="/admin/users">{t("nav.users")}</a>

          {(nav.resources.length > 0 || nav.menus.length > 0) && (
            <>
              <div style={sectionLabel}>{t("nav.plugins")}</div>
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

          <div style={sectionLabel}>{t("nav.system")}</div>
          <a style={link} href="/admin/plugins">{t("nav.plugins")}</a>
          <a style={link} href="/admin/themes">{t("nav.themes")}</a>
          <a style={link} href="/admin/settings">{t("nav.settings")}</a>
          <a style={link} href="/admin/search">{t("nav.search")}</a>
          <a style={link} href="/admin/audit">{t("nav.audit")}</a>
        </nav>
        <div style={{ padding: 16, marginTop: 20, fontSize: 13, color: "#aaa", borderTop: "1px solid #2c2c40" }}>
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>{t("nav.logout")}</button>
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
