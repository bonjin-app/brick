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
  /** 미리보기 — 팔레트 견본만으로는 레이아웃을 알 수 없다. 내 사이트 내용으로 그려 본다 */
  const [preview, setPreview] = useState<{ name: string; html: string; width: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState("");

  const reload = useCallback(() => {
    fetch("/api/themes").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function activate(name: string) {
    const res = await fetch(`/api/themes/${name}/activate`, { method: "POST" });
    setMessage(res.ok ? t("themes.applied", { name }) : `${t("common.failPrefix")}${await res.text()}`);
    reload();
  }

  async function openPreview(name: string, width = 0) {
    setPreviewBusy(name);
    try {
      const res = await fetch(`/api/admin/render/preview?path=&theme=${encodeURIComponent(name)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(`${t("common.failPrefix")}${body.message ?? res.status}`); return; }
      setPreview({ name, html: String(body.html ?? ""), width: width || 0 });
    } finally {
      setPreviewBusy("");
    }
  }

  // 미리보기가 열려 있으면 Esc 로 닫는다 (모달의 기본기)
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

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
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {data.active === th.name ? (
                <span style={{ color: "var(--color-success)" }}>{t("themes.inUse")}</span>
              ) : (
                <button onClick={() => activate(th.name)} style={{ cursor: "pointer" }}>{t("common.apply")}</button>
              )}
              <button onClick={() => openPreview(th.name)} disabled={previewBusy === th.name} style={{ cursor: "pointer" }}>
                {previewBusy === th.name ? t("themes.previewLoading") : t("themes.preview")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("themes.previewOf", { name: preview.name })}
          onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
          style={{
            position: "fixed", inset: 0, zIndex: 60, background: "rgba(10,10,14,.55)",
            display: "flex", flexDirection: "column", padding: "min(3vh, 24px) min(3vw, 24px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, color: "#fff", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>{t("themes.previewOf", { name: preview.name })}</strong>
            {/* 폭 전환 — 테마의 반응형을 여기서 바로 본다 */}
            {[0, 768, 375].map((w) => (
              <button
                key={w}
                onClick={() => setPreview({ ...preview, width: w })}
                aria-pressed={preview.width === w}
                style={{ cursor: "pointer", fontWeight: preview.width === w ? 700 : 400 }}
              >
                {w === 0 ? t("themes.previewFull") : `${w}px`}
              </button>
            ))}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {data.active !== preview.name ? (
                <button onClick={() => { activate(preview.name); setPreview(null); }} style={{ cursor: "pointer" }}>
                  {t("common.apply")}
                </button>
              ) : null}
              <button onClick={() => setPreview(null)} style={{ cursor: "pointer" }}>{t("common.close")}</button>
            </span>
          </div>
          {/*
            srcDoc 으로 넣는다 — 미리보기 HTML 은 관리자 세션으로 받은 우리 렌더 결과이고,
            iframe 이라 그 안의 CSS 가 관리 화면에 새지 않는다(테마 CSS 는 전역 선택자를 쓴다).
          */}
          <iframe
            title={t("themes.previewOf", { name: preview.name })}
            srcDoc={preview.html}
            style={{
              flex: 1, width: preview.width ? preview.width : "100%", margin: "0 auto",
              maxWidth: "100%", border: 0, borderRadius: 6, background: "#fff",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
