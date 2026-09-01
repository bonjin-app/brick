"use client";

import { useEffect, useState } from "react";
import { useAdminT } from "../../../lib/i18n-admin";

interface DashCard {
  plugin: string;
  title: string;
  value: string | number | null;
  sub: string | null;
  link: string | null;
  error: boolean;
}

interface Dashboard {
  // 코어 통계는 서버에서 격리되어 실패하면 null 로 온다
  core: { members: number; membersToday: number; pages: number } | null;
  cards: DashCard[];
}

export default function AdminDashboard() {
  const t = useAdminT();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashFailed, setDashFailed] = useState(false);
  const [stats, setStats] = useState({ plugins: 0, activePlugins: 0, themes: 0, activeTheme: "-" });

  useEffect(() => {
    // 서버는 카드 실패를 격리한다 — 클라이언트도 같은 원칙: fetch 실패(401·500·
    // 네트워크)를 빈 화면으로 숨기지 않고, 오류 JSON 을 dash 로 오인하지 않는다.
    fetch("/api/admin/dashboard")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDash)
      .catch(() => setDashFailed(true));
    Promise.all([fetch("/api/plugins").then((r) => r.json()), fetch("/api/themes").then((r) => r.json())])
      .then(([plugins, themes]) =>
        setStats({
          plugins: plugins.length,
          activePlugins: plugins.filter((p: { isActive: boolean }) => p.isActive).length,
          themes: themes.themes.length,
          activeTheme: themes.active,
        }),
      )
      .catch(() => {});
  }, []);

  const card: React.CSSProperties = {
    background: "var(--color-bg)", borderRadius: 8, padding: 20, minWidth: 170,
    boxShadow: "0 1px 3px rgba(0,0,0,.08)", color: "inherit", textDecoration: "none",
  };
  const label: React.CSSProperties = { color: "var(--color-muted)", fontSize: 14 };
  const value: React.CSSProperties = { fontSize: 28, lineHeight: 1.4 };
  const sub: React.CSSProperties = { color: "var(--color-muted)", fontSize: 12.5 };

  const stat = (k: string, l: string, v: React.ReactNode, s?: string | null, link?: string | null) => {
    const body = (
      <>
        <div style={label}>{l}</div>
        <div style={value}>{v}</div>
        {s ? <div style={sub}>{s}</div> : null}
      </>
    );
    return link ? (
      <a key={k} href={link} style={card}>{body}</a>
    ) : (
      <div key={k} style={card}>{body}</div>
    );
  };

  return (
    <div>
      <h1>{t("nav.dashboard")}</h1>
      {/* 오늘의 사이트 — 코어(회원·페이지) + 플러그인 카드(오늘 방문자·주문·글·문의) */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {dashFailed ? <div style={card}>⚠ {t("dash.cardError")}</div> : null}
        {dash
          ? [
              ...(dash.core
                ? [
                    stat("members", t("dash.members"), dash.core.members,
                      t("dash.membersToday", { n: dash.core.membersToday }), "/admin/users"),
                    stat("pages", t("dash.pages"), dash.core.pages, null, "/admin/pages"),
                  ]
                : [stat("core-error", t("dash.members"), "⚠", t("dash.cardError"))]),
              ...dash.cards.map((c, i) =>
                stat(`${c.plugin}-${i}`, c.title,
                  c.error ? "⚠" : c.value, c.error ? t("dash.cardError") : c.sub, c.link),
              ),
            ]
          : null}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 16 }}>
        {stat("plugins", t("nav.plugins"), `${stats.activePlugins} / ${stats.plugins}`, null, "/admin/plugins")}
        {stat("themes", t("nav.themes"), stats.themes, null, "/admin/themes")}
        {stat("theme", t("dash.activeTheme"), stats.activeTheme, null, "/admin/themes")}
      </div>
    </div>
  );
}
