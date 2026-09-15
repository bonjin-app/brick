"use client";

/**
 * 회원 단체메일.
 *
 * **서버만 있고 화면이 없었다.** `docs/mailing.md` 는 "관리자 → 회원 → 단체메일" 이라고
 * 안내하고, 106개짜리 스모크가 (광고) 표기·동의자만 발송·수신거부 헤더까지 지키는데,
 * 그것을 쓰는 화면이 어디에도 없어서 운영자는 curl 없이는 한 통도 보낼 수 없었다.
 *
 * 이 화면이 조심하는 것:
 *   - **보내기 전에 대상 수를 보여준다.** 수만 명에게 잘못 보내는 것은 되돌릴 수 없다
 *     (서버의 preview 주석이 같은 말을 한다). 광고에서 동의하지 않아 빠진 인원도 함께
 *     보여준다 — "대상이 왜 이렇게 적은가" 에 답이 된다.
 *   - **법적 근거를 그 자리에 적는다.** 종류 목록이 note 로 내려주는 문구를 그대로 쓴다
 *     (정보통신망법 제50조). 운영자가 왜 제한되는지 알아야 우회하지 않는다.
 *   - **발송은 재인증을 요구한다**(ADR-75). 훔친 세션만으로 회원 전체에게 메일을 쏘게
 *     두지 않는다 — 서버가 403 reauth_required 로 막고, 여기서 비밀번호를 받는다.
 */
import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

interface Kind { code: string; label: string; note: string }
interface Row {
  id: string; kind: string; subject: string; status: string;
  total_count: number; sent_count: number; failed_count: number;
  created_at: string; created_by_name: string | null; error: string | null;
}

const card: React.CSSProperties = {
  background: "var(--color-bg)", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 13, color: "var(--color-text-soft)" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 14 };
/** 캠페인 상태 — 서버의 값(draft·sending·sent·cancelled·failed)과 같은 이름이다 */
const STATUS_LABEL = (t: (k: never) => string): Record<string, string> => ({
  draft: t("mail.statusDraft" as never),
  sending: t("mail.statusSending" as never),
  sent: t("mail.statusSent" as never),
  cancelled: t("mail.statusCancelled" as never),
  failed: t("mail.statusFailed" as never),
});

const input: React.CSSProperties = { padding: 8, border: "1px solid var(--color-line-strong)", borderRadius: 6, fontSize: 14, width: "100%", boxSizing: "border-box" };

export default function MailPage() {
  const t = useAdminT();
  const localeTag = useLocaleTag();
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState({ kind: "notice", subject: "", body: "" });
  const [filters, setFilters] = useState({ verifiedOnly: false, inactiveDays: "" });
  const [target, setTarget] = useState<{ count: number; excludedByConsent: number } | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 발송은 재인증을 요구한다 — 서버가 403 reauth_required 를 주면 여기서 받는다
  const [needReauth, setNeedReauth] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  /*
   * 이미 만들어 둔 캠페인.
   *
   * 발송이 실패하면(SMTP 미설정이 가장 흔하다) 캠페인은 이미 만들어져 있다.
   * 그대로 두면 다시 누를 때마다 같은 내용의 캠페인이 하나씩 쌓인다 — 나중에
   * SMTP 를 고치고 목록에서 보내면 같은 메일이 여러 통 나간다.
   */
  const [draftId, setDraftId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [k, l] = await Promise.all([
      fetch("/api/admin/mail/kinds").then((r) => r.json()).catch(() => ({ items: [] })),
      fetch("/api/admin/mail").then((r) => r.json()).catch(() => ({ items: [] })),
    ]);
    setKinds(k.items ?? []);
    setRows(l.items ?? []);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const filterBody = useCallback(() => ({
    verifiedOnly: filters.verifiedOnly,
    inactiveDays: filters.inactiveDays ? Number(filters.inactiveDays) : null,
  }), [filters]);

  /** 대상 수 — 종류·필터가 바뀔 때마다 다시 센다 */
  const preview = useCallback(async () => {
    const r = await fetch("/api/admin/mail/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: form.kind, filters: filterBody() }),
    });
    setTarget(r.ok ? await r.json() : null);
  }, [form.kind, filterBody]);
  useEffect(() => { void preview(); }, [preview]);

  async function createAndSend() {
    setBusy(true);
    if (draftId) { await send(draftId); return; }
    const created = await fetch("/api/admin/mail", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: form.kind, subject: form.subject, body: form.body, filters: filterBody() }),
    });
    const c = await created.json().catch(() => ({}));
    if (!created.ok) {
      setBusy(false); setFailed(true);
      setMessage(`${t("common.failPrefix")}${c.message ?? created.status}`);
      return;
    }
    setDraftId(String(c.id));
    await send(String(c.id));
  }

  async function send(id: string) {
    const r = await fetch(`/api/admin/mail/${id}/send`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.status === 403 && d?.code === "reauth_required") {
      // 발송 직전에 비밀번호를 묻는다. 캠페인은 이미 만들어졌으므로 확인 후 이어서 보낸다.
      setNeedReauth(id);
      setMessage("");
      return;
    }
    setFailed(!r.ok);
    setMessage(r.ok ? t("mail.started", { n: String(d.total ?? 0) }) : `${t("common.failPrefix")}${d.message ?? r.status}`);
    if (r.ok) { setForm({ ...form, subject: "", body: "" }); setDraftId(null); }
    // 실패해도 다시 읽는다 — 만들어진 캠페인이 목록에 보여야 중복으로 또 만들지 않는다
    void reload();
  }

  async function submitReauth(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/me/security/reauth", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setFailed(true);
      setMessage((await res.json().catch(() => ({}))).message ?? t("users.reauthFail"));
      return;
    }
    setPassword("");
    const id = needReauth;
    setNeedReauth(null);
    if (id) { setBusy(true); await send(id); }
  }

  // 제목·본문·종류·필터가 바뀌면 그것은 다른 메일이다 — 만들어 둔 것을 재사용하지 않는다
  useEffect(() => { setDraftId(null); }, [form.kind, form.subject, form.body, filters.verifiedOnly, filters.inactiveDays]);

  const note = kinds.find((k) => k.code === form.kind)?.note ?? "";

  return (
    <div>
      <h1 style={{ margin: "0 0 18px" }}>{t("mail.title")}</h1>

      <section style={card}>
        <h2 className="brick-card-title">{t("mail.compose")}</h2>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("mail.kind")}
          <select style={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {kinds.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
          </select>
        </label>
        {/* 법적 근거는 서버가 준 문구를 그대로 쓴다 — 화면에 따로 적으면 규칙이 바뀔 때 갈라진다 */}
        {note && <p style={{ fontSize: 12.5, color: "var(--color-muted)", marginTop: -4 }}>{note}</p>}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0" }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={filters.verifiedOnly}
              onChange={(e) => setFilters({ ...filters, verifiedOnly: e.target.checked })} />{" "}
            {t("mail.verifiedOnly")}
          </label>
          <label style={{ fontSize: 13 }}>{t("mail.inactiveDays")}{" "}
            <input style={{ ...input, width: 100, display: "inline-block" }} type="number" min={0}
              value={filters.inactiveDays}
              onChange={(e) => setFilters({ ...filters, inactiveDays: e.target.value })} />
          </label>
        </div>

        {/* 보내기 전에 대상 수를 본다 — 수만 명에게 잘못 보내는 것은 되돌릴 수 없다 */}
        <p role="status" data-testid="brick-mail-target" style={{
          margin: "0 0 14px", padding: "10px 12px", fontSize: 13.5, borderRadius: 8,
          background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
        }}>
          {target
            ? t("mail.targetCount", { n: Number(target.count).toLocaleString(localeTag) })
              + (target.excludedByConsent > 0
                ? ` · ${t("mail.excluded", { n: Number(target.excludedByConsent).toLocaleString(localeTag) })}`
                : "")
            : t("common.loading")}
        </p>

        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("mail.subject")}
          <input style={input} value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </label>
        <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("mail.body")}
          <textarea style={{ ...input, minHeight: 220, lineHeight: 1.6 }} value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </label>

        {needReauth ? (
          <form onSubmit={submitReauth} style={{ display: "flex", gap: 8, maxWidth: 420 }}>
            <input type="password" autoFocus placeholder={t("common.password")} value={password}
              onChange={(e) => setPassword(e.target.value)} style={{ ...input, flex: 1 }} />
            <button className="btn-primary" type="submit">{t("common.confirm")}</button>
          </form>
        ) : (
          <button className="btn-primary" disabled={busy || !form.subject.trim() || !form.body.trim()}
            onClick={() => void createAndSend()}>
            {busy ? t("common.loading") : t("mail.send", { n: String(target?.count ?? 0) })}
          </button>
        )}
        {needReauth && <p style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{t("mail.reauthNotice")}</p>}
        {message && (
          <p role={failed ? "alert" : "status"}
            style={{ fontSize: 13, color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
        )}
      </section>

      <section style={card}>
        <h2 className="brick-card-title">{t("mail.history")}</h2>
        {rows.length === 0 ? <p style={{ fontSize: 13.5, color: "var(--color-muted)" }}>{t("mail.empty")}</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="brick-x-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>{t("mail.colSubject")}</th>
                <th style={th}>{t("mail.colKind")}</th>
                <th style={th}>{t("mail.colStatus")}</th>
                <th style={th}>{t("mail.colSent")}</th>
                <th style={th}>{t("mail.colWhen")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={td} data-label={t("mail.colSubject")}>{r.subject}</td>
                    <td style={td} data-label={t("mail.colKind")}>{kinds.find((k) => k.code === r.kind)?.label ?? r.kind}</td>
                    <td style={td} data-label={t("mail.colStatus")}>{STATUS_LABEL(t)[r.status] ?? r.status}</td>
                    <td style={td} data-label={t("mail.colSent")}>
                      {Number(r.sent_count).toLocaleString(localeTag)} / {Number(r.total_count).toLocaleString(localeTag)}
                      {/*
                        읽어주지 않음: 이것은 방금 일어난 오류가 아니라 지난 발송의
                        **기록**이다. 표의 모든 행에 role="alert" 를 붙이면 화면을 열 때
                        스크린리더가 실패 건수를 줄줄이 읽는다. 실패 여부는 색이 아니라
                        "실패 3" 이라는 글자로 이미 전달된다.
                      */}
                      {r.failed_count > 0 && (
                        <span style={{ color: "var(--color-danger)" }}> · {t("mail.failedN", { n: String(r.failed_count) })}</span>
                      )}
                    </td>
                    <td style={td} data-label={t("mail.colWhen")}>{new Date(r.created_at).toLocaleString(localeTag)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
