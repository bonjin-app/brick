"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ThemeRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
}

export default function AdminThemesPage() {
  const [data, setData] = useState<{ themes: ThemeRow[]; active: string }>({ themes: [], active: "" });
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/themes").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function activate(name: string) {
    const res = await fetch(`/api/themes/${name}/activate`, { method: "POST" });
    setMessage(res.ok ? `"${name}" 테마 적용 완료` : `실패: ${await res.text()}`);
    reload();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/themes/upload", { method: "POST", body: fd });
    setMessage(res.ok ? "테마 설치 완료 — 적용 버튼으로 즉시 사용할 수 있습니다" : `설치 실패: ${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <h1>테마</h1>
      <form onSubmit={upload} style={{ background: "#fff", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>테마 업로드</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>설치</button>
        <span style={{ marginLeft: 8, color: "#888", fontSize: 13 }}>빌드 불필요 — 설치 즉시 적용 가능</span>
      </form>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {data.themes.map((t) => (
          <div key={t.name} style={{ background: "#fff", borderRadius: 8, padding: 20, width: 240 }}>
            <strong>{t.displayName}</strong> <span style={{ color: "#999", fontSize: 12 }}>v{t.version}</span>
            <p style={{ color: "#666", fontSize: 13, minHeight: 40 }}>{t.description}</p>
            {data.active === t.name ? (
              <span style={{ color: "#0a7" }}>✓ 사용 중</span>
            ) : (
              <button onClick={() => activate(t.name)} style={{ cursor: "pointer" }}>적용</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
