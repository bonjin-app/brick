"use client";

/**
 * 알림 문구 — 주문 안내 같은 알림의 제목·본문·문자 문구를 운영자가 고친다.
 *
 * 문구가 코드(번역 카탈로그)에 있어서, "입금 확인 후 1~2일 안에 발송됩니다" 한 줄을 더하려면
 * 개발자가 코드를 고쳐야 했다. 알림을 보내는 플러그인이 알림 종류·변수·기본 문구를 선언하고,
 * 운영자가 고친 것만 저장된다. 고치지 않은 알림은 기본 문구로 나간다.
 *
 * 편집은 **지금 나가는 문구에서 시작한다** — 빈 칸에서 다시 쓰라고 하면 아무도 고치지 않는다.
 * 기본 문구는 실제 발송이 쓰는 것과 같은 템플릿이다(보내는 쪽이 그것을 채워 보낸다).
 */
import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

interface Item { event: string; label: string; plugin: string; editable: boolean; customized: boolean; updatedAt: string | null }
interface Detail {
  event: string;
  label: string;
  vars: Array<{ name: string; description: string; sample: string }>;
  defaults: { subject: string; body: string; sms?: string } | null;
  template: { subject: string; body: string; sms: string | null; updatedAt: string } | null;
}
interface Preview { subject: string; body: string; sms: string; smsBytes: number; smsType: "SMS" | "LMS" }

const card: React.CSSProperties = {
  background: "var(--color-bg)", borderRadius: 8, padding: 20, marginBottom: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 13, color: "var(--color-text-soft)" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", fontSize: 14 };
const input: React.CSSProperties = { padding: 8, border: "1px solid var(--color-line-strong)", borderRadius: 6, fontSize: 14, width: "100%", boxSizing: "border-box" };
const mono: React.CSSProperties = { ...input, fontFamily: "ui-monospace, monospace", lineHeight: 1.6 };
const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
  borderRadius: 6, padding: 12, fontSize: 13.5, margin: "6px 0 14px", overflowWrap: "anywhere",
};

export default function NotificationTemplatesPage() {
  const t = useAdminT();
  const localeTag = useLocaleTag();
  const [items, setItems] = useState<Item[]>([]);
  const [event, setEvent] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ subject: "", body: "", sms: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const d = await fetch("/api/admin/notification-templates").then((r) => r.json()).catch(() => ({ items: [] }));
    const list: Item[] = d.items ?? [];
    setItems(list);
    setEvent((cur) => cur || list.find((i) => i.editable)?.event || "");
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // 고르면 **지금 나가는 문구**(고친 것이 있으면 그것, 없으면 기본 문구)를 채운다
  useEffect(() => {
    if (!event) return;
    setPreview(null);
    setMessage(null);
    void fetch(`/api/admin/notification-templates/${encodeURIComponent(event)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Detail | null) => {
        setDetail(d);
        const src = d?.template ?? d?.defaults;
        setForm({ subject: src?.subject ?? "", body: src?.body ?? "", sms: src?.sms ?? "" });
      });
  }, [event]);

  const body = () => JSON.stringify({ subject: form.subject, body: form.body, sms: form.sms });
  const fail = async (r: Response) => {
    const d = await r.json().catch(() => ({}));
    setMessage({ text: `${t("common.failPrefix")}${(d as { message?: string }).message ?? r.status}`, ok: false });
  };

  async function runPreview() {
    setBusy(true);
    const r = await fetch(`/api/admin/notification-templates/${encodeURIComponent(event)}/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: body(),
    });
    setBusy(false);
    if (!r.ok) { setPreview(null); await fail(r); return; }
    setMessage(null);
    setPreview(await r.json());
  }

  async function save() {
    setBusy(true);
    const r = await fetch(`/api/admin/notification-templates/${encodeURIComponent(event)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: body(),
    });
    setBusy(false);
    if (!r.ok) { await fail(r); return; }
    setMessage({ text: t("noti.saved"), ok: true });
    void reload();
  }

  async function reset() {
    setBusy(true);
    const r = await fetch(`/api/admin/notification-templates/${encodeURIComponent(event)}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) { await fail(r); return; }
    const d = detail?.defaults;
    setForm({ subject: d?.subject ?? "", body: d?.body ?? "", sms: d?.sms ?? "" });
    setPreview(null);
    setMessage({ text: t("noti.resetDone"), ok: true });
    void reload();
  }

  function loadDefaults() {
    const d = detail?.defaults;
    if (d) setForm({ subject: d.subject, body: d.body, sms: d.sms ?? "" });
    setPreview(null);
  }

  const current = items.find((i) => i.event === event);

  return (
    <div>
      <h1 style={{ margin: "0 0 6px" }}>{t("noti.title")}</h1>
      <p style={{ margin: "0 0 18px", color: "var(--color-text-soft)", fontSize: 14 }}>{t("noti.desc")}</p>

      <section style={card}>
        <div style={{ overflowX: "auto" }}>
          <table className="brick-x-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>{t("noti.colEvent")}</th>
              <th style={th}>{t("noti.colState")}</th>
              <th style={th}>{t("noti.colUpdated")}</th>
            </tr></thead>
            <tbody>
              {items.length === 0 && (
                <tr><td style={td} colSpan={3}>{t("noti.empty")}</td></tr>
              )}
              {items.map((i) => (
                <tr key={i.event} aria-selected={i.event === event}>
                  <td style={td} data-label={t("noti.colEvent")}>
                    {i.editable ? (
                      <button type="button" className="btn-link" onClick={() => setEvent(i.event)}
                        aria-current={i.event === event ? "true" : undefined}
                        style={{ fontWeight: i.event === event ? 700 : 400 }}>
                        {i.label}
                      </button>
                    ) : i.label}
                  </td>
                  <td style={td} data-label={t("noti.colState")}>
                    {!i.editable ? t("noti.notEditable") : i.customized ? t("noti.customized") : t("noti.default")}
                  </td>
                  <td style={td} data-label={t("noti.colUpdated")}>
                    {i.updatedAt ? new Date(i.updatedAt).toLocaleString(localeTag) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && current?.editable && (
        <section style={card}>
          <h2 className="brick-card-title">{detail.label}</h2>
          <p style={{ fontSize: 13, color: "var(--color-muted)", marginTop: 0 }}>
            {current.customized ? t("noti.stateCustom") : t("noti.stateDefault")}
          </p>

          <details style={{ marginBottom: 14 }}>
            <summary style={{ cursor: "pointer", fontSize: 13.5 }}>{t("noti.vars")}</summary>
            <ul style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.8 }}>
              {detail.vars.map((v) => (
                <li key={v.name}><code>{`#{${v.name}}`}</code> — {v.description}</li>
              ))}
            </ul>
          </details>

          <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("noti.subject")}
            <input style={input} name="subject" value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("noti.body")}
            <textarea style={{ ...mono, minHeight: 260 }} name="body" value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>{t("noti.sms")}
            <textarea style={{ ...mono, minHeight: 90 }} name="sms" value={form.sms} placeholder={t("noti.smsPh")}
              onChange={(e) => setForm({ ...form, sms: e.target.value })} />
            <span style={{ display: "block", color: "var(--color-muted)", fontSize: 12.5 }}>{t("noti.smsHint")}</span>
          </label>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button className="btn-primary" disabled={busy || !form.subject.trim() || !form.body.trim()} onClick={() => void save()}>
              {t("noti.save")}
            </button>
            <button type="button" className="btn-link" disabled={busy} onClick={() => void runPreview()}>{t("noti.preview")}</button>
            <button type="button" className="btn-link" disabled={busy} onClick={loadDefaults}>{t("noti.loadDefaults")}</button>
            {current.customized && (
              <button type="button" className="btn-link" disabled={busy} onClick={() => void reset()}>{t("noti.reset")}</button>
            )}
          </div>
          {message && (
            <p role={message.ok ? "status" : "alert"}
              style={{ fontSize: 13, color: message.ok ? "var(--color-success)" : "var(--color-danger)" }}>{message.text}</p>
          )}

          {preview && (
            <div style={{ marginTop: 18 }} aria-live="polite">
              <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>{t("noti.previewTitle")}</h3>
              <div style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("noti.subject")}</div>
              <div style={pre}>{preview.subject}</div>
              <div style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("noti.body")}</div>
              <div style={pre}>{preview.body}</div>
              <div style={{ fontSize: 13, color: "var(--color-muted)" }}>
                {t("noti.smsPreview", { type: preview.smsType, bytes: String(preview.smsBytes) })}
              </div>
              <div style={pre}>{preview.sms}</div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
