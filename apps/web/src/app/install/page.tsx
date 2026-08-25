"use client";

import { useState } from "react";

/** 설치 마법사 — 사용자가 입력하는 것은 사이트명/관리자 계정뿐 */
export default function InstallPage() {
  const [form, setForm] = useState({ siteName: "", adminEmail: "", adminPassword: "" });
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    const res = await fetch("/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setState("done");
      setTimeout(() => (window.location.href = "/"), 800);
    } else {
      setState("error");
      setMessage(await res.text());
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 420, margin: "80px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>BRICK</h1>
      <p style={{ textAlign: "center", color: "#666" }}>설치 마법사</p>
      <form onSubmit={submit}>
        <label>
          사이트 이름
          <input style={input} required value={form.siteName}
            onChange={(e) => setForm({ ...form, siteName: e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          관리자 이메일
          <input style={input} type="email" required value={form.adminEmail}
            onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          관리자 비밀번호 (8자 이상)
          <input style={input} type="password" minLength={8} required value={form.adminPassword}
            onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} />
        </label>
        <button disabled={state === "busy"} style={{ width: "100%", padding: 12, marginTop: 24, cursor: "pointer" }}>
          {state === "busy" ? "설치 중..." : "Install"}
        </button>
      </form>
      {state === "done" && <p>설치 완료! 홈으로 이동합니다…</p>}
      {state === "error" && <p style={{ color: "crimson" }}>{message}</p>}
    </main>
  );
}
