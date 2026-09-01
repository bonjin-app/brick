"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname() ?? "";
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
  /**
   * 사이드바 항목. **지금 어느 화면인지 표시한다** — 메뉴가 스무 개를 넘는데
   * 강조가 없으면 운영자는 자기 위치를 화면 제목으로만 알 수 있다.
   * 하위 경로(상품 → 상품 수정)도 그 항목에 속하므로 접두어로 판정하되,
   * "/admin" 은 모든 경로의 접두어라 정확히 일치할 때만 켠다.
   */
  const NavLink = ({ href, children: label }: { href: string; children: ReactNode }) => {
    const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
    return (
      <a href={href} style={active ? linkActive : link}>
        {label}
      </a>
    );
  };

  /**
   * 관리 화면도 사이트 팔레트를 따른다 — 색은 토큰에서 온다.
   *
   * **사이드바만 예외로 항상 어둡다.** 관리 도구의 사이드바는 라이트 모드에서도
   * 어두운 것이 관례이고(내용 영역과 확실히 구분된다), 그 위의 글자 대비를
   * 팔레트가 바뀔 때마다 다시 맞추는 것보다 고정하는 편이 안전하다.
   * colorScheme 을 dark 로 알려 그 안의 UA 위젯도 어둡게 그려지게 한다.
   */
  return (
    <div className="brick-admin" style={{
      fontFamily: "var(--font-body)", display: "flex", minHeight: "100dvh",
      color: "var(--color-text)", background: "var(--color-bg-soft)",
    }}>
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CSS }} />
      <aside className="brick-admin-side" style={{
        width: 210, background: "#1e1e2e", color: "#fff", flexShrink: 0, colorScheme: "dark",
      }}>
        <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>BRICK</div>
        <nav>
          <NavLink href="/admin">{t("nav.dashboard")}</NavLink>
          <NavLink href="/admin/pages">{t("nav.pages")}</NavLink>
          <NavLink href="/admin/media">{t("nav.media")}</NavLink>
          <NavLink href="/admin/menus">{t("nav.menus")}</NavLink>
          <NavLink href="/admin/users">{t("nav.users")}</NavLink>

          {(nav.resources.length > 0 || nav.menus.length > 0) && (
            <>
              <div style={sectionLabel}>{t("nav.plugins")}</div>
              {nav.resources.map((r) => (
                <NavLink key={`${r.plugin}/${r.name}`} href={`/admin/x/${r.plugin}/${r.name}`}>
                  {r.title}
                </NavLink>
              ))}
              {nav.menus.map((m) => (
                <NavLink key={m.path} href={m.path}>{m.icon ? `${m.icon} ` : ""}{m.label}</NavLink>
              ))}
            </>
          )}

          <div style={sectionLabel}>{t("nav.system")}</div>
          <NavLink href="/admin/plugins">{t("nav.plugins")}</NavLink>
          <NavLink href="/admin/themes">{t("nav.themes")}</NavLink>
          <NavLink href="/admin/settings">{t("nav.settings")}</NavLink>
          <NavLink href="/admin/search">{t("nav.search")}</NavLink>
          <NavLink href="/admin/audit">{t("nav.audit")}</NavLink>
        </nav>
        <div style={{ padding: 16, marginTop: 20, fontSize: 13, color: "#aaa", borderTop: "1px solid #2c2c40" }}>
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>{t("nav.logout")}</button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 32, background: "var(--color-bg-soft)", minWidth: 0 }}>{children}</main>
    </div>
  );
}

/**
 * 관리 화면 공통 스타일.
 *
 * 화면마다 인라인 스타일로 버튼과 입력칸을 그리다 보니 **스타일을 안 준
 * 것들이 UA 기본**으로 남았다 — 다크에서 회색 버튼, 라이트에서 제각각인
 * 테두리. 공통 규칙을 한 곳에서 주면 새 화면(플러그인이 만든 관리 화면
 * 포함)도 자동으로 어울린다. 인라인 스타일이 더 구체적이므로 기존 화면의
 * 의도적인 색(주 행동 버튼 등)은 그대로 이긴다.
 */
const ADMIN_CSS = `
.brick-admin button, .brick-admin input[type="submit"] {
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--color-line-strong); background: var(--color-bg); color: var(--color-text);
}
.brick-admin button:hover { border-color: var(--color-muted); background: var(--color-bg-soft); }
.brick-admin button[disabled] { opacity: .5; cursor: not-allowed; }
.brick-admin input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]),
.brick-admin select, .brick-admin textarea {
  font: inherit; font-size: 14px; padding: 8px 11px; border-radius: 8px;
  border: 1px solid var(--color-line-strong); background: var(--color-bg); color: var(--color-text);
}
.brick-admin input::placeholder, .brick-admin textarea::placeholder { color: var(--color-muted); }
.brick-admin input[type="checkbox"], .brick-admin input[type="radio"] { accent-color: var(--color-primary); }
.brick-admin :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
.brick-admin table { border-collapse: collapse; }
.brick-admin a { color: var(--color-primary-text); }
/* 사이드바는 어두운 채로 고정이므로 위 규칙을 적용하지 않는다 */
.brick-admin-side a { color: inherit; }
.brick-admin-side button {
  border: 0; background: none; color: #c9c9d6; padding: 0; font-size: 13px; font-weight: 400;
}
.brick-admin-side button:hover { background: none; color: #fff; }
`;

const link = {
  display: "block", padding: "9px 16px", color: "#c9c9d6", textDecoration: "none",
  fontSize: 14.5, borderLeft: "3px solid transparent",
};
/** 현재 화면 — 왼쪽 띠와 밝은 글자로 표시한다 */
const linkActive = {
  ...link,
  color: "#fff",
  fontWeight: 600,
  background: "rgba(255,255,255,.07)",
  borderLeft: "3px solid #ff6f5f",
};
const sectionLabel = {
  padding: "16px 16px 6px", fontSize: 11.5, color: "#9a9ab8",
  textTransform: "uppercase" as const, letterSpacing: ".5px", fontWeight: 700,
};
