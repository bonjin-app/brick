"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PluginRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  isActive: boolean;
}

export default function AdminPluginsPage() {
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/plugins").then((r) => r.json()).then(setPlugins);
  }, []);
  useEffect(reload, [reload]);

  async function toggle(p: PluginRow) {
    const res = await fetch(`/api/plugins/${p.name}/${p.isActive ? "deactivate" : "activate"}`, { method: "POST" });
    setMessage(res.ok ? `"${p.displayName}" ${p.isActive ? "비활성화" : "활성화"} 완료` : `실패: ${await res.text()}`);
    reload();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/plugins/upload", { method: "POST", body: fd });
    setMessage(res.ok ? "플러그인 설치 완료 — 활성화 버튼을 눌러 사용을 시작하세요" : `설치 실패: ${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <h1>플러그인</h1>
      <form onSubmit={upload} style={{ background: "#fff", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>플러그인 업로드</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>설치</button>
        <span style={{ marginLeft: 8, color: "#888", fontSize: 13 }}>brick.plugin.json을 포함한 .zip</span>
      </form>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <table style={{ width: "100%", background: "#fff", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th style={{ padding: 12 }}>이름</th><th>버전</th><th>설명</th><th>상태</th><th></th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr key={p.name} style={{ borderBottom: "1px solid #f3f3f3" }}>
              <td style={{ padding: 12 }}><strong>{p.displayName}</strong><br /><span style={{ color: "#999", fontSize: 12 }}>{p.name}</span></td>
              <td>{p.version}</td>
              <td style={{ color: "#666" }}>{p.description}</td>
              <td>{p.isActive ? "🟢 활성" : "⚪ 비활성"}</td>
              <td><button onClick={() => toggle(p)} style={{ cursor: "pointer" }}>{p.isActive ? "비활성화" : "활성화"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
