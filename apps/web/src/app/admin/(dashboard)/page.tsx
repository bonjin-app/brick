"use client";

import { useEffect, useState } from "react";
import { useAdminT } from "../../../lib/i18n-admin";
import { useLocaleTag } from "../../../lib/i18n";
import { BarChart } from "./_parts/bar-chart";

interface DashCard {
  plugin: string;
  title: string;
  value: string | number | null;
  sub: string | null;
  link: string | null;
  error: boolean;
}

interface PanelStep { label: string; value: number; link?: string; tone?: "default" | "attention" }
/** 플러그인의 대시보드 판 — 모양은 셋(코어 계약 DashboardPanelData 와 같다) */
type PanelData =
  | { kind: "steps"; groups: Array<{ label?: string; flow?: boolean; steps: PanelStep[] }> }
  | { kind: "chart"; unit: "won" | "count"; points: Array<{ label: string; value: number; sub?: string }>; summary?: Array<{ label: string; value: string }> }
  | { kind: "list"; rows: Array<{ title: string; meta?: string; value?: string; badge?: string; link?: string }>; empty?: string };
interface DashPanel { plugin: string; title: string; link: string | null; size: "full" | "half"; data: PanelData | null; error: boolean }

interface Dashboard {
  // 코어 통계는 서버에서 격리되어 실패하면 null 로 온다
  core: { members: number; membersToday: number; pages: number } | null;
  cards: DashCard[];
  /** 대시보드 판 — 옛 서버는 보내지 않는다 */
  panels?: DashPanel[];
  /** 메일을 보낼 수 있는 상태인가 — SMTP 가 없으면 모든 메일이 콘솔로만 나간다 */
  /*
   * 운영자가 모르는 채로 잘못 설정한 것들 (판정은 API 가 한다 — 환경변수·SMTP·
   * 프록시는 서버만 안다). id 를 열거형으로 묶어 두면 `dash.<id>` / `dash.<id>Detail`
   * 번역이 없는 경고를 **빌드가 막는다** — 배너가 키 이름을 그대로 보여주는 일이 없다.
   */
  setup?: Array<{
    id: "mailOff" | "siteUrlLocal" | "trustProxyOff" | "businessInfoMissing" | "pluginNotRunning" | "themeNotRendering" | "maintenanceOn" | "jobsFailed";
    docs: string;
    /** 문장에 끼울 값 (예: 실패한 작업 수와 이름) — 판정한 쪽이 안다 */
    params?: Record<string, string | number>;
  }>;
}

interface VersionInfo {
  version: string;
  updateCheck: boolean;
  latest: { version: string; url: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  error: string | null;
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
  const localeTag = useLocaleTag();
  const t = useAdminT();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashFailed, setDashFailed] = useState(false);
  const [stats, setStats] = useState({ plugins: 0, activePlugins: 0, themes: 0, activeTheme: "-" });
  const [recent, setRecent] = useState<AuditRow[] | null>(null);
  const [ver, setVer] = useState<VersionInfo | null>(null);
  /*
   * 역할.
   *
   * 이 화면의 카드·빠른 작업은 **전부 관리자 전용 API** 를 읽는다. 운영자에게는
   * "⚠ 불러오지 못했습니다" 와 누를 수 없는 링크만 남았다 — 자기가 쓸 수 있는
   * 화면은 왼쪽에 있는데 이 화면이 그것을 가리지도 않았다.
   */
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRole(d?.user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

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
    // 버전·새 릴리스 — 실패해도 카드만 비운다
    fetch("/api/admin/version").then((r) => (r.ok ? r.json() : null)).then((v) => v && setVer(v)).catch(() => {});
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

  if (role && role !== "admin") {
    return (
      <div>
        <h1>{t("nav.dashboard")}</h1>
        <div className="brick-card" role="status">
          <p style={{ margin: 0 }}>{t("dash.managerNotice")}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/*
        빠른 작업 막대(사이트 보기 · 페이지 · 미디어 · 회원 · 설정)는 없앴다 — 사이트 보기는 위 막대에,
        나머지는 왼쪽 묶음에 있다. 같은 길이 세 군데 있으면 첫 화면의 자리만 차지한다.
      */}
      <div className="brick-dash-head">
        <h1>{t("nav.dashboard")}</h1>
        <span>{new Date().toLocaleDateString(localeTag, { month: "long", day: "numeric", weekday: "long" })}</span>
      </div>

      {/* 새 버전 알림 — 교체는 운영자가 프로세스 밖에서 한다(update.mjs · docker pull). 여기서는 알리기만 */}
      {ver?.updateAvailable && ver.latest ? (
        <div className="brick-card" role="status" style={{ marginTop: 0, marginBottom: 16, borderColor: "var(--color-primary)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <strong>{t("dash.updateAvailable", { v: ver.latest.version })}</strong>
          <span style={{ color: "var(--color-muted)", fontSize: 13.5 }}>{t("dash.updateCurrent", { v: ver.version })}</span>
          <a className="btn-link" href={ver.latest.url} target="_blank" rel="noopener" style={{ marginLeft: "auto" }}>{t("dash.releaseNotes")} ↗</a>
          <a className="btn-link" href="https://github.com/bonjin-app/brick/blob/main/docs/upgrade.md" target="_blank" rel="noopener">{t("dash.howToUpdate")} ↗</a>
        </div>
      ) : null}

      {/*
        메일이 나가지 않는 상태를 알린다.
        SMTP 가 없으면 주문 안내(무통장 계좌!)·비밀번호 재설정·이메일 인증이
        **조용히** 사라진다. 손님은 계좌를 못 받아 입금하지 못하고, 운영자는
        "주문 안내 메일" 스위치가 켜져 있으니 되는 줄 안다. 뉴스레터만 큰 소리로
        거부하고 있었다 — 거래 메일은 말없이 버려졌다.
      */}
      {/*
        * 설정 경고 — 틀려도 조용한 것들만 모아 여기서 한 번 말한다.
        * 무엇을 경고할지는 API 가 정한다(환경변수·SMTP·프록시는 서버만 안다).
        */}
      {/*
        * 경고가 셋이면 카드 셋이 첫 화면을 다 덮었다 — 운영자가 매일 보러 오는 주문 현황이
        * 스크롤 아래로 밀렸다. 한 카드 안의 줄로 접는다. 설명은 한 줄로 자르고 전체는 title 로.
        */}
      {(dash?.setup?.length ?? 0) > 0 && (
        <section className="brick-card brick-dash-setup" role="alert" aria-labelledby="dash-setup">
          <h2 id="dash-setup">{t("dash.setupTitle", { n: dash!.setup!.length })}</h2>
          <ul>
            {dash!.setup!.map((w) => (
              <li key={w.id}>
                <strong>{t(`dash.${w.id}`, w.params)}</strong>
                <span title={t(`dash.${w.id}Detail`, w.params)}>{t(`dash.${w.id}Detail`, w.params)}</span>
                <a href={w.docs} target="_blank" rel="noopener">{t("dash.setupHow")} ↗</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 플러그인의 판 — 주문 흐름 · 매출 추이 · 최근 주문. 반쪽 판은 넓은 화면에서 둘이 나란히 */}
      {(dash?.panels?.length ?? 0) > 0 && (
        <div className="brick-dash-panels">
          {dash!.panels!.map((p, i) => <Panel key={`${p.plugin}-${i}`} p={p} />)}
        </div>
      )}

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
        {ver ? stat("version", t("dash.version"), `v${ver.version}`,
          !ver.updateCheck ? t("dash.updateCheckOff") : ver.error ? t("dash.updateCheckFailed") : ver.updateAvailable && ver.latest ? t("dash.updateTo", { v: ver.latest.version }) : t("dash.upToDate"),
          "https://github.com/bonjin-app/brick/releases") : null}
      </div>

      {/* 최근 활동 — 무슨 일이 있었는지 한 화면에서. 자세한 필터는 감사 로그로 */}
      <section className="brick-card" style={{ marginTop: 20 }} aria-labelledby="dash-recent">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2 id="dash-recent" className="brick-card-title" style={{ marginBottom: 0 }}>{t("dash.recent")}</h2>
          <a href="/admin/audit" style={{ fontSize: 13.5, display: "inline-block", padding: "6px 0", minHeight: 28 }}>{t("dash.recentAll")} →</a>
        </div>
        {recent === null ? null : recent.length === 0 ? (
          <p style={{ color: "var(--color-muted)", fontSize: 14, margin: "14px 0 0" }}>{t("dash.recentEmpty")}</p>
        ) : (
          <ul className="brick-activity">
            {recent.map((r) => (
              <li key={r.id}>
                <time dateTime={r.createdAt} title={new Date(r.createdAt).toLocaleString(localeTag)}>
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

/** 대시보드 판 하나 — 모양(steps · chart · list)마다 그린다 */
function Panel({ p }: { p: DashPanel }) {
  const t = useAdminT();
  const localeTag = useLocaleTag();
  const d = p.data;
  return (
    <section className={"brick-card brick-panel" + (p.size === "half" ? " is-half" : "")} aria-label={p.title}>
      <div className="brick-panel-head">
        <h2 className="brick-card-title">{p.title}</h2>
        {p.link ? <a href={p.link}>{t("dash.viewAll")} →</a> : null}
      </div>
      {p.error || !d ? (
        <p className="brick-panel-empty">⚠ {t("dash.cardError")}</p>
      ) : d.kind === "steps" ? (
        <div className="brick-steps">
          {d.groups.map((g, gi) => (
            <div key={gi} className={"brick-steps-group" + (g.flow ? " is-flow" : "")}>
              {g.label ? <div className="brick-steps-label">{g.label}</div> : null}
              <div className="brick-steps-row">
                {g.steps.map((s, si) => {
                  const hot = s.tone === "attention" && s.value > 0;
                  const body = (<><span>{s.label}</span><strong>{s.value.toLocaleString(localeTag)}</strong></>);
                  return s.link ? (
                    <a key={si} href={s.link} className={"brick-step" + (hot ? " is-hot" : "")}>{body}</a>
                  ) : (
                    <div key={si} className={"brick-step" + (hot ? " is-hot" : "")}>{body}</div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : d.kind === "chart" ? (
        <Chart d={d} />
      ) : d.rows.length === 0 ? (
        <p className="brick-panel-empty">{d.empty ?? "—"}</p>
      ) : (
        <ul className="brick-panel-list">
          {d.rows.map((r, i) => {
            const body = (
              <>
                <span className="brick-pl-main"><strong>{r.title}</strong>{r.meta ? <small>{r.meta}</small> : null}</span>
                {r.badge ? <span className="brick-pl-badge">{r.badge}</span> : null}
                {r.value ? <span className="brick-pl-value">{r.value}</span> : null}
              </>
            );
            return <li key={i}>{r.link ? <a href={r.link}>{body}</a> : <div>{body}</div>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

/** 막대 판 — 합계 숫자 + 막대 (막대는 매출 통계 화면과 같은 부품) */
function Chart({ d }: { d: Extract<PanelData, { kind: "chart" }> }) {
  return (
    <>
      {d.summary?.length ? (
        <dl className="brick-chart-summary">
          {d.summary.map((s, i) => (<div key={i}><dt>{s.label}</dt><dd>{s.value}</dd></div>))}
        </dl>
      ) : null}
      <BarChart unit={d.unit} points={d.points} />
    </>
  );
}

/** 요약이 "행위자: 내용" 꼴이면 행위자 열과 겹치므로 앞부분을 뗀다 */
function summaryOf(r: AuditRow): string {
  const text = r.summary ?? r.targetId ?? r.action;
  const prefix = r.actorEmail ? `${r.actorEmail}: ` : "";
  return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
