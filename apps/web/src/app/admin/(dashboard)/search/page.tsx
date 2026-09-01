"use client";

/**
 * 검색 분석.
 *
 * **결과 0건 목록이 이 화면의 핵심이다.** 손님이 찾았는데 없는 것 —
 * 쇼핑몰이면 팔 수 있었던 것이고, 사이트면 안내가 빠진 것이다.
 * 그 다음이 치환 규칙이다: 부르는 이름이 달라서 못 찾은 것을 연결해준다.
 */
import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface Popular { query: string; count: number; emptyRatio: number }
interface NoResult { query: string; count: number; lastAt: string }
interface Rule { id: string; term: string; kind: string; replacement: string | null; note: string | null }

const card: React.CSSProperties = {
  background: "var(--color-bg)", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 13, color: "var(--color-text-soft)" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 14 };
const btn: React.CSSProperties = { padding: "6px 12px", cursor: "pointer", borderRadius: 6, border: "1px solid var(--color-line-strong)", background: "var(--color-bg)" };
const input: React.CSSProperties = { padding: 8, border: "1px solid var(--color-line-strong)", borderRadius: 6, fontSize: 14 };

export default function SearchAnalyticsPage() {
  const t = useAdminT();
  const [days, setDays] = useState(30);
  const [popular, setPopular] = useState<Popular[]>([]);
  const [empty, setEmpty] = useState<NoResult[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ term: "", kind: "replace", replacement: "", note: "" });

  const reload = useCallback(async () => {
    const [p, e, r] = await Promise.all([
      fetch(`/api/search/popular?days=${days}&limit=20`).then((x) => x.json()).catch(() => ({ items: [] })),
      fetch(`/api/admin/search/no-results?days=${days}&limit=50`).then((x) => x.json()).catch(() => ({ items: [] })),
      fetch(`/api/admin/search/rules`).then((x) => x.json()).catch(() => ({ items: [] })),
    ]);
    setPopular(p.items ?? []);
    setEmpty(e.items ?? []);
    setRules(r.items ?? []);
  }, [days]);

  useEffect(() => { void reload(); }, [reload]);

  async function saveRule() {
    const res = await fetch("/api/admin/search/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok ? t("search.savedRule") : `${t("common.saveFailPrefix")}${data.message ?? res.status}`);
    if (res.ok) setForm({ term: "", kind: "replace", replacement: "", note: "" });
    void reload();
  }

  async function removeRule(id: string) {
    await fetch(`/api/admin/search/rules/${id}`, { method: "DELETE" });
    void reload();
  }

  /** 0건 검색어를 치환 규칙 폼에 채운다 — 여기서 바로 이어지는 것이 이 화면의 목적이다 */
  function fillFrom(query: string) {
    setForm({ term: query, kind: "replace", replacement: "", note: "" });
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ margin: 0, flex: 1 }}>{t("search.title")}</h1>
        <select style={input} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>{t("search.days7")}</option>
          <option value={30}>{t("search.days30")}</option>
          <option value={90}>{t("search.days90")}</option>
        </select>
      </div>
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>
          {t("search.emptyTitle")} <span style={{ color: "var(--color-muted)", fontSize: 14 }}>{t("search.emptyCountN", { n: empty.length })}</span>
        </h2>
        <p style={{ color: "var(--color-text-soft)", fontSize: 13, marginTop: 0 }}>
          {t("search.emptyDesc")}
        </p>
        {empty.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>{t("search.emptyNone")}</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>{t("search.colQuery")}</th><th style={th}>{t("search.colCount")}</th><th style={th}>{t("search.colLast")}</th><th style={th}></th></tr></thead>
            <tbody>
              {empty.map((r) => (
                <tr key={r.query}>
                  <td style={{ ...td, fontWeight: 500 }}>{r.query}</td>
                  <td style={td}>{r.count}</td>
                  <td style={{ ...td, color: "var(--color-muted)" }}>{new Date(r.lastAt).toLocaleDateString("ko-KR")}</td>
                  <td style={td}>
                    <button style={btn} onClick={() => fillFrom(r.query)}>{t("search.link")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>{t("search.popularTitle")}</h2>
        <p style={{ color: "var(--color-text-soft)", fontSize: 13, marginTop: 0 }}>
          {t("search.popularDesc1")} {t("search.popularDesc2")}
        </p>
        {popular.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>{t("search.none")}</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>{t("search.colRank")}</th><th style={th}>{t("search.colQuery")}</th><th style={th}>{t("search.colCount")}</th><th style={th}>{t("search.colEmptyRate")}</th></tr></thead>
            <tbody>
              {popular.map((r, i) => (
                <tr key={r.query}>
                  <td style={{ ...td, color: "var(--color-muted)" }}>{i + 1}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{r.query}</td>
                  <td style={td}>{r.count}</td>
                  <td style={{ ...td, color: r.emptyRatio > 50 ? "var(--color-danger)" : "var(--color-text-soft)" }}>
                    {r.emptyRatio}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>{t("search.rulesTitle")}</h2>
        <p style={{ color: "var(--color-text-soft)", fontSize: 13, marginTop: 0 }}>
          {t("search.ruleReplaceDesc")}<br />
          {t("search.ruleBlockDesc")}
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
          <thead><tr><th style={th}>{t("search.colQuery")}</th><th style={th}>{t("search.colKind")}</th><th style={th}>{t("search.colReplacement")}</th><th style={th}>{t("search.colNote")}</th><th style={th}></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 500 }}>{r.term}</td>
                <td style={td}>{r.kind === "replace" ? t("search.replace") : t("search.block")}</td>
                <td style={td}>{r.replacement ?? "-"}</td>
                <td style={{ ...td, color: "var(--color-muted)" }}>{r.note ?? ""}</td>
                <td style={td}><button style={btn} onClick={() => void removeRule(r.id)}>{t("common.delete")}</button></td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td style={{ ...td, color: "var(--color-muted)" }} colSpan={5}>{t("search.noRules")}</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, width: 160 }} placeholder={t("search.colQuery")} value={form.term}
            onChange={(e) => setForm({ ...form, term: e.target.value })} />
          <select style={input} value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="replace">{t("search.replace")}</option>
            <option value="block">{t("search.block")}</option>
          </select>
          {form.kind === "replace" && (
            <input style={{ ...input, width: 160 }} placeholder={t("search.colReplacement")} value={form.replacement}
              onChange={(e) => setForm({ ...form, replacement: e.target.value })} />
          )}
          <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder={t("search.notePh")} value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <button style={{ ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "var(--color-primary)" }}
            onClick={() => void saveRule()}>{t("common.save")}</button>
        </div>
      </section>
    </div>
  );
}
