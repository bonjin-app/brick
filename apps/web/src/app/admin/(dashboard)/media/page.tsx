"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface MediaRow {
  id: string; url: string; thumbUrl?: string; fileName: string; contentType: string; size: string; createdAt: string;
  width?: number | null; height?: number | null;
}

export default function AdminMediaPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ items: MediaRow[]; total: number }>({ items: [], total: 0 });
  // 성공/실패를 함께 들고 다닌다 — 전에는 색이 하나뿐이어서 실패도 초록으로 떴다
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
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
    const body = await res.json().catch(() => ({}));
    // 이미지를 줄였다면 얼마나 줄었는지 보여준다 — 운영자가 최적화가 켜져 있는지 알 수 있다
    const saved = res.ok && body.originalSize && body.size && body.originalSize > body.size * 1.05
      ? ` (${humanSize(body.originalSize)} → ${humanSize(body.size)}${body.width ? `, ${body.width}×${body.height}` : ""})`
      : "";
    setMessage(res.ok
      ? { text: `${t("media.done")}${saved}`, ok: true }
      : { text: `${t("common.failPrefix")}${body.message ?? res.status}`, ok: false });
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  async function remove(id: string) {
    if (!confirm(t("media.confirmDelete"))) return;
    await fetch(`/api/media/${id}`, { method: "DELETE" });
    reload();
  }

  const isImage = (t: string) => t.startsWith("image/");
  return (
    <div>
      <h1>{t("media.title")} <span style={{ color: "var(--color-muted)", fontSize: 16 }}>{t("media.countN", { n: data.total })}</span></h1>
      <form onSubmit={upload} style={{ background: "var(--color-bg)", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>{t("media.upload")}</strong>{" "}
        <input ref={fileRef} type="file" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("media.uploadBtn")}</button>
        <span style={{ marginLeft: 8, color: "var(--color-muted)", fontSize: 13 }}>
          {t("media.hint")}
        </span>
      </form>
      {message && (
        <p role={message.ok ? undefined : "alert"}
           style={{ color: message.ok ? "var(--color-success)" : "var(--color-danger)" }}>{message.text}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 16 }}>
        {data.items.map((f) => (
          <div key={f.id} style={{ background: "var(--color-bg)", borderRadius: 8, padding: 12, fontSize: 13 }}>
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--color-bg-soft)", borderRadius: 4, overflow: "hidden" }}>
              {isImage(f.contentType)
                ? <img src={f.thumbUrl ?? f.url} alt={f.fileName} loading="lazy" decoding="async"
                       width={160} height={100} style={{ maxWidth: "100%", maxHeight: 100, objectFit: "contain" }} />
                : <span style={{ fontSize: 32 }}>📄</span>}
            </div>
            <div style={{ marginTop: 8, wordBreak: "break-all" }}>{f.fileName}</div>
            <div style={{ color: "var(--color-muted)" }}>{humanSize(Number(f.size))}</div>
            <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(f.url)} style={{ cursor: "pointer" }}>{t("media.copyUrl")}</button>
              <button onClick={() => remove(f.id)} style={{ cursor: "pointer", color: "var(--color-danger)" }}>{t("common.delete")}</button>
            </div>
          </div>
        ))}
        {!data.items.length && <p style={{ color: "var(--color-muted)" }}>{t("media.empty")}</p>}
      </div>
    </div>
  );
}

/** 사람이 읽는 크기 — 컴포넌트 밖에 두어 업로드 핸들러에서도 쓴다 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
