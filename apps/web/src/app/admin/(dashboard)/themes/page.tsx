"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface ThemeRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  tokens?: Record<string, string>;
}

/** 매니페스트 토큰에서 팔레트 견본 — 적용하기 전에 인상을 고를 수 있게 */
const SWATCH_KEYS = ["color-bg", "color-bg-soft", "color-primary", "color-text"];
function Swatches({ tokens, prefix, label }: { tokens: Record<string, string>; prefix: string; label: string }) {
  const colors = SWATCH_KEYS.map((k) => tokens[prefix + k]).filter(Boolean);
  if (colors.length < 2) return null;
  return (
    <span role="img" aria-label={label} title={label} style={{ display: "inline-flex", border: "1px solid var(--color-line)", borderRadius: 4, overflow: "hidden" }}>
      {colors.map((c, i) => <span key={i} style={{ width: 22, height: 16, background: c }} />)}
    </span>
  );
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
      <form onSubmit={upload} className="brick-card" style={{ marginTop: 0, marginBottom: 20 }}>
        <strong>{t("themes.upload")}</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("common.install")}</button>
        <span style={{ marginLeft: 8, color: "var(--color-muted)", fontSize: 13 }}>{t("themes.hint")}</span>
      </form>
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {data.themes.map((th) => (
          <div key={th.name} className="brick-card w-full sm:w-[280px]" style={{ marginTop: 0 }}>
            {th.tokens ? (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <Swatches tokens={th.tokens} prefix="" label={t("themes.paletteLight")} />
                <Swatches tokens={th.tokens} prefix="dark-" label={t("themes.paletteDark")} />
              </div>
            ) : null}
            <strong style={th.tokens?.["font-display"] ? { fontFamily: th.tokens["font-display"], fontSize: 17 } : undefined}>{th.displayName}</strong>{" "}
            <span style={{ color: "var(--color-muted)", fontSize: 12 }}>v{th.version}</span>
            <p style={{ color: "var(--color-text-soft)", fontSize: 13, minHeight: 40, margin: "6px 0 12px" }}>{th.description}</p>
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
