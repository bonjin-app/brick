"use client";

import { useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";

/** 공개 회원가입. site.registration_open이 false면 서버가 403으로 거부한다 */
export default function RegisterPage() {
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setError("");
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setState("done");
      setTimeout(() => (window.location.href = "/login"), 1200);
    } else {
      setError((await res.json()).message ?? "가입에 실패했습니다.");
      setState("idle");
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 380, margin: "80px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>회원가입</h1>
      {state === "done" ? (
        <p style={{ textAlign: "center", color: "#0a7" }}>가입 완료! 로그인 페이지로 이동합니다…</p>
      ) : (
        <form onSubmit={submit}>
          <label>이름
            <input style={input} required minLength={2} maxLength={30} value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label style={{ display: "block", marginTop: 16 }}>이메일
            <input style={input} type="email" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={{ display: "block", marginTop: 16 }}>비밀번호 (8자 이상)
            <input style={input} type="password" required minLength={8} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <button disabled={state === "busy"} style={{ width: "100%", padding: 12, marginTop: 24, cursor: "pointer" }}>
            {state === "busy" ? "처리 중…" : "가입하기"}
          </button>
        </form>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
        이미 계정이 있나요? <a href="/login">로그인</a>
      </p>
    </main>
  );
}
