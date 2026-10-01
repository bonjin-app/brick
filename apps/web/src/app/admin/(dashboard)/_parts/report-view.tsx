"use client";

import { useEffect, useState } from "react";
import type { AdminReport, AdminResource } from "@brick/core";
import { useAdminT, type AdminMessageKey } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";
import { BarChart } from "./bar-chart";

type GroupBy = "day" | "week" | "month";
const GROUP_LABEL: Record<GroupBy, AdminMessageKey> = { day: "report.day", week: "report.week", month: "report.month" };

/** 이 브라우저의 날짜 (YYYY-MM-DD) — 운영자가 보는 달력과 같은 날 */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PRESETS: Array<{ key: AdminMessageKey; range: () => [string, string] }> = [
  { key: "report.today", range: () => { const d = new Date(); return [ymd(d), ymd(d)]; } },
  { key: "report.yesterday", range: () => { const d = new Date(); d.setDate(d.getDate() - 1); return [ymd(d), ymd(d)]; } },
  { key: "report.last7", range: () => { const d = new Date(); const f = new Date(); f.setDate(d.getDate() - 6); return [ymd(f), ymd(d)]; } },
  { key: "report.last30", range: () => { const d = new Date(); const f = new Date(); f.setDate(d.getDate() - 29); return [ymd(f), ymd(d)]; } },
  { key: "report.thisMonth", range: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(d)]; } },
  { key: "report.lastMonth", range: () => {
    const d = new Date();
    return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
  } },
];

/**
 * `kind: "report"` 화면 — 기간을 고르고 보기(기간별·상품별·분류별)를 바꾸며 요약·막대·표를 본다.
 *
 * 무엇을 세는지는 플러그인이 정한다(응답 {@link AdminReport}). 이 화면은 기간 고르기와 그리기만 한다.
 * 고른 기간·보기는 주소에 남긴다 — 운영자가 "지난달 상품별" 화면을 그대로 공유하거나 새로고침해도 같은 것을 본다.
 */
export function ReportView({ resource }: { resource: AdminResource & { plugin: string } }) {
  const t = useAdminT();
  const tag = useLocaleTag();
  const views = resource.reportViews?.length ? resource.reportViews : [{ code: "default", label: resource.title }];
  const api = `/api/plugins/${resource.plugin}${resource.basePath}`;

  const [view, setView] = useState(views[0].code);
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[3].range());
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [data, setData] = useState<AdminReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 주소의 값을 처음 한 번 읽는다 (선언한 보기·올바른 날짜만)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("view");
    if (v && views.some((x) => x.code === v)) setView(v);
    const f = q.get("from"), tt = q.get("to");
    if (f && tt && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(tt)) setRange([f, tt]);
    const g = q.get("groupBy");
    if (g === "day" || g === "week" || g === "month") setGroupBy(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = views.find((x) => x.code === view) ?? views[0];
  useEffect(() => {
    const qs = new URLSearchParams({ view, from, to, ...(current.groupBy ? { groupBy } : {}) });
    window.history.replaceState(null, "", `${window.location.pathname}?${qs.toString()}`);
    let alive = true;
    setLoading(true);
    setError("");
    fetch(`${api}?${qs.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message ?? t("x.listLoadFail"));
        return body as AdminReport;
      })
      .then((d) => { if (alive) setData(d); })
      .catch((e: Error) => { if (alive) { setData(null); setError(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, view, from, to, groupBy, current.groupBy]);

  const fmt = (v: unknown, type?: string) => {
    if (v === null || v === undefined || v === "") return "-";
    if (type === "money") return `${Number(v).toLocaleString(tag)}${t("x.wonSuffix")}`;
    if (type === "number") return Number(v).toLocaleString(tag);
    return String(v);
  };
  // CSV 는 플러그인 경로여야 한다 — 다른 출처로 내려받게 두지 않는다
  const csvHref = data?.csv && data.csv.startsWith("/") && !data.csv.startsWith("//")
    ? `/api/plugins/${resource.plugin}${data.csv}` : null;
  const activePreset = PRESETS.find((p) => { const [f, tt] = p.range(); return f === from && tt === to; })?.key;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, flex: 1 }}>{resource.title}</h1>
        {csvHref ? <a className="btn-link" href={csvHref} download>{t("report.csv")}</a> : null}
      </div>
      {resource.description ? <p style={{ color: "var(--color-text-soft)", fontSize: 14, margin: "8px 0 16px" }}>{resource.description}</p> : null}

      {views.length > 1 && (
        <div className="brick-x-tabs" role="tablist" aria-label={resource.title}>
          {views.map((v) => (
            <button key={v.code} type="button" role="tab" aria-selected={v.code === view}
              className={"brick-x-tab" + (v.code === view ? " is-on" : "")} onClick={() => setView(v.code)}>{v.label}</button>
          ))}
        </div>
      )}

      <div className="brick-report-bar">
        <div className="brick-report-presets" role="group" aria-label={t("report.period")}>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={activePreset === p.key ? "is-on" : ""} aria-pressed={activePreset === p.key}
              onClick={() => setRange(p.range())}>{t(p.key)}</button>
          ))}
        </div>
        <label>{t("report.from")}
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setRange([e.target.value, to])} />
        </label>
        <label>{t("report.to")}
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setRange([from, e.target.value])} />
        </label>
        {current.groupBy ? (
          <div className="brick-seg" role="group" aria-label={t("report.groupBy")}>
            {(["day", "week", "month"] as const).map((g) => (
              <button key={g} type="button" className={groupBy === g ? "is-on" : ""} aria-pressed={groupBy === g}
                onClick={() => setGroupBy(g)}>{t(GROUP_LABEL[g])}</button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? <div className="brick-card" role="alert" style={{ marginTop: 0, color: "var(--color-danger)" }}>{error}</div> : null}
      {!data && !error ? <p style={{ color: "var(--color-muted)" }}>{t("common.loading")}</p> : null}

      {data ? (
        <div aria-busy={loading} style={{ opacity: loading ? 0.6 : 1 }}>
          {data.summary?.length ? (
            <dl className="brick-report-summary">
              {data.summary.map((s, i) => (
                <div key={i} className="brick-card">
                  <dt>{s.label}</dt>
                  <dd>{s.value}</dd>
                  {s.delta !== undefined ? (
                    <span className={"brick-delta" + (s.delta && s.delta > 0 ? " is-up" : s.delta && s.delta < 0 ? " is-down" : "")}>
                      {s.delta === null ? t("report.noPrev") : `${s.delta > 0 ? "▲" : s.delta < 0 ? "▼" : ""} ${Math.abs(s.delta)}% ${t("report.vsPrev")}`}
                    </span>
                  ) : null}
                </div>
              ))}
            </dl>
          ) : null}

          {data.chart ? (
            <section className="brick-card" style={{ marginTop: 0, marginBottom: 16 }}>
              <BarChart unit={data.chart.unit} points={data.chart.points} />
            </section>
          ) : null}

          <div style={{ overflowX: "auto", background: "var(--color-bg)", borderRadius: 8 }}>
            <table className="brick-x-table brick-report-table" style={{ width: "100%", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-line)" }}>
                  {data.columns.map((c) => (
                    <th key={c.name} className={c.type === "money" || c.type === "number" ? "is-num" : undefined}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr className="brick-x-empty"><td colSpan={data.columns.length} data-label="" style={{ color: "var(--color-muted)" }}>{t("dash.chartEmpty")}</td></tr>
                ) : data.rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--color-line)" }}>
                    {data.columns.map((c) => (
                      <td key={c.name} data-label={c.label} className={c.type === "money" || c.type === "number" ? "is-num" : undefined}>{fmt(r[c.name], c.type)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.note ? <p className="brick-report-note">{data.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
