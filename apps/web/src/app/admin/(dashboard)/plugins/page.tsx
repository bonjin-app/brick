"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface PluginRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  isActive: boolean;
}

interface AvailableUpdate {
  kind: string; name: string; displayName: string;
  currentVersion: string; nextVersion: string; notes: string | null;
}

export default function AdminPluginsPage() {
  const t = useAdminT();
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [message, setMessage] = useState("");
  const [updates, setUpdates] = useState<AvailableUpdate[] | null>(null);
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/plugins").then((r) => r.json()).then(setPlugins);
  }, []);
  useEffect(reload, [reload]);

  async function toggle(p: PluginRow) {
    const res = await fetch(`/api/plugins/${p.name}/${p.isActive ? "deactivate" : "activate"}`, { method: "POST" });
    setMessage(res.ok ? t("plugins.toggleDone", { name: p.displayName, action: p.isActive ? t("plugins.deactivate") : t("plugins.activate") }) : `${t("common.failPrefix")}${await res.text()}`);
    reload();
  }

  /**
   * 업데이트 확인 — 자동으로 적용하지 않는다.
   * 무엇이 바뀌는지 보여주고 운영자가 누른다.
   */
  async function checkUpdates() {
    setChecking(true);
    setMessage("");
    const res = await fetch("/api/admin/updates");
    const data = await res.json().catch(() => ({ items: [], errors: [] }));
    setUpdates(data.items ?? []);
    if ((data.errors ?? []).length) setMessage(`${t("plugins.someFailed")}${data.errors.join(" · ")}`);
    setChecking(false);
  }

  async function applyUpdate(u: AvailableUpdate) {
    const res = await fetch(`/api/admin/updates/${u.kind}/${u.name}/apply`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok
      ? t("plugins.updateDone", { name: u.displayName, from: data.from, to: data.to })
      : `${t("plugins.updateFailPrefix")}${data.message ?? res.status}`);
    setUpdates(null);
    reload();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/plugins/upload", { method: "POST", body: fd });
    setMessage(res.ok ? t("plugins.installDone") : `${t("plugins.installFailPrefix")}${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>{t("plugins.title")}</h1>
        <button onClick={() => void checkUpdates()} disabled={checking}
          style={{ cursor: "pointer", padding: "8px 16px" }}>
          {checking ? t("plugins.checking") : t("plugins.checkUpdates")}
        </button>
      </div>

      {updates !== null && (
        <div style={{ background: "var(--color-bg)", padding: 16, borderRadius: 8, marginBottom: 16 }}>
          {updates.length === 0 ? (
            <p style={{ margin: 0, color: "var(--color-text-soft)" }}>{t("plugins.upToDate")}</p>
          ) : updates.map((u) => (
            <div key={`${u.kind}/${u.name}`}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--color-line)" }}>
              <div style={{ flex: 1 }}>
                <strong>{u.displayName}</strong>{" "}
                <span style={{ color: "var(--color-muted)", fontSize: 13 }}>{u.currentVersion} → {u.nextVersion}</span>
                {u.notes && <div style={{ fontSize: 13, color: "var(--color-text-soft)" }}>{u.notes}</div>}
              </div>
              {/* 서명 검증을 통과해야만 설치된다 — 실패하면 이유가 메시지로 나온다 */}
              <button onClick={() => void applyUpdate(u)}
                style={{ cursor: "pointer", padding: "6px 14px", fontWeight: 600 }}>{t("plugins.updateBtn")}</button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={upload} style={{ background: "var(--color-bg)", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>{t("plugins.upload")}</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("common.install")}</button>
        <span style={{ marginLeft: 8, color: "var(--color-muted)", fontSize: 13 }}>{t("plugins.uploadHint")}</span>
      </form>
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}
      <table style={{ width: "100%", background: "var(--color-bg)", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
            <th style={{ padding: 12 }}>{t("common.name")}</th><th>{t("common.version")}</th><th>{t("common.description")}</th><th>{t("common.status")}</th><th></th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr key={p.name} style={{ borderBottom: "1px solid var(--color-line)" }}>
              <td style={{ padding: 12 }}><strong>{p.displayName}</strong><br /><span style={{ color: "var(--color-muted)", fontSize: 12 }}>{p.name}</span></td>
              <td>{p.version}</td>
              <td style={{ color: "var(--color-text-soft)" }}>{p.description}</td>
              <td>{p.isActive ? t("plugins.active") : t("plugins.inactive")}</td>
              <td><button onClick={() => toggle(p)} style={{ cursor: "pointer" }}>{p.isActive ? t("plugins.deactivate") : t("plugins.activate")}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
