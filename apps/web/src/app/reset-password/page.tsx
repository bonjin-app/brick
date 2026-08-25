"use client";

import { useEffect, useState } from "react";

type State = "checking" | "invalid" | "ready" | "done";

/** 비밀번호 재설정 — 메일 링크로 진입 (?token=...) */
export default function ResetPasswordPage() {
  const [state, setState] = useState<State>("checking");
  const [token, setToken] = useState("");
  const [form, setForm] = useState({ password: "", confirm: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    if (!t) {
      setState("invalid");
      return;
    }
    fetch(`/api/auth/password/verify?token=${encodeURIComponent(t)}`)
      .then((r) => r.json())
      .then((d) => setState(d.valid ? "ready" : "invalid"))
      .catch(() => setState("invalid"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirm) {
      setError("비밀번호가 서로 다릅니다.");
      return;
    }
    if (form.password.length < 8) {
      setError("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: form.password }),
    });
    if (res.ok) setState("done");
    else {
      setError((await res.json()).message ?? "재설정에 실패했습니다.");
      setBusy(false);
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 400, margin: "100px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>비밀번호 재설정</h1>

      {state === "checking" && <p style={{ textAlign: "center", color: "#666" }}>링크를 확인하는 중…</p>}

      {state === "invalid" && (
        <div style={{ background: "#fdf2f0", border: "1px solid #f3d0ca", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>이 링크는 만료되었거나 이미 사용되었습니다.</p>
          <p style={{ fontSize: 14 }}><a href="/forgot-password">재설정 링크를 다시 받기</a></p>
        </div>
      )}

      {state === "done" && (
        <div style={{ background: "#f2f8f4", border: "1px solid #cde8d6", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>비밀번호가 변경되었습니다.</p>
          <p style={{ color: "#666", fontSize: 14 }}>보안을 위해 기존 로그인 세션은 모두 해제되었습니다.</p>
          <p style={{ fontSize: 14 }}><a href="/login">새 비밀번호로 로그인</a></p>
        </div>
      )}

      {state === "ready" && (
        <form onSubmit={submit}>
          <label>
            새 비밀번호 (8자 이상)
            <input style={input} type="password" required minLength={8} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <label style={{ display: "block", marginTop: 16 }}>
            새 비밀번호 확인
            <input style={input} type="password" required value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </label>
          <button disabled={busy} style={{ width: "100%", padding: 12, marginTop: 20, cursor: "pointer" }}>
            {busy ? "변경 중…" : "비밀번호 변경"}
          </button>
          {error && <p style={{ color: "crimson" }}>{error}</p>}
        </form>
      )}
    </main>
  );
}
