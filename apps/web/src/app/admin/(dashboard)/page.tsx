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

interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  summary: string | null;
  targetId: string | null;
  createdAt: string;
}

export default function AdminDashboard() {
  const t = useAdminT();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashFailed, setDashFailed] = useState(false);
  const [stats, setStats] = useState({ plugins: 0, activePlugins: 0, themes: 0, activeTheme: "-" });
  const [recent, setRecent] = useState<AuditRow[] | null>(null);

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
    // 최근 활동 — 감사 로그 첫 페이지의 앞 8건. 실패하면 영역을 비운다(대시보드를 죽이지 않는다)
    fetch("/api/audit?page=1")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { items: AuditRow[] }) => setRecent(d.items.slice(0, 8)))
      .catch(() => setRecent([]));
  }, []);

  const label: React.CSSProperties = { color: "var(--color-muted)", fontSize: 13.5 };
  const value: React.CSSProperties = { fontSize: 30, lineHeight: 1.3, fontWeight: 600, letterSpacing: "-0.01em", marginTop: 2 };
  const sub: React.CSSProperties = { color: "var(--color-muted)", fontSize: 12.5, marginTop: 2 };

  const stat = (k: string, l: string, v: React.ReactNode, s?: string | null, link?: string | null) => {
    const body = (
      <>
        <div style={label}>{l}</div>
        <div style={value}>{v}</div>
        {s ? <div style={sub}>{s}</div> : null}
      </>
    );
    return link ? (
      <a key={k} href={link} className="brick-card brick-stat">{body}</a>
    ) : (
      <div key={k} className="brick-card brick-stat">{body}</div>
    );
  };

  const quick: Array<[string, string]> = [
    ["/", t("dash.viewSite")],
    ["/admin/pages", t("nav.pages")],
    ["/admin/media", t("nav.media")],
    ["/admin/users", t("nav.users")],
    ["/admin/settings", t("nav.settings")],
  ];

  return (
    <div>
      <h1>{t("nav.dashboard")}</h1>

      {/* 빠른 작업 — 운영자가 매일 여는 곳. 사이트 보기는 새 탭(관리 화면을 잃지 않게) */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        {quick.map(([href, text]) => (
          <a key={href} href={href} className="btn-link" target={href === "/" ? "_blank" : undefined} rel={href === "/" ? "noopener" : undefined}>
            {text}{href === "/" ? " ↗" : ""}
          </a>
        ))}
      </div>

      {/* 오늘의 사이트 — 코어(회원·페이지) + 플러그인 카드(오늘 방문자·주문·글·문의) */}
      <div className="brick-stat-grid">
        {dashFailed ? <div className="brick-card brick-stat">⚠ {t("dash.cardError")}</div> : null}
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
        {stat("plugins", t("nav.plugins"), `${stats.activePlugins} / ${stats.plugins}`, null, "/admin/plugins")}
        {stat("theme", t("dash.activeTheme"), stats.activeTheme, t("dash.themesN", { n: stats.themes }), "/admin/themes")}
      </div>

      {/* 최근 활동 — 무슨 일이 있었는지 한 화면에서. 자세한 필터는 감사 로그로 */}
      <section className="brick-card" style={{ marginTop: 20 }} aria-labelledby="dash-recent">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2 id="dash-recent" className="brick-card-title" style={{ marginBottom: 0 }}>{t("dash.recent")}</h2>
          <a href="/admin/audit" style={{ fontSize: 13.5 }}>{t("dash.recentAll")} →</a>
        </div>
        {recent === null ? null : recent.length === 0 ? (
          <p style={{ color: "var(--color-muted)", fontSize: 14, margin: "14px 0 0" }}>{t("dash.recentEmpty")}</p>
        ) : (
          <ul className="brick-activity">
            {recent.map((r) => (
              <li key={r.id}>
                <time dateTime={r.createdAt} title={new Date(r.createdAt).toLocaleString()}>
                  {new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
                <span className="brick-activity-actor">{r.actorEmail ?? t("audit.system")}</span>
                <span className="brick-activity-text">{summaryOf(r)}</span>
                <code className="brick-activity-action">{r.action}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 요약이 "행위자: 내용" 꼴이면 행위자 열과 겹치므로 앞부분을 뗀다 */
function summaryOf(r: AuditRow): string {
  const text = r.summary ?? r.targetId ?? r.action;
  const prefix = r.actorEmail ? `${r.actorEmail}: ` : "";
  return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
