"use client";

/**
 * 그누보드 이전.
 *
 * `docs/migrate-gnuboard.md` 는 **"관리자 → 이전 에서 덤프를 올리고 분석을
 * 누릅니다"** 라고 한 절을 통째로 안내하는데, 그 화면이 없었다 — API 도 155개짜리
 * 스모크도 CLI 도 있는데 관리 화면만 없어서, 문서를 따라온 운영자는 없는 메뉴를
 * 찾게 된다. README 는 그누보드 이전을 기본 동봉 기능으로 내세운다.
 *
 * 이 화면이 지키는 것:
 *   - **리허설이 먼저다.** 분석은 아무것도 쓰지 않고 무엇이 옮겨질지만 보고한다.
 *     실행 버튼은 분석 결과를 본 뒤에야 나온다 — 되돌릴 수 없는 일이기 때문이다.
 *   - **옮겨지지 않는 것을 먼저 말한다**(skipped·warnings). 옮기고 나서 "왜 없지"를
 *     찾게 하면 그때는 이미 늦다.
 *   - 큰 덤프는 CLI 를 안내한다. 화면은 64MB 까지 받는다(서버와 같은 값).
 */
import { useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface Analyze {
  prefix: string;
  tableCount: number;
  members: { total: number; withEmail: number; withoutEmail: number; conflicts: string[] };
  levels: Array<{ level: number; count: number; role: string }>;
  boards: Array<{ table: string; slug: string; title: string; posts: number; comments: number; hasData: boolean }>;
  points: { members: number; total: number };
  shop: { categories: number; products: number; orders: number; revenue: number } | null;
  skipped: string[];
  warnings: string[];
}

const MAX_MB = 64;

const card: React.CSSProperties = {
  background: "var(--color-bg)", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 13, color: "var(--color-text-soft)" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 14 };

export default function MigratePage() {
  const t = useAdminT();
  const [dump, setDump] = useState("");
  const [fileName, setFileName] = useState("");
  const [analyze, setAnalyze] = useState<Analyze | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [opts, setOpts] = useState({ members: true, points: true, shop: true });
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, unknown> | null>(null);

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setAnalyze(null); setDone(null); setMessage("");
    if (f.size > MAX_MB * 1024 * 1024) {
      // 서버가 거절하기 전에 여기서 말한다 — 64MB 를 올려 보내고 나서 듣는 것은 낭비다
      setFailed(true);
      setMessage(t("migrate.tooBig", { mb: String(MAX_MB) }));
      setDump(""); setFileName("");
      return;
    }
    setFileName(f.name);
    setDump(await f.text());
    setFailed(false);
  }

  async function runAnalyze() {
    setBusy(true); setMessage("");
    const r = await fetch("/api/admin/migrate/analyze", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dump }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setFailed(true); setAnalyze(null); setMessage(`${t("common.failPrefix")}${d.message ?? r.status}`); return; }
    setFailed(false);
    setAnalyze(d);
    // 데이터가 있는 게시판만 기본 선택 — 껍데기만 있는 표를 옮겨도 빈 게시판이 늘 뿐이다
    setPicked(Object.fromEntries((d.boards ?? []).map((b: Analyze["boards"][number]) => [b.table, b.hasData])));
  }

  async function runMigrate() {
    if (!confirm(t("migrate.confirm"))) return;
    setBusy(true); setMessage("");
    const boards = (analyze?.boards ?? []).filter((b) => picked[b.table]).map((b) => b.table);
    const r = await fetch("/api/admin/migrate/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dump, boards, members: opts.members, points: opts.points, shop: opts.shop }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setFailed(!r.ok);
    if (!r.ok) { setMessage(`${t("common.failPrefix")}${d.message ?? r.status}`); return; }
    setDone(d);
    setMessage(t("migrate.done"));
  }

  return (
    <div>
      <h1 style={{ margin: "0 0 18px" }}>{t("migrate.title")}</h1>

      <section style={card}>
        <h2 className="brick-card-title">{t("migrate.step1")}</h2>
        <p style={{ fontSize: 13, color: "var(--color-muted)", marginTop: 0 }}>{t("migrate.uploadHint", { mb: String(MAX_MB) })}</p>
        <label style={{ display: "inline-flex", alignItems: "center", minHeight: 44, gap: 10, cursor: "pointer" }}>
          <span className="btn-primary" style={{ padding: "9px 16px", borderRadius: 6 }}>{t("migrate.pickFile")}</span>
          <input type="file" accept=".sql,text/plain" onChange={(e) => void pickFile(e)}
            style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
          <span style={{ fontSize: 13.5, color: "var(--color-muted)" }}>{fileName || t("migrate.noFile")}</span>
        </label>
        <div style={{ marginTop: 14 }}>
          <button className="btn-primary" disabled={!dump || busy} onClick={() => void runAnalyze()}>
            {busy && !analyze ? t("common.loading") : t("migrate.analyze")}
          </button>
        </div>
        {message && (
          <p role={failed ? "alert" : "status"}
            style={{ fontSize: 13, color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
        )}
      </section>

      {analyze && (
        <section style={card}>
          <h2 className="brick-card-title">{t("migrate.step2")}</h2>
          <p style={{ fontSize: 13.5 }}>
            {t("migrate.prefix", { prefix: analyze.prefix, n: String(analyze.tableCount) })}
          </p>

          <h3 style={{ fontSize: 15 }}>{t("migrate.members")}</h3>
          <p style={{ fontSize: 13.5 }}>
            {t("migrate.memberCount", { total: String(analyze.members.total), withEmail: String(analyze.members.withEmail), without: String(analyze.members.withoutEmail) })}
          </p>
          <ul style={{ fontSize: 13.5, paddingLeft: 20 }}>
            {analyze.levels.map((l) => (
              <li key={l.level}>{t("migrate.levelRow", { level: String(l.level), role: l.role, n: String(l.count) })}</li>
            ))}
          </ul>

          <h3 style={{ fontSize: 15 }}>{t("migrate.boards")}</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="brick-x-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>{t("migrate.colPick")}</th>
                <th style={th}>{t("migrate.colBoard")}</th>
                <th style={th}>{t("migrate.colPosts")}</th>
                <th style={th}>{t("migrate.colComments")}</th>
              </tr></thead>
              <tbody>
                {analyze.boards.map((b) => (
                  <tr key={b.table}>
                    <td style={td} className="brick-x-pick" data-label="">
                      <label>
                        <input type="checkbox" checked={picked[b.table] ?? false}
                          onChange={(e) => setPicked({ ...picked, [b.table]: e.target.checked })} />{" "}
                        <span style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{b.table}</span>
                      </label>
                    </td>
                    <td style={td} data-label={t("migrate.colBoard")}>{b.title} <code style={{ fontSize: 12 }}>/{b.slug}</code></td>
                    <td style={td} data-label={t("migrate.colPosts")}>{b.hasData ? b.posts.toLocaleString() : t("migrate.noData")}</td>
                    <td style={td} data-label={t("migrate.colComments")}>{b.hasData ? b.comments.toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {analyze.shop && (
            <>
              <h3 style={{ fontSize: 15 }}>{t("migrate.shop")}</h3>
              <p style={{ fontSize: 13.5 }}>
                {t("migrate.shopCount", { products: String(analyze.shop.products), orders: String(analyze.shop.orders) })}
              </p>
            </>
          )}

          {/* 옮겨지지 않는 것을 먼저 말한다 — 옮기고 나서 "왜 없지" 를 찾게 하면 늦다 */}
          {(analyze.skipped.length > 0 || analyze.warnings.length > 0) && (
            <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8, background: "var(--color-bg-soft)", border: "1px solid var(--color-line)" }}>
              <strong style={{ fontSize: 14 }}>{t("migrate.skipped")}</strong>
              <ul style={{ fontSize: 13, margin: "6px 0 0", paddingLeft: 20 }}>
                {analyze.skipped.map((x) => <li key={x}>{x}</li>)}
                {analyze.warnings.map((x) => <li key={x} style={{ color: "var(--color-warning)" }}>{x}</li>)}
              </ul>
            </div>
          )}

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "16px 0" }}>
            {(["members", "points", "shop"] as const).map((k) => (
              <label key={k} style={{ fontSize: 13.5 }}>
                <input type="checkbox" checked={opts[k]}
                  onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />{" "}
                {t(`migrate.opt_${k}` as never)}
              </label>
            ))}
          </div>

          <button className="btn-primary" disabled={busy} onClick={() => void runMigrate()}>
            {busy ? t("common.loading") : t("migrate.run")}
          </button>
          <p style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{t("migrate.runHint")}</p>
        </section>
      )}

      {done && (
        <section style={card}>
          <h2 className="brick-card-title">{t("migrate.result")}</h2>
          <pre style={{ fontSize: 13, overflowX: "auto", background: "var(--color-bg-soft)", padding: 14, borderRadius: 8 }}>
            {JSON.stringify(done, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
