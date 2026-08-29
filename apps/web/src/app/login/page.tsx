"use client";

import { useEffect, useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";
import { useT } from "../../lib/i18n";

/** 공개 로그인 — 로그인 후 홈으로 이동한다 (관리자 로그인은 /admin/login) */
export default function LoginPage() {
  const t = useT();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 소셜 로그인이 실패하면 콜백이 /login?error=... 로 되돌린다
  useEffect(() => {
    const message = new URLSearchParams(window.location.search).get("error");
    if (message) setError(message);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) window.location.href = "/";
    else {
      setError((await res.json()).message ?? t("login.fail"));
      setBusy(false);
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 380, margin: "100px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>{t("login.title")}</h1>
      <form onSubmit={submit}>
        <label>{t("login.email")}
          <input style={input} type="email" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>{t("login.password")}
          <input style={input} type="password" required value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <button disabled={busy} style={{ width: "100%", padding: 12, marginTop: 24, cursor: "pointer" }}>
          {busy ? t("login.busy") : t("login.title")}
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
        {t("login.noAccount")} <a href="/register">{t("login.register")}</a>
        {" · "}
        <a href="/forgot-password">{t("login.forgot")}</a>
      </p>
    </main>
  );
}
