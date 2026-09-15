"use client";

import { useState } from "react";
import { useAdminT } from "../../../lib/i18n-admin";

export default function AdminLoginPage() {
  const t = useAdminT();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 2FA 가 켜진 계정은 세션 없이 200 + challengeToken 이 온다 (공개 로그인과 같다)
  const [challengeToken, setChallengeToken] = useState("");
  const [code, setCode] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.twoFactorRequired) {
      setChallengeToken(String(data.challengeToken ?? ""));
      setBusy(false);
      return;
    }
    if (res.ok) window.location.href = "/admin";
    else {
      setError(t("adminLogin.fail"));
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login/2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code }),
    });
    if (res.ok) { window.location.href = "/admin"; return; }
    setError((await res.json().catch(() => ({}))).message ?? t("adminLogin.twoFactorFail"));
    setBusy(false);
  }

  /**
   * 색은 사이트 테마 토큰을 쓴다 — 관리 화면 안쪽은 라이트 고정이지만
   * 로그인은 그 바깥이고, 여기서 색을 정하지 않으면 다크 손님에게
   * 어두운 배경 + 흰 입력칸 + 밝은 글자가 겹쳐 아무것도 안 보인다.
   */
  const input = {
    width: "100%", padding: "11px 13px", marginTop: 6, boxSizing: "border-box" as const,
    border: "1px solid var(--color-line-strong)", borderRadius: "var(--radius)",
    background: "var(--color-bg)", color: "var(--color-text)", font: "inherit", fontSize: 15,
  };
  return (
    <main style={{
      maxWidth: 400, margin: "0 auto", padding: "14vh 20px 40px",
      minHeight: "100dvh", background: "var(--color-bg-soft)", color: "var(--color-text)",
    }}>
      <h1 style={{
        textAlign: "center", margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.6px",
      }}>BRICK</h1>
      <p style={{ textAlign: "center", color: "var(--color-muted)", fontSize: 14, marginTop: 8 }}>
        {t("adminLogin.subtitle")}
      </p>
      {challengeToken ? (
        <form onSubmit={submitCode}>
          <p style={{ color: "var(--color-muted)", fontSize: 14, marginTop: 20 }}>
            {t("adminLogin.twoFactorDesc")}
          </p>
          <label style={{ display: "block", marginTop: 16 }}>
            {t("adminLogin.twoFactorCode")}
            {/* 복구 코드도 같은 칸으로 받는다 — 6자리로 막으면 휴대폰을 잃었을 때 못 들어온다 */}
            <input style={input} required autoFocus name="one-time-code"
              autoComplete="one-time-code" inputMode="text"
              value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button disabled={busy} style={{
            width: "100%", padding: 13, marginTop: 24, cursor: "pointer",
            border: 0, borderRadius: "var(--radius)", font: "inherit", fontSize: 15, fontWeight: 700,
            background: "var(--color-primary)", color: "var(--color-on-primary)",
          }}>
            {busy ? t("adminLogin.busy") : t("adminLogin.twoFactorSubmit")}
          </button>
          {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 14 }}>{error}</p>}
        </form>
      ) : (
      <form onSubmit={submit}>
        <label>
          {t("common.email")}
          <input style={input} type="email" required name="email" autoComplete="username"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          {t("common.password")}
          <input style={input} type="password" required name="password" autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <button disabled={busy} style={{
          width: "100%", padding: 13, marginTop: 24, cursor: "pointer",
          border: 0, borderRadius: "var(--radius)", font: "inherit", fontSize: 15, fontWeight: 700,
          background: "var(--color-primary)", color: "var(--color-on-primary)",
        }}>
          {busy ? t("adminLogin.busy") : t("adminLogin.submit")}
        </button>
      </form>
      )}
      {!challengeToken && error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 14 }}>{error}</p>}
      <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
        <a href="/forgot-password">{t("adminLogin.forgot")}</a>
      </p>
    </main>
  );
}
