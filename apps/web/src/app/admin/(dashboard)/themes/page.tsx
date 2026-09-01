"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface ThemeRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
}

export default function AdminThemesPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ themes: ThemeRow[]; active: string }>({ themes: [], active: "" });
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/themes").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function activate(name: string) {
    const res = await fetch(`/api/themes/${name}/activate`, { method: "POST" });
    setMessage(res.ok ? t("themes.applied", { name }) : `${t("common.failPrefix")}${await res.text()}`);
    reload();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/themes/upload", { method: "POST", body: fd });
    setMessage(res.ok ? t("themes.installDone") : `${t("themes.installFailPrefix")}${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <h1>{t("themes.title")}</h1>
      <form onSubmit={upload} style={{ background: "var(--color-bg)", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>{t("themes.upload")}</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("common.install")}</button>
        <span style={{ marginLeft: 8, color: "var(--color-muted)", fontSize: 13 }}>{t("themes.hint")}</span>
      </form>
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {data.themes.map((th) => (
          <div key={th.name} style={{ background: "var(--color-bg)", borderRadius: 8, padding: 20, width: 240 }}>
            <strong>{th.displayName}</strong> <span style={{ color: "var(--color-muted)", fontSize: 12 }}>v{th.version}</span>
            <p style={{ color: "var(--color-text-soft)", fontSize: 13, minHeight: 40 }}>{th.description}</p>
            {data.active === th.name ? (
              <span style={{ color: "var(--color-success)" }}>{t("themes.inUse")}</span>
            ) : (
              <button onClick={() => activate(th.name)} style={{ cursor: "pointer" }}>{t("common.apply")}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
