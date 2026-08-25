"use client";

import { useCallback, useEffect, useState } from "react";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState("");

  const reload = useCallback(() => {
    fetch("/api/settings").then((r) => r.json()).then(setSettings);
  }, []);
  useEffect(reload, [reload]);

  async function save() {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "site.name": String(settings["site.name"] ?? ""),
        "site.description": String(settings["site.description"] ?? ""),
        "site.registration_open": settings["site.registration_open"] !== false,
      }),
    });
    setMessage(res.ok ? "저장되었습니다." : `실패: ${(await res.json()).message}`);
  }

  const input = { width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <div>
      <h1>사이트 설정</h1>
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, maxWidth: 520 }}>
        <label>사이트 이름
          <input style={input} value={String(settings["site.name"] ?? "")}
            onChange={(e) => setSettings({ ...settings, "site.name": e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>사이트 설명 (SEO 기본값)
          <textarea style={{ ...input, height: 70 }} value={String(settings["site.description"] ?? "")}
            onChange={(e) => setSettings({ ...settings, "site.description": e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          <input type="checkbox" checked={settings["site.registration_open"] !== false}
            onChange={(e) => setSettings({ ...settings, "site.registration_open": e.target.checked })} />
          {" "}회원가입 허용
        </label>
        <button onClick={save} style={{ cursor: "pointer", padding: "10px 24px", marginTop: 24, fontWeight: 700 }}>
          저장
        </button>
        {message && <p style={{ color: "#0a7" }}>{message}</p>}
      </div>
    </div>
  );
}
