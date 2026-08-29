"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface MediaRow {
  id: string; url: string; fileName: string; contentType: string; size: string; createdAt: string;
}

export default function AdminMediaPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ items: MediaRow[]; total: number }>({ items: [], total: 0 });
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/media").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/media/upload", { method: "POST", body: fd });
    setMessage(res.ok ? t("media.done") : `${t("common.failPrefix")}${(await res.json()).message}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  async function remove(id: string) {
    if (!confirm(t("media.confirmDelete"))) return;
    await fetch(`/api/media/${id}`, { method: "DELETE" });
    reload();
  }

  const isImage = (t: string) => t.startsWith("image/");
  const humanSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  return (
    <div>
      <h1>{t("media.title")} <span style={{ color: "#999", fontSize: 16 }}>{t("media.countN", { n: data.total })}</span></h1>
      <form onSubmit={upload} style={{ background: "#fff", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>{t("media.upload")}</strong>{" "}
        <input ref={fileRef} type="file" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("media.uploadBtn")}</button>
        <span style={{ marginLeft: 8, color: "#888", fontSize: 13 }}>
          {t("media.hint")}
        </span>
      </form>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 16 }}>
        {data.items.map((f) => (
          <div key={f.id} style={{ background: "#fff", borderRadius: 8, padding: 12, fontSize: 13 }}>
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "#f6f6f9", borderRadius: 4, overflow: "hidden" }}>
              {isImage(f.contentType)
                ? <img src={f.url} alt={f.fileName} style={{ maxWidth: "100%", maxHeight: 100 }} />
                : <span style={{ fontSize: 32 }}>📄</span>}
            </div>
            <div style={{ marginTop: 8, wordBreak: "break-all" }}>{f.fileName}</div>
            <div style={{ color: "#999" }}>{humanSize(Number(f.size))}</div>
            <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(f.url)} style={{ cursor: "pointer" }}>{t("media.copyUrl")}</button>
              <button onClick={() => remove(f.id)} style={{ cursor: "pointer", color: "crimson" }}>{t("common.delete")}</button>
            </div>
          </div>
        ))}
        {!data.items.length && <p style={{ color: "#999" }}>{t("media.empty")}</p>}
      </div>
    </div>
  );
}
