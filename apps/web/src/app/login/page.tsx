"use client";

import { useEffect, useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";
import { AuthShell, authButton, authInput, authLabel } from "../../components/AuthShell";
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

  return (
    <AuthShell title={t("login.title")}>
      <form onSubmit={submit}>
        <label style={{ ...authLabel, marginTop: 0 }}>{t("login.email")}
          <input style={authInput} type="email" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label style={authLabel}>{t("login.password")}
          <input style={authInput} type="password" required value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <button disabled={busy} style={authButton}>
          {busy ? t("login.busy") : t("login.title")}
        </button>
      </form>
      {error && <p style={{ color: "#c0392b", fontSize: 14 }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 18, fontSize: 14, color: "#4b4b55" }}>
        {t("login.noAccount")} <a href="/register">{t("login.register")}</a>
        {" · "}
        <a href="/forgot-password">{t("login.forgot")}</a>
      </p>
    </AuthShell>
  );
}
