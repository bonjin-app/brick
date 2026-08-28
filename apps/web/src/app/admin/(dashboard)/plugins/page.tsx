"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
    setMessage(res.ok ? `"${p.displayName}" ${p.isActive ? "비활성화" : "활성화"} 완료` : `실패: ${await res.text()}`);
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
    if ((data.errors ?? []).length) setMessage(`일부 확인 실패: ${data.errors.join(" · ")}`);
    setChecking(false);
  }

  async function applyUpdate(u: AvailableUpdate) {
    const res = await fetch(`/api/admin/updates/${u.kind}/${u.name}/apply`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok
      ? `"${u.displayName}" ${data.from} → ${data.to} 업데이트 완료`
      : `업데이트 실패: ${data.message ?? res.status}`);
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
    setMessage(res.ok ? "플러그인 설치 완료 — 활성화 버튼을 눌러 사용을 시작하세요" : `설치 실패: ${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>플러그인</h1>
        <button onClick={() => void checkUpdates()} disabled={checking}
          style={{ cursor: "pointer", padding: "8px 16px" }}>
          {checking ? "확인 중…" : "업데이트 확인"}
        </button>
      </div>

      {updates !== null && (
        <div style={{ background: "#fff", padding: 16, borderRadius: 8, marginBottom: 16 }}>
          {updates.length === 0 ? (
            <p style={{ margin: 0, color: "#666" }}>모든 확장이 최신입니다.</p>
          ) : updates.map((u) => (
            <div key={`${u.kind}/${u.name}`}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #f3f3f3" }}>
              <div style={{ flex: 1 }}>
                <strong>{u.displayName}</strong>{" "}
                <span style={{ color: "#888", fontSize: 13 }}>{u.currentVersion} → {u.nextVersion}</span>
                {u.notes && <div style={{ fontSize: 13, color: "#666" }}>{u.notes}</div>}
              </div>
              {/* 서명 검증을 통과해야만 설치된다 — 실패하면 이유가 메시지로 나온다 */}
              <button onClick={() => void applyUpdate(u)}
                style={{ cursor: "pointer", padding: "6px 14px", fontWeight: 600 }}>업데이트</button>
            </div>
          ))}
        </div>
      )}
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
