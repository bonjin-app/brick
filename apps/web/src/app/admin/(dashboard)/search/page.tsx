"use client";

/**
 * 검색 분석.
 *
 * **결과 0건 목록이 이 화면의 핵심이다.** 손님이 찾았는데 없는 것 —
 * 쇼핑몰이면 팔 수 있었던 것이고, 사이트면 안내가 빠진 것이다.
 * 그 다음이 치환 규칙이다: 부르는 이름이 달라서 못 찾은 것을 연결해준다.
 */
import { useCallback, useEffect, useState } from "react";

interface Popular { query: string; count: number; emptyRatio: number }
interface NoResult { query: string; count: number; lastAt: string }
interface Rule { id: string; term: string; kind: string; replacement: string | null; note: string | null }

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #eee", fontSize: 13, color: "#666" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #f4f4f7", fontSize: 14 };
const btn: React.CSSProperties = { padding: "6px 12px", cursor: "pointer", borderRadius: 6, border: "1px solid #ddd", background: "#fff" };
const input: React.CSSProperties = { padding: 8, border: "1px solid #ddd", borderRadius: 6, fontSize: 14 };

export default function SearchAnalyticsPage() {
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
    setMessage(res.ok ? "저장했습니다." : `저장 실패: ${data.message ?? res.status}`);
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
        <h1 style={{ margin: 0, flex: 1 }}>검색 분석</h1>
        <select style={input} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      </div>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>
          결과가 없던 검색어 <span style={{ color: "#999", fontSize: 14 }}>{empty.length}개</span>
        </h2>
        <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
          손님이 찾았는데 없던 것입니다. 상품·안내가 빠졌거나, 부르는 이름이 달라서
          못 찾은 것입니다 — 후자는 아래 치환 규칙으로 연결해주세요.
        </p>
        {empty.length === 0 ? (
          <p style={{ color: "#999" }}>없습니다. (검색 기록이 쌓이면 표시됩니다)</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>검색어</th><th style={th}>횟수</th><th style={th}>마지막</th><th style={th}></th></tr></thead>
            <tbody>
              {empty.map((r) => (
                <tr key={r.query}>
                  <td style={{ ...td, fontWeight: 500 }}>{r.query}</td>
                  <td style={td}>{r.count}</td>
                  <td style={{ ...td, color: "#888" }}>{new Date(r.lastAt).toLocaleDateString("ko-KR")}</td>
                  <td style={td}>
                    <button style={btn} onClick={() => fillFrom(r.query)}>연결하기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>인기 검색어</h2>
        <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
          같은 사람이 하루에 여러 번 검색한 것은 한 번으로 셉니다.
          <strong> 빈손 비율</strong>이 높으면 인기 있는데 결과가 없다는 뜻입니다 — 가장 먼저 손보세요.
        </p>
        {popular.length === 0 ? (
          <p style={{ color: "#999" }}>없습니다.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>순위</th><th style={th}>검색어</th><th style={th}>횟수</th><th style={th}>빈손 비율</th></tr></thead>
            <tbody>
              {popular.map((r, i) => (
                <tr key={r.query}>
                  <td style={{ ...td, color: "#999" }}>{i + 1}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{r.query}</td>
                  <td style={td}>{r.count}</td>
                  <td style={{ ...td, color: r.emptyRatio > 50 ? "crimson" : "#666" }}>
                    {r.emptyRatio}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>검색어 규칙</h2>
        <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
          <strong>치환</strong> — "아이폰15" 로 찾는데 상품명이 "iPhone 15" 면 결과가 0건입니다. 연결해주세요.<br />
          <strong>차단</strong> — 인기 검색어 집계에서 제외합니다(검색 자체는 막지 않습니다).
          경쟁사명·욕설이 화면에 노출되는 것을 막습니다.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
          <thead><tr><th style={th}>검색어</th><th style={th}>종류</th><th style={th}>바꿀 검색어</th><th style={th}>메모</th><th style={th}></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 500 }}>{r.term}</td>
                <td style={td}>{r.kind === "replace" ? "치환" : "차단"}</td>
                <td style={td}>{r.replacement ?? "-"}</td>
                <td style={{ ...td, color: "#888" }}>{r.note ?? ""}</td>
                <td style={td}><button style={btn} onClick={() => void removeRule(r.id)}>삭제</button></td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td style={{ ...td, color: "#999" }} colSpan={5}>규칙이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, width: 160 }} placeholder="검색어" value={form.term}
            onChange={(e) => setForm({ ...form, term: e.target.value })} />
          <select style={input} value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="replace">치환</option>
            <option value="block">차단</option>
          </select>
          {form.kind === "replace" && (
            <input style={{ ...input, width: 160 }} placeholder="바꿀 검색어" value={form.replacement}
              onChange={(e) => setForm({ ...form, replacement: e.target.value })} />
          )}
          <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder="메모 (선택)" value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <button style={{ ...btn, background: "#1a1a2e", color: "#fff", borderColor: "#1a1a2e" }}
            onClick={() => void saveRule()}>저장</button>
        </div>
      </section>
    </div>
  );
}
