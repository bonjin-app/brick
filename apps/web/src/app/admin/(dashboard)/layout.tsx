"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAdminT, type AdminMessageKey } from "../../../lib/i18n-admin";

interface NavResource { plugin: string; name: string; title: string; section?: string }
interface NavMenu { plugin: string; label: string; path: string; icon?: string; section?: string }
interface NavItem { href: string; label: string }

/**
 * 사이드바 묶음 — 운영자가 하는 **일**의 순서다(`AdminSection`, 코어 계약과 같은 값).
 *
 * 묶음이 없던 때는 플러그인 열 개의 화면 서른 개가 한 줄에 섰다: 게시판 그룹 · 주문 ·
 * 1:1 문의 · 취소·반품 · 현금영수증 · … · 게시판 · 상품. 주문을 보러 온 운영자가
 * 게시판 사이를 뒤졌다. 카페24 관리자가 주문·상품·고객·게시판으로 나누는 까닭이다.
 * 선언하지 않은(또는 모르는 값을 쓴) 플러그인 화면은 "플러그인" 묶음으로 간다.
 */
const SECTIONS = ["order", "product", "customer", "board", "promotion", "stats", "design", "plugins", "settings", "system"] as const;
type SectionKey = (typeof SECTIONS)[number];
const DECLARABLE = new Set<string>(["order", "product", "customer", "board", "promotion", "stats", "design", "settings"]);
const SECTION_LABEL: Record<SectionKey, AdminMessageKey> = {
  order: "nav.section.order", product: "nav.section.product", customer: "nav.section.customer",
  board: "nav.section.board", promotion: "nav.section.promotion", stats: "nav.section.stats", design: "nav.section.design",
  plugins: "nav.plugins", settings: "nav.section.settings", system: "nav.system",
};

/** 접힘 상태 — 이 브라우저에서의 편의일 뿐이다(없거나 읽지 못해도 화면은 돈다) */
const OPEN_KEY = "brick.admin.nav.open";

/** 묶음 아이콘 — 18px 선 그림. 글자만 서른 줄이면 눈이 묶음 경계를 찾지 못한다 */
const ICON: Record<SectionKey | "dashboard", string> = {
  dashboard: "M3 3h7v8H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 15h7v6H3z",
  order: "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4",
  product: "M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  customer: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  board: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 8h8M8 12h5",
  promotion: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
  stats: "M3 21h18M6 17V10M11 17V5M16 17v-4M21 17V8",
  design: "M3 3h18v18H3zM3 9h18M9 21V9",
  plugins: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM17 13v8M13 17h8",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  system: "M5 5h14v14H5zM9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3",
};
function Icon({ d }: { d: string }) {
  return (
    <svg className="brick-nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

/**
 * 관리자 셸 레이아웃.
 * 사이드바는 코어 메뉴 + 활성 플러그인이 등록한 리소스/메뉴로 구성된다
 * (플러그인이 ZIP으로 설치되어도 관리 화면이 즉시 나타난다).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const t = useAdminT();
  const pathname = usePathname() ?? "";
  const [user, setUser] = useState<{ displayName: string; role?: string } | null | undefined>(undefined);
  const [nav, setNav] = useState<{ menus: NavMenu[]; resources: NavResource[] }>({ menus: [], resources: [] });
  const [open, setOpen] = useState(false);
  // 운영자가 직접 열고 닫은 묶음만 기억한다 — 고르지 않은 묶음은 "지금 화면이 있는 묶음만 열림"
  const [choice, setChoice] = useState<Record<string, boolean>>({});

  // Esc 로 드로어 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) setChoice(v);
    } catch { /* 저장소를 못 쓰는 브라우저 — 기본 접힘으로 */ }
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

  /*
   * 운영자(manager)에게는 **쓸 수 있는 것만** 보여준다.
   *
   * 코어 관리 화면은 전부 관리자 전용이다(페이지·미디어·회원·설정·감사 …).
   * 그런데 사이드바는 역할에 상관없이 같은 목록을 그려서, 운영자는 누르는
   * 족족 403 을 만났다. 정작 쓸 수 있는 플러그인 리소스는 nav 가 403 이라
   * 하나도 보이지 않았다(그쪽은 서버에서 고쳤다).
   */
  const isAdmin = user?.role === "admin";
  const item = (href: string, key: AdminMessageKey): NavItem => ({ href, label: t(key) });
  // 코어 화면이 각 묶음의 앞(start)·뒤(end)에 선다 — 관리자 전용
  const core: Partial<Record<SectionKey, { start?: NavItem[]; end?: NavItem[] }>> = isAdmin ? {
    customer: { start: [item("/admin/users", "nav.users")] },
    promotion: { end: [item("/admin/mail", "nav.mail")] },
    design: { start: [item("/admin/themes", "nav.themes"), item("/admin/pages", "nav.pages"), item("/admin/menus", "nav.menus"), item("/admin/media", "nav.media")] },
    settings: {
      start: [item("/admin/settings", "nav.basicSettings")],
      end: [item("/admin/agreements", "nav.agreements"), item("/admin/notifications", "nav.notifications"), item("/admin/identity", "nav.identity")],
    },
    system: { start: [item("/admin/plugins", "nav.plugins"), item("/admin/search", "nav.search"), item("/admin/migrate", "nav.migrate"), item("/admin/audit", "nav.audit")] },
  } : {};
  const fromPlugins = new Map<SectionKey, NavItem[]>();
  const put = (section: string | undefined, it: NavItem) => {
    const k = (section && DECLARABLE.has(section) ? section : "plugins") as SectionKey;
    fromPlugins.set(k, [...(fromPlugins.get(k) ?? []), it]);
  };
  // 순서는 서버가 order 로 정렬해 준다 — 묶음 안에서도 그 순서를 지킨다
  for (const r of nav.resources) put(r.section, { href: `/admin/x/${r.plugin}/${r.name}`, label: r.title });
  for (const m of nav.menus) put(m.section, { href: m.path, label: `${m.icon ? `${m.icon} ` : ""}${m.label}` });
  const groups = SECTIONS
    .map((key) => ({ key, items: [...(core[key]?.start ?? []), ...(fromPlugins.get(key) ?? []), ...(core[key]?.end ?? [])] }))
    .filter((g) => g.items.length > 0);

  /**
   * 지금 어느 화면인지 표시한다 — 하위 경로(상품 → 상품 수정)도 그 항목에 속하므로
   * 접두어로 판정하되, 가장 긴 것 하나만 켠다("/admin/x/brick-shop/settings" 와
   * "/admin/settings" 가 함께 켜지지 않게). "/admin" 은 정확히 일치할 때만.
   */
  const matches = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const current = groups.flatMap((g) => g.items.map((it) => ({ g: g.key, it })))
    .filter(({ it }) => matches(it.href))
    .sort((a, b) => b.it.href.length - a.it.href.length)[0];
  const onDashboard = pathname === "/admin";

  const isOpen = (k: SectionKey) => (k in choice ? choice[k] : current?.g === k);
  const toggle = (k: SectionKey) => {
    const next = { ...choice, [k]: !isOpen(k) };
    setChoice(next);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* 기억만 못 한다 */ }
  };

  const sideNav = (
    // 링크를 누르면 드로어를 닫는다 — 묶음을 여닫는 단추는 닫지 않는다
    <nav className="brick-nav" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
      {isAdmin && (
        <a href="/admin" className={"brick-nav-top" + (onDashboard ? " is-current" : "")} aria-current={onDashboard ? "page" : undefined}>
          <Icon d={ICON.dashboard} />{t("nav.dashboard")}
        </a>
      )}
      {groups.map((g) => {
        const on = isOpen(g.key);
        return (
          <div key={g.key} className={"brick-nav-group" + (current?.g === g.key ? " has-current" : "")}>
            <button type="button" className="brick-nav-sec" aria-expanded={on} aria-controls={`brick-nav-${g.key}`} onClick={() => toggle(g.key)}>
              <Icon d={ICON[g.key]} />
              <span className="brick-nav-sec-label">{t(SECTION_LABEL[g.key])}</span>
              <svg className="brick-nav-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div id={`brick-nav-${g.key}`} className="brick-nav-items" hidden={!on}>
              {g.items.map((it) => {
                const active = current?.it === it;
                return (
                  <a key={it.href} href={it.href} className={"brick-nav-link" + (active ? " is-current" : "")} aria-current={active ? "page" : undefined}>
                    {it.label}
                  </a>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );

  /*
   * 관리 화면도 사이트 팔레트를 따른다 — 색은 토큰에서 온다.
   * **사이드바만 예외로 항상 어둡다**(관리 도구의 관례 — 내용 영역과 확실히 구분된다).
   *
   * 반응형: 1024px 미만에서는 사이드바가 드로어가 된다 — 상단 막대의 메뉴 버튼으로 열고,
   * 항목을 누르거나 바깥을 누르거나 Esc 로 닫는다. 마크업은 하나다(데스크톱용·모바일용
   * 메뉴가 둘이면 한쪽만 고쳐져 어긋난다). Tailwind 유틸리티는 globals.css 에서 온다.
   * 넓은 화면에서는 사이드바가 제자리에 서 있고(긴 목록을 내려도 메뉴가 따라 올라가지 않는다)
   * 내용 위에 밝은 막대가 선다 — 지금 위치(묶음 › 화면)·내 사이트·계정.
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
        "brick-admin-side fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col overflow-y-auto bg-side text-white transition-transform lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-[224px] lg:translate-x-0 " +
        (open ? "translate-x-0" : "-translate-x-full")
      } style={{ colorScheme: "dark" }}>
        <a href="/admin" className="brick-side-brand hidden lg:flex">BRICK<span>{t("nav.adminLabel")}</span></a>
        <div className="flex h-14 items-center justify-between px-4 lg:hidden">
          <span className="text-lg font-bold">BRICK</span>
          <button type="button" className="brick-admin-close" aria-label={t("nav.closeMenu")} onClick={() => setOpen(false)}>×</button>
        </div>
        {sideNav}
        {/* 좁은 화면에는 위 막대에 계정 자리가 없다 — 드로어 맨 아래에 둔다 */}
        <div className="mt-auto border-t border-side-line p-4 text-[13px] text-side-text lg:hidden">
          {user.displayName}
          <button onClick={logout} style={{ display: "block", marginTop: 8, cursor: "pointer" }}>{t("nav.logout")}</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="brick-admin-bar sticky top-0 z-30 hidden lg:flex">
          <div className="brick-crumb">
            {current ? (
              <><span>{t(SECTION_LABEL[current.g])}</span><span aria-hidden="true">›</span><strong>{current.it.label}</strong></>
            ) : <strong>{t("nav.dashboard")}</strong>}
          </div>
          <a className="brick-bar-link" href="/" target="_blank" rel="noopener">{t("nav.viewSite")} ↗</a>
          <span className="brick-bar-user">{user.displayName}</span>
          <button type="button" className="brick-bar-btn" onClick={logout}>{t("nav.logout")}</button>
        </header>
        <main className="min-w-0 flex-1 bg-surface-soft p-4 pt-[72px] md:p-6 md:pt-[80px] lg:p-8">{children}</main>
      </div>
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
/*
 * 기본 버튼의 글자색은 **테마가 정한다**(--color-on-primary).
 *
 * #fff 로 박아 두었더니, primary 가 밝은 색인 팔레트에서 흰 글자가 사라졌다 —
 * storefront 테마의 다크 팔레트가 정확히 그렇다(primary #f2f3f6). 다크로 보는
 * 운영자에게는 관리 화면의 **모든 저장 버튼**이 빈 칸이었다. 테마는 그 경우를
 * 대비해 --color-on-primary(#14161b)를 같이 선언해 두는데 아무도 읽지 않았다.
 */
.brick-admin .btn-primary { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-on-primary, #fff); }
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

/* 목록 위의 탭 필터 (주문 상태) */
.brick-x-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 12px; border-bottom: 1px solid var(--color-line); }
.brick-admin .brick-x-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--color-muted); font-weight: 600; margin-bottom: -1px; }
.brick-admin .brick-x-tab:hover { background: none; color: var(--color-text); border-color: transparent; border-bottom-color: var(--color-line-strong); }
.brick-admin .brick-x-tab.is-on { color: var(--color-text); border-bottom-color: var(--color-primary); }
.brick-x-tab-n { font-size: 12px; font-weight: 600; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--color-bg-soft); color: var(--color-text-soft); text-align: center; font-variant-numeric: tabular-nums; }
.brick-x-tab.is-on .brick-x-tab-n { background: var(--color-primary); color: var(--color-on-primary, #fff); }

/* 목록의 축소판 열 */
.brick-x-thumb-img { display: block; width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: var(--color-bg-soft); border: 1px solid var(--color-line); }
.brick-x-thumb-img.is-empty { background: repeating-linear-gradient(135deg, var(--color-bg-soft) 0 6px, var(--color-bg) 6px 12px); }

/* 대시보드 — 머리 · 설정 경고 한 카드 · 플러그인 판(단계 · 막대 · 목록) */
.brick-dash-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.brick-dash-head h1 { margin: 0; }
.brick-dash-head span { color: var(--color-muted); font-size: 14px; }
.brick-admin .brick-dash-setup { margin: 0 0 16px; padding: 14px 20px; border-color: var(--color-warning); border-left-width: 4px; }
.brick-dash-setup h2 { margin: 0 0 6px; font-size: 14px; }
.brick-dash-setup ul { list-style: none; margin: 0; padding: 0; }
.brick-dash-setup li { display: flex; align-items: baseline; gap: 12px; padding: 6px 0; border-top: 1px solid var(--color-line); font-size: 13.5px; }
.brick-dash-setup li:first-child { border-top: 0; }
.brick-dash-setup li strong { flex: none; font-weight: 600; }
.brick-dash-setup li span { flex: 1; min-width: 0; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brick-dash-setup li a { flex: none; display: inline-flex; align-items: center; min-height: 28px; font-size: 13px; }
.brick-dash-panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.brick-admin .brick-panel { grid-column: 1 / -1; margin: 0; }
.brick-admin .brick-panel.is-half { grid-column: auto; }
.brick-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.brick-panel-head .brick-card-title { margin: 0; }
.brick-panel-head a { display: inline-flex; align-items: center; min-height: 28px; font-size: 13px; }
.brick-panel-empty { margin: 0; color: var(--color-muted); font-size: 14px; }
.brick-steps { display: flex; flex-wrap: wrap; gap: 14px 28px; }
.brick-steps-group.is-flow { flex: 1 1 100%; }
.brick-steps-label { font-size: 12.5px; font-weight: 600; color: var(--color-muted); margin-bottom: 8px; }
.brick-steps-row { display: flex; gap: 8px; flex-wrap: wrap; }
.is-flow .brick-steps-row { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0; border: 1px solid var(--color-line); border-radius: 10px; overflow: hidden; }
.brick-admin .brick-step { display: flex; flex-direction: column; gap: 4px; min-width: 96px; padding: 12px 16px; border: 1px solid var(--color-line); border-radius: 10px; color: var(--color-text); text-decoration: none; background: var(--color-bg); }
.is-flow .brick-step { border: 0; border-radius: 0; position: relative; padding: 16px 20px; }
.is-flow .brick-step + .brick-step { border-left: 1px solid var(--color-line); }
/* 흐름의 화살표 — 입금전 → 결제완료 → … 의 순서가 칸 사이에 보이게 */
.is-flow .brick-step + .brick-step::before { content: ""; position: absolute; left: -6px; top: 50%; width: 10px; height: 10px; margin-top: -5px; background: var(--color-bg); border-top: 1px solid var(--color-line); border-right: 1px solid var(--color-line); transform: rotate(45deg); }
.brick-admin a.brick-step:hover { background: var(--color-bg-soft); }
.brick-step span { font-size: 13px; color: var(--color-muted); white-space: nowrap; }
.brick-step strong { font-size: 24px; font-weight: 700; letter-spacing: -.01em; line-height: 1.2; font-variant-numeric: tabular-nums; }
.brick-step.is-hot strong { color: var(--color-primary-text); }
.brick-chart-summary { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0 0 16px; }
.brick-chart-summary div { min-width: 0; }
.brick-chart-summary dt { font-size: 12.5px; color: var(--color-muted); }
.brick-chart-summary dd { margin: 2px 0 0; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.brick-chart { position: relative; display: flex; align-items: flex-end; gap: 6px; height: 150px; padding: 18px 0 22px; border-bottom: 1px solid var(--color-line); }
.brick-chart-max { position: absolute; top: 0; left: 0; font-size: 11.5px; color: var(--color-muted); }
.brick-bar { position: relative; flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
.brick-bar-fill { display: block; width: 100%; border-radius: 4px 4px 0 0; background: var(--color-primary); opacity: .82; }
.brick-bar:hover .brick-bar-fill { opacity: 1; }
.brick-bar:last-of-type .brick-bar-fill { opacity: 1; }
.brick-bar-label { position: absolute; left: 50%; bottom: -20px; transform: translateX(-50%); font-size: 11px; color: var(--color-muted); white-space: nowrap; }
/* 매출 통계 — 기간 고르기 · 보기 탭 · 요약 · 막대 · 표 */
.brick-report-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 14px; }
.brick-report-bar label { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--color-text-soft); }
.brick-report-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.brick-admin .brick-report-presets button, .brick-admin .brick-seg button { padding: 6px 12px; min-height: 34px; font-size: 13px; font-weight: 500; }
.brick-admin .brick-report-presets button.is-on, .brick-admin .brick-seg button.is-on { border-color: var(--color-text); background: var(--color-text); color: var(--color-bg); }
.brick-seg { display: inline-flex; gap: 0; }
.brick-admin .brick-seg button { border-radius: 0; margin-left: -1px; }
.brick-admin .brick-seg button:first-child { border-radius: 8px 0 0 8px; margin-left: 0; }
.brick-admin .brick-seg button:last-child { border-radius: 0 8px 8px 0; }
.brick-report-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin: 0 0 16px; }
.brick-admin .brick-report-summary .brick-card { margin: 0; padding: 16px 18px; }
.brick-report-summary dt { font-size: 13px; color: var(--color-muted); }
.brick-report-summary dd { margin: 4px 0 0; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.brick-delta { display: block; margin-top: 2px; font-size: 12.5px; font-weight: 600; color: var(--color-muted); }
.brick-delta.is-up { color: var(--color-success); }
.brick-delta.is-down { color: var(--color-danger); }
.brick-report-note { margin: 10px 0 0; font-size: 12.5px; color: var(--color-muted); }
.brick-admin .brick-report-table td.is-num, .brick-admin .brick-report-table th.is-num { text-align: right; font-variant-numeric: tabular-nums; }
.brick-panel-list { list-style: none; margin: 0; padding: 0; }
.brick-panel-list li + li { border-top: 1px solid var(--color-line); }
.brick-admin .brick-panel-list a, .brick-panel-list li > div { display: flex; align-items: center; gap: 12px; padding: 10px 0; min-height: 44px; color: var(--color-text); text-decoration: none; }
.brick-admin .brick-panel-list a:hover strong { text-decoration: underline; }
.brick-pl-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.brick-pl-main strong { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brick-pl-main small { font-size: 12.5px; color: var(--color-muted); }
.brick-pl-badge { flex: none; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: var(--color-bg-soft); border: 1px solid var(--color-line); color: var(--color-text-soft); }
.brick-pl-value { flex: none; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
@media (max-width: 1023.98px) {
  .brick-admin .brick-panel.is-half { grid-column: 1 / -1; }
}
.brick-admin a { color: var(--color-primary-text); }
/* 사이드바는 어두운 채로 고정이므로 위 규칙을 적용하지 않는다 */
.brick-admin-side a { color: inherit; }
.brick-admin-side button {
  border: 0; background: none; color: #c9c9d6; padding: 8px 0; min-height: 36px; font-size: 13px; font-weight: 400;
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

/* 사이드바 — 묶음(주문·상품·고객 …)과 그 안의 화면. 색은 어두운 사이드바에 고정 */
.brick-side-brand { align-items: baseline; gap: 8px; padding: 18px 18px 14px; font-size: 18px; font-weight: 800; letter-spacing: -.01em; color: #fff; text-decoration: none; }
.brick-side-brand span { font-size: 11.5px; font-weight: 600; color: #9a9ab8; letter-spacing: .04em; }
.brick-nav { padding: 4px 10px 16px; }
.brick-admin-side .brick-nav-top, .brick-admin-side .brick-nav-sec {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 8px 10px;
  border: 0; border-radius: 8px; background: none; color: #d6d6e2; font-size: 14.5px; font-weight: 600; text-align: left; text-decoration: none;
}
.brick-admin-side .brick-nav-top:hover, .brick-admin-side .brick-nav-sec:hover { background: rgba(255,255,255,.06); color: #fff; }
.brick-admin-side .brick-nav-top.is-current { background: rgba(255,255,255,.1); color: #fff; }
.brick-nav-icon { flex: none; color: #8f8fae; }
.brick-nav-top.is-current .brick-nav-icon, .brick-nav-group.has-current .brick-nav-icon { color: #ff8a7c; }
.brick-nav-sec-label { flex: 1; min-width: 0; }
.brick-nav-chev { flex: none; color: #7c7c99; transition: transform .15s; }
.brick-nav-sec[aria-expanded="true"] .brick-nav-chev { transform: rotate(180deg); }
.brick-nav-group + .brick-nav-group, .brick-nav-top + .brick-nav-group { margin-top: 2px; }
.brick-nav-items { margin: 2px 0 8px; }
.brick-admin-side .brick-nav-link {
  display: flex; align-items: center; min-height: 34px; padding: 6px 10px 6px 38px; border-radius: 8px;
  color: #b4b4c8; font-size: 13.5px; text-decoration: none; position: relative;
}
.brick-admin-side .brick-nav-link:hover { color: #fff; background: rgba(255,255,255,.05); }
.brick-admin-side .brick-nav-link.is-current { color: #fff; font-weight: 600; background: rgba(255,255,255,.08); }
.brick-admin-side .brick-nav-link.is-current::before { content: ""; position: absolute; left: 20px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: #ff6f5f; }

/* 넓은 화면의 위 막대 — 지금 위치 · 내 사이트 · 계정 */
.brick-admin-bar { height: 56px; align-items: center; gap: 16px; padding: 0 32px; background: var(--color-bg); border-bottom: 1px solid var(--color-line); }
.brick-crumb { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13.5px; color: var(--color-muted); }
.brick-crumb strong { color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brick-admin .brick-bar-link { margin-left: auto; display: inline-flex; align-items: center; min-height: 34px; padding: 0 12px; border: 1px solid var(--color-line-strong); border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--color-text); text-decoration: none; }
.brick-admin .brick-bar-link:hover { background: var(--color-bg-soft); }
.brick-bar-user { font-size: 13px; color: var(--color-text-soft); }
.brick-admin .brick-bar-btn { padding: 6px 10px; min-height: 34px; font-size: 13px; font-weight: 500; border-color: transparent; background: none; color: var(--color-muted); }

/*
 * 선언형 관리 목록 — 좁은 화면에서는 표를 카드로 접는다.
 *
 * 주문 목록은 열이 여섯이다. 폰에서 표로 그리면 **주문번호만 보이고** 상태·금액·
 * 수정 버튼은 가로 스크롤 뒤에 숨는다. 주문 하나를 확인하려고 좌우로 밀어야 하고,
 * 그것이 작은 쇼핑몰 운영자가 가장 자주 하는 일이다.
 *
 * 각 칸은 data-label(열 제목)을 들고 있으므로 CSS 만으로 "제목: 값" 줄로 바꿀 수
 * 있다. 자바스크립트로 화면 폭을 재지 않는다 — 회전·창 크기 변화에 바로 따라간다.
 */
@media (max-width: 767.98px) {
  .brick-admin .brick-x-table { display: block; }
  .brick-admin .brick-x-table thead { display: none; }
  .brick-admin .brick-x-table tbody, .brick-admin .brick-x-table tr { display: block; }
  .brick-admin .brick-x-table tr {
    border: 1px solid var(--color-line); border-radius: 8px; margin-bottom: 10px; padding: 4px 2px;
  }
  .brick-admin .brick-x-table td {
    display: flex; gap: 12px; align-items: baseline; justify-content: space-between;
    padding: 7px 12px !important; border: 0; text-align: right;
  }
  .brick-admin .brick-x-table td::before {
    content: attr(data-label); flex: none; color: var(--color-muted);
    font-size: 12.5px; font-weight: 600; text-align: left;
  }
  /* 제목이 없는 칸(선택 체크박스·버튼)은 한 줄을 통째로 쓴다 */
  .brick-admin .brick-x-table td[data-label=""]::before { content: none; }
  .brick-admin .brick-x-table td.brick-x-actions { justify-content: flex-end; padding-top: 10px !important; }
  .brick-admin .brick-x-table td.brick-x-pick { justify-content: flex-start; }
  /* 비어 있을 때의 안내는 카드 테두리 없이 */
  .brick-admin .brick-x-table tr.brick-x-empty { border: 0; }
  /*
   * 대시보드 최근 활동 — 폰에서는 두 줄로: 위는 시각·사람·행위, 아래는 내용.
   * 한 줄에 넷을 다 세우면 "plugin.activate" 같은 행위 이름이 화면 밖으로 7px 밀려
   * 문서 전체가 옆으로 흔들렸다. 사람 칸은 0 에서 출발해 남는 폭만 쓴다 — 줄바꿈은
   * 줄어들기 전 크기로 정해지므로, 제 크기로 두면 행위가 셋째 줄로 떨어진다.
   */
  .brick-admin .brick-activity li { flex-wrap: wrap; row-gap: 2px; }
  .brick-admin .brick-activity-actor { flex: 1 1 0; min-width: 0; max-width: none; }
  .brick-admin .brick-activity-action { margin-left: auto; }
  .brick-admin .brick-activity-text { order: 9; flex-basis: 100%; }
  /*
   * 주문 흐름 다섯 칸은 폰에서 **세로 목록**으로 — 이름 왼쪽, 숫자 오른쪽.
   * 한 줄에 다섯이면 "상품준비중" 이 잘리고, 세 칸 + 두 칸으로 접으니 빈 칸이 생기고
   * "배송완료 (7일)" 이 두 줄로 꺾였다. 순서는 위에서 아래로 읽힌다(화살표는 뺀다).
   */
  .is-flow .brick-steps-row { grid-template-columns: minmax(0, 1fr); }
  .is-flow .brick-step { flex-direction: row; align-items: center; justify-content: space-between; padding: 10px 14px; min-height: 44px; }
  .is-flow .brick-step + .brick-step { border-left: 0; border-top: 1px solid var(--color-line); }
  .is-flow .brick-step + .brick-step::before { content: none; }
  .is-flow .brick-step strong { font-size: 18px; }
  .brick-step span { white-space: normal; }
  .brick-steps-group { flex: 1 1 100%; }
  .brick-steps-row .brick-step { flex: 1 1 0; min-width: 0; }
  .brick-dash-setup li { flex-wrap: wrap; row-gap: 2px; }
  .brick-dash-setup li span { order: 9; flex-basis: 100%; white-space: normal; }
  .brick-dash-setup li a { margin-left: auto; }
  /* 매출 통계의 요약 넷은 둘씩 — 한 줄에 하나면 표까지 화면 세 개를 내려야 한다 */
  .brick-report-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .brick-admin .brick-report-summary .brick-card { padding: 12px 14px; }
  .brick-report-summary dd { font-size: 18px; }
}
`;

