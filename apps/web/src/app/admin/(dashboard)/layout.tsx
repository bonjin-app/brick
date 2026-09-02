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
  const [open, setOpen] = useState(false);

  // Esc 로 드로어 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const sideNav = (
    <nav onClick={() => setOpen(false)}>
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
  );

  /*
   * 반응형: 1024px 미만에서는 사이드바가 드로어가 된다 — 상단 막대의 메뉴 버튼으로 열고,
   * 항목을 누르거나 바깥을 누르거나 Esc 로 닫는다. 마크업은 하나다(데스크톱용·모바일용
   * 메뉴가 둘이면 한쪽만 고쳐져 어긋난다). Tailwind 유틸리티는 globals.css 에서 온다.
   */
  return (
    <div className="brick-admin flex min-h-dvh text-ink bg-surface-soft" style={{ fontFamily: "var(--font-body)" }}>
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CSS }} />

      {/* 좁은 화면의 상단 막대 */}
      <header className="brick-admin-top fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 bg-side px-3 text-white lg:hidden" style={{ colorScheme: "dark" }}>
        <button type="button" className="brick-admin-burger" aria-label={t("nav.openMenu")} aria-expanded={open}
          aria-controls="brick-admin-side" onClick={() => setOpen((v) => !v)}>
          <span /><span /><span />
        </button>
        <a href="/admin" className="text-lg font-bold tracking-tight">BRICK</a>
        <span className="ml-auto text-sm text-side-text">{user.displayName}</span>
      </header>
      {open && <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}

      <aside id="brick-admin-side" className={
        "brick-admin-side fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col overflow-y-auto bg-side text-white transition-transform lg:static lg:z-auto lg:w-[210px] lg:translate-x-0 " +
        (open ? "translate-x-0" : "-translate-x-full")
      } style={{ colorScheme: "dark" }}>
        <div className="hidden p-4 text-lg font-bold lg:block">BRICK</div>
        <div className="flex h-14 items-center justify-between px-4 lg:hidden">
          <span className="text-lg font-bold">BRICK</span>
          <button type="button" className="brick-admin-close" aria-label={t("nav.closeMenu")} onClick={() => setOpen(false)}>×</button>
        </div>
        {sideNav}
        <div className="mt-5 border-t border-side-line p-4 text-[13px] text-side-text">
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>{t("nav.logout")}</button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 bg-surface-soft p-4 pt-[72px] md:p-6 md:pt-[80px] lg:p-8">{children}</main>
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
.brick-admin table { border-collapse: collapse; width: 100%; }
.brick-admin th { text-align: left; font-size: 12.5px; font-weight: 600; color: var(--color-muted); letter-spacing: .01em; }
.brick-admin th, .brick-admin td { padding: 10px 12px; vertical-align: middle; }
.brick-admin tbody tr:hover { background: var(--color-bg-soft); }
.brick-admin h1 { font-size: 26px; letter-spacing: -0.01em; margin: 0 0 20px; }
.brick-admin .btn-primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.brick-admin .btn-primary:hover { filter: brightness(.94); background: var(--color-primary); border-color: var(--color-primary); }
.brick-admin .btn-link {
  display: inline-block; padding: 8px 14px; border-radius: 8px; font-size: 14px; font-weight: 600;
  border: 1px solid var(--color-line-strong); background: var(--color-bg); color: var(--color-text); text-decoration: none;
}
.brick-admin .btn-link:hover { border-color: var(--color-muted); background: var(--color-bg-soft); }
.brick-admin .brick-card {
  display: block; background: var(--color-bg); border: 1px solid var(--color-line); border-radius: 12px;
  padding: 22px 24px; margin-top: 16px; color: inherit; text-decoration: none;
}
.brick-admin .brick-card-title { margin: 0 0 6px; font-size: 17px; font-weight: 700; }
.brick-admin .brick-card-desc { margin: 0 0 14px; font-size: 13.5px; color: var(--color-muted); }
.brick-admin .brick-field { display: block; margin-top: 16px; font-size: 14px; }
.brick-admin .brick-field-label { display: block; font-weight: 600; }
.brick-admin .brick-field-hint, .brick-admin .brick-check .brick-field-hint { display: block; margin-top: 5px; font-size: 12.5px; color: var(--color-muted); font-weight: 400; }
.brick-admin .brick-check { display: flex; gap: 10px; align-items: flex-start; margin-top: 16px; font-size: 14px; font-weight: 600; }
.brick-admin .brick-check input { margin-top: 3px; }
.brick-admin .brick-stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
.brick-admin .brick-stat { margin-top: 0; padding: 18px 20px; }
.brick-admin a.brick-stat:hover { border-color: var(--color-line-strong); }
.brick-admin .brick-activity { list-style: none; margin: 12px 0 0; padding: 0; }
.brick-admin .brick-activity li { display: flex; gap: 12px; align-items: baseline; padding: 9px 0; border-top: 1px solid var(--color-line); font-size: 14px; }
.brick-admin .brick-activity time { color: var(--color-muted); font-variant-numeric: tabular-nums; flex: none; }
.brick-admin .brick-activity-actor { color: var(--color-text-soft); flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brick-admin .brick-activity-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brick-admin .brick-activity-action { color: var(--color-muted); font-size: 12px; flex: none; }
.brick-admin a { color: var(--color-primary-text); }
/* 사이드바는 어두운 채로 고정이므로 위 규칙을 적용하지 않는다 */
.brick-admin-side a { color: inherit; }
.brick-admin-side button {
  border: 0; background: none; color: #c9c9d6; padding: 0; font-size: 13px; font-weight: 400;
}
.brick-admin-side button:hover { background: none; color: #fff; }
.brick-admin .brick-admin-top a { color: #fff; text-decoration: none; }
.brick-admin .brick-admin-burger { display: inline-grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; background: none; position: relative; cursor: pointer; }
.brick-admin-burger span { position: absolute; left: 10px; right: 10px; height: 2px; background: #fff; border-radius: 2px; }
.brick-admin-burger span:nth-child(1) { top: 13px; } .brick-admin-burger span:nth-child(2) { top: 19px; } .brick-admin-burger span:nth-child(3) { top: 25px; }
.brick-admin-burger[aria-expanded="true"] span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
.brick-admin-burger[aria-expanded="true"] span:nth-child(2) { opacity: 0; }
.brick-admin-burger[aria-expanded="true"] span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
.brick-admin .brick-admin-close { border: 0; background: none; font-size: 26px; line-height: 1; color: #fff !important; padding: 4px 8px !important; }
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
