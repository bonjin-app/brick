"use client";

import { useState } from "react";
import { useAdminT } from "../../../lib/i18n-admin";

export default function AdminLoginPage() {
  const t = useAdminT();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) window.location.href = "/admin";
    else {
      setError(t("adminLogin.fail"));
      setBusy(false);
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 380, margin: "100px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>BRICK</h1>
      <p style={{ textAlign: "center", color: "#666" }}>{t("adminLogin.subtitle")}</p>
      <form onSubmit={submit}>
        <label>
          {t("common.email")}
          <input style={input} type="email" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          {t("common.password")}
          <input style={input} type="password" required value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <button disabled={busy} style={{ width: "100%", padding: 12, marginTop: 24, cursor: "pointer" }}>
          {busy ? t("adminLogin.busy") : t("adminLogin.submit")}
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
        <a href="/forgot-password">{t("adminLogin.forgot")}</a>
      </p>
    </main>
  );
}
