"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface AuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  ip: string | null;
  createdAt: string;
}

/** 감사 로그 — 누가 언제 무엇을 바꿨는가. 라벨은 카탈로그 키 audit.a.<action> */
const KNOWN_ACTIONS = [
  "page.create", "page.update", "page.delete",
  "user.register", "user.role_change", "user.status_change",
  "plugin.install", "plugin.activate", "plugin.deactivate",
  "theme.install", "theme.activate",
  "settings.update", "menu.update",
  "auth.password_reset_requested", "auth.password_reset_completed",
] as const;

/** 주의가 필요한 동작은 눈에 띄게 */
const SENSITIVE = new Set(["user.role_change", "user.status_change", "plugin.install", "theme.install"]);

export default function AdminAuditPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ items: AuditRow[]; total: number }>({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");

  const reload = useCallback(() => {
    const q = new URLSearchParams({ page: String(page), ...(filter ? { action: filter } : {}) });
    fetch(`/api/audit?${q}`).then((r) => r.json()).then(setData);
  }, [page, filter]);
  useEffect(reload, [reload]);

  return (
    <div>
      <h1>{t("audit.title")} <span style={{ color: "var(--color-muted)", fontSize: 15 }}>{t("audit.countN", { n: data.total })}</span></h1>
      <p style={{ color: "var(--color-text-soft)", fontSize: 14 }}>
        {t("audit.desc")}
      </p>
      <select aria-label={t("audit.filterLabel")} value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}
        style={{ padding: 8, marginBottom: 16 }}>
        <option value="">{t("audit.allActions")}</option>
        {KNOWN_ACTIONS.map((v) => <option key={v} value={v}>{t(`audit.a.${v}` as never)}</option>)}
      </select>

      <div style={{ overflowX: "auto", background: "var(--color-bg)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
              <th style={{ padding: 12 }}>{t("audit.colTime")}</th><th>{t("audit.colActor")}</th><th>{t("audit.colAction")}</th><th>{t("audit.colTarget")}</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid var(--color-line)" }}>
                <td style={{ padding: 12, whiteSpace: "nowrap", color: "var(--color-text-soft)" }}>
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td>{r.actorEmail ?? <span style={{ color: "var(--color-muted)" }}>{t("audit.system")}</span>}</td>
                <td style={SENSITIVE.has(r.action) ? { color: "var(--color-danger)", fontWeight: 600 } : undefined}>
                  {(KNOWN_ACTIONS as readonly string[]).includes(r.action) ? t(`audit.a.${r.action}` as never) : r.action}
                </td>
                <td style={{ color: "var(--color-text-soft)" }}>{r.summary ?? r.targetId ?? "-"}</td>
                <td style={{ color: "var(--color-muted)", fontSize: 13 }}>{r.ip ?? "-"}</td>
              </tr>
            ))}
            {!data.items.length && (
              <tr><td colSpan={5} style={{ padding: 24, color: "var(--color-muted)" }}>{t("audit.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data.total > data.items.length && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ cursor: "pointer" }}>{t("common.prev")}</button>
          <span style={{ fontSize: 13, color: "var(--color-text-soft)" }}>{t("common.pageN", { n: page })}</span>
          <button disabled={!data.items.length} onClick={() => setPage(page + 1)} style={{ cursor: "pointer" }}>{t("common.next")}</button>
        </div>
      )}
    </div>
  );
}
