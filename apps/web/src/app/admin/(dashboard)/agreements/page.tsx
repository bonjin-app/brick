"use client";

/**
 * 약관 관리 — 개정 발행.
 *
 * **기본 약관은 초안이다.** 본문 첫 줄이 "※ 이 문서는 초안입니다. 실제로 수집하는
 * 항목에 맞게 반드시 고쳐 쓰세요" 라고 말한다. 그런데 **고칠 화면이 없었다** —
 * `GET/POST /api/admin/agreements` 가 감사 로그까지 갖추고 있었지만 부르는 곳이
 * 어디에도 없어서, 운영자는 curl 없이는 자기 사이트의 이용약관·개인정보처리방침을
 * 바꿀 수 없었다. 모든 사이트가 초안을 내걸고 있었다는 뜻이다.
 *
 * 개정은 **기존 버전을 고치지 않고 새 버전을 만든다**(서버 규칙). 누가 어느 버전에
 * 동의했는지가 증거이므로 지난 문서를 덮어쓰면 그 증거가 사라진다. 그래서 이 화면도
 * "수정" 이 아니라 "개정 발행" 이라고 말한다.
 */
import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

interface Row {
  id: string;
  kind: string;
  version: number;
  title: string;
  is_required: boolean;
  effective_at: string | null;
  created_at: string;
  agreed_count: number;
}

const KIND_LABEL: Record<string, string> = {
  terms: "이용약관",
  privacy: "개인정보 수집·이용",
  marketing: "광고성 정보 수신",
  third_party: "제3자 제공",
};

const card: React.CSSProperties = {
  background: "var(--color-bg)", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 13, color: "var(--color-text-soft)" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 14 };
const input: React.CSSProperties = { padding: 8, border: "1px solid var(--color-line-strong)", borderRadius: 6, fontSize: 14, width: "100%", boxSizing: "border-box" };

export default function AgreementsPage() {
  const t = useAdminT();
  const localeTag = useLocaleTag();
  const [rows, setRows] = useState<Row[]>([]);
  const [kind, setKind] = useState("terms");
  const [form, setForm] = useState({ title: "", body: "", isRequired: true, effectiveAt: "" });
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const d = await fetch("/api/admin/agreements").then((r) => r.json()).catch(() => ({ items: [] }));
    setRows(d.items ?? []);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  /** 고르면 **지금 쓰이는 문서를 채워 준다** — 빈 칸에서 다시 쓰라고 하면 아무도 고치지 않는다 */
  const loadCurrent = useCallback(async (k: string) => {
    const latest = rows.filter((r) => r.kind === k).sort((a, b) => b.version - a.version)[0];
    if (!latest) { setForm({ title: KIND_LABEL[k] ?? k, body: "", isRequired: k !== "marketing", effectiveAt: "" }); return; }
    const d = await fetch(`/api/admin/agreements/${latest.id}`).then((r) => r.json()).catch(() => null);
    setForm({
      title: String(d?.title ?? latest.title),
      body: String(d?.body ?? ""),
      isRequired: Boolean(d?.is_required ?? latest.is_required),
      effectiveAt: "",
    });
  }, [rows]);

  useEffect(() => { void loadCurrent(kind); }, [kind, loadCurrent]);

  async function publish() {
    setBusy(true);
    const res = await fetch("/api/admin/agreements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        title: form.title,
        body: form.body,
        isRequired: form.isRequired,
        ...(form.effectiveAt ? { effectiveAt: form.effectiveAt } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setFailed(!res.ok);
    setMessage(res.ok ? t("agreements.published", { version: String(d.version ?? "") }) : `${t("common.failPrefix")}${d.message ?? res.status}`);
    if (res.ok) void reload();
  }

  const byKind = Object.keys(KIND_LABEL);
  const latestOf = (k: string) => rows.filter((r) => r.kind === k).sort((a, b) => b.version - a.version)[0];

  return (
    <div>
      <h1 style={{ margin: "0 0 18px" }}>{t("agreements.title")}</h1>

      <section style={card}>
        <h2 className="brick-card-title">{t("agreements.current")}</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>{t("agreements.colKind")}</th>
              <th style={th}>{t("agreements.colVersion")}</th>
              <th style={th}>{t("agreements.colRequired")}</th>
              <th style={th}>{t("agreements.colAgreed")}</th>
              <th style={th}>{t("agreements.colEffective")}</th>
            </tr></thead>
            <tbody>
              {byKind.map((k) => {
                const r = latestOf(k);
                return (
                  <tr key={k}>
                    <td style={td}>{KIND_LABEL[k]}</td>
                    <td style={td}>{r ? t("agreements.version", { n: String(r.version) }) : "—"}</td>
                    <td style={td}>{r ? (r.is_required ? t("agreements.required") : t("agreements.optional")) : "—"}</td>
                    <td style={td}>{r ? Number(r.agreed_count).toLocaleString(localeTag) : "—"}</td>
                    <td style={td}>{r?.effective_at ? new Date(r.effective_at).toLocaleDateString(localeTag) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section style={card}>
        <h2 className="brick-card-title">{t("agreements.publish")}</h2>
        {/*
          필수 약관을 개정하면 **기존 회원이 다시 동의해야 한다**(마이페이지에 뜬다).
          모르고 누르면 모든 회원에게 동의 창이 뜨므로 미리 말한다.
        */}
        <p style={{ fontSize: 13, color: "var(--color-muted)", marginTop: 0 }}>{t("agreements.publishHint")}</p>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("agreements.colKind")}
          <select style={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {byKind.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("agreements.formTitle")}
          <input style={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("agreements.formBody")}
          <textarea style={{ ...input, minHeight: 320, fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}
            value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </label>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={form.isRequired}
            onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} />{" "}
          {t("agreements.formRequired")}
          <span style={{ display: "block", color: "var(--color-muted)", fontSize: 12.5 }}>{t("agreements.formRequiredHint")}</span>
        </label>

        <label style={{ display: "block", fontSize: 13, marginBottom: 16 }}>{t("agreements.formEffective")}
          <input style={input} type="date" value={form.effectiveAt}
            onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} />
          <span style={{ display: "block", color: "var(--color-muted)", fontSize: 12.5 }}>{t("agreements.formEffectiveHint")}</span>
        </label>

        <button className="btn-primary" disabled={busy || !form.title.trim() || !form.body.trim()}
          onClick={() => void publish()}>
          {busy ? t("common.loading") : t("agreements.publishBtn")}
        </button>
        {message && (
          <p role={failed ? "alert" : "status"}
            style={{ fontSize: 13, color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
        )}
      </section>
    </div>
  );
}
