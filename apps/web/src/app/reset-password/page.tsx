"use client";

import { useEffect, useState } from "react";
import { AuthShell, authButton, authInput, authLabel } from "../../components/AuthShell";
import { useT } from "../../lib/i18n";

type State = "checking" | "invalid" | "ready" | "done";

/** 비밀번호 재설정 — 메일 링크로 진입 (?token=...) */
export default function ResetPasswordPage() {
  const t = useT();
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
      setError(t("reset.mismatch"));
      return;
    }
    if (form.password.length < 8) {
      setError(t("reset.tooShort"));
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
      setError((await res.json()).message ?? t("reset.fail"));
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("reset.title")}>

      {state === "checking" && <p style={{ textAlign: "center", color: "#6b6b75" }}>{t("reset.checking")}</p>}

      {state === "invalid" && (
        <div style={{ background: "#fdf2f0", border: "1px solid #f3d0ca", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>{t("reset.invalid")}</p>
          <p style={{ fontSize: 14 }}><a href="/forgot-password">{t("reset.again")}</a></p>
        </div>
      )}

      {state === "done" && (
        <div style={{ background: "#f2f8f4", border: "1px solid #cde8d6", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>{t("reset.changed")}</p>
          <p style={{ color: "#666", fontSize: 14 }}>{t("reset.sessionsCleared")}</p>
          <p style={{ fontSize: 14 }}><a href="/login">{t("reset.loginNew")}</a></p>
        </div>
      )}

      {state === "ready" && (
        <form onSubmit={submit}>
          <label style={{ ...authLabel, marginTop: 0 }}>
            {t("reset.newPassword")}
            <input style={authInput} type="password" required minLength={8} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <label style={authLabel}>
            {t("reset.confirm")}
            <input style={authInput} type="password" required value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </label>
          <button disabled={busy} style={authButton}>
            {busy ? t("reset.busy") : t("reset.submit")}
          </button>
          {error && <p style={{ color: "#c0392b", fontSize: 14 }}>{error}</p>}
        </form>
      )}
    </AuthShell>
  );
}
