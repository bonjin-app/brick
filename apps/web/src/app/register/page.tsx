"use client";

import { useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";
import { useT } from "../../lib/i18n";

/** 공개 회원가입. site.registration_open이 false면 서버가 403으로 거부한다 */
export default function RegisterPage() {
  const t = useT();
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
      setError((await res.json()).message ?? t("register.fail"));
      setState("idle");
    }
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 380, margin: "80px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>{t("register.title")}</h1>
      {state === "done" ? (
        <p style={{ textAlign: "center", color: "#0a7" }}>{t("register.done")}</p>
      ) : (
        <form onSubmit={submit}>
          <label>{t("register.name")}
            <input style={input} required minLength={2} maxLength={30} value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label style={{ display: "block", marginTop: 16 }}>{t("login.email")}
            <input style={input} type="email" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={{ display: "block", marginTop: 16 }}>{t("register.password8")}
            <input style={input} type="password" required minLength={8} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <button disabled={state === "busy"} style={{ width: "100%", padding: 12, marginTop: 24, cursor: "pointer" }}>
            {state === "busy" ? t("register.busy") : t("register.submit")}
          </button>
        </form>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
        {t("register.haveAccount")} <a href="/login">{t("login.title")}</a>
      </p>
    </main>
  );
}
