"use client";

import { useEffect, useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";
import { AuthShell, authButton, authInput, authLabel, authLink } from "../../components/AuthShell";
import { useT } from "../../lib/i18n";

interface Agreement {
  kind: string;
  title: string;
  body: string;
  required: boolean;
}

/**
 * 공개 회원가입.
 *
 * 약관 동의는 장식이 아니라 계약이다 — 서버는 필수 약관(terms·privacy)
 * 동의와 만 14세 확인 없이는 가입을 거부한다(M15). 이 폼이 그것을 보내지
 * 않던 동안 웹 가입은 항상 400 이었다. 약관 목록은 GET /api/agreements 로
 * 받아 그대로 그린다 — 목록을 하드코딩하면 운영자가 약관을 개정해도
 * 화면이 낡은 문서를 보여준다.
 */
export default function RegisterPage() {
  const t = useT();
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/agreements")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      // 필수 항목 먼저 — 손님이 무엇이 필수인지 위에서부터 읽게 한다
      .then((d) => setAgreements(
        (d.items as Agreement[]).slice().sort((a, b) => Number(b.required) - Number(a.required)),
      ))
      .catch(() => setAgreements([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ageConfirmed) { setError(t("register.needAge")); return; }
    setState("busy");
    setError("");
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        ageConfirmed,
        agreements: Object.fromEntries(agreements.map((a) => [a.kind, checked[a.kind] === true])),
      }),
    });
    if (res.ok) {
      setState("done");
      setTimeout(() => (window.location.href = "/login"), 1200);
    } else {
      setError((await res.json()).message ?? t("register.fail"));
      setState("idle");
    }
  }

  const checkRow: React.CSSProperties = {
    display: "flex", alignItems: "baseline", gap: 8, marginTop: 10, fontSize: 14, color: "var(--color-text)",
  };

  return (
    <AuthShell title={t("register.title")}>
      {state === "done" ? (
        <p style={{ textAlign: "center", color: "var(--color-success)" }}>{t("register.done")}</p>
      ) : (
        <form onSubmit={submit}>
          <label style={{ ...authLabel, marginTop: 0 }}>{t("register.name")}
            <input style={authInput} required minLength={2} maxLength={30} value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label style={authLabel}>{t("login.email")}
            <input style={authInput} type="email" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={authLabel}>{t("register.password8")}
            <input style={authInput} type="password" required minLength={8} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--color-line)" }}>
            {agreements.map((a) => (
              <div key={a.kind}>
                <label style={checkRow}>
                  <input type="checkbox" required={a.required} checked={checked[a.kind] === true}
                    onChange={(e) => setChecked({ ...checked, [a.kind]: e.target.checked })} />
                  <span>
                    {a.title}{" "}
                    <em style={{ fontStyle: "normal", fontSize: 12.5, color: a.required ? "var(--color-danger)" : "var(--color-muted)" }}>
                      {a.required ? t("register.required") : t("register.optional")}
                    </em>
                  </span>
                </label>
                <details style={{ margin: "2px 0 0 24px", fontSize: 12.5, color: "var(--color-muted)" }}>
                  <summary style={{ cursor: "pointer" }}>{t("register.viewBody")}</summary>
                  <pre style={{
                    whiteSpace: "pre-wrap", font: "inherit", margin: "6px 0 4px",
                    maxHeight: 180, overflowY: "auto", background: "var(--color-bg-soft)",
                    border: "1px solid var(--color-line)", borderRadius: 8, padding: 10,
                  }}>{a.body}</pre>
                </details>
              </div>
            ))}
            <label style={checkRow}>
              <input type="checkbox" required checked={ageConfirmed}
                onChange={(e) => setAgeConfirmed(e.target.checked)} />
              <span>
                {t("register.age")}{" "}
                <em style={{ fontStyle: "normal", fontSize: 12.5, color: "var(--color-danger)" }}>{t("register.required")}</em>
              </span>
            </label>
          </div>

          <button disabled={state === "busy"} style={authButton}>
            {state === "busy" ? t("register.busy") : t("register.submit")}
          </button>
        </form>
      )}
      {error && <p style={{ color: "var(--color-danger)", fontSize: 14 }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 18, fontSize: 14, color: "var(--color-muted)" }}>
        {t("register.haveAccount")} <a href="/login" style={authLink}>{t("login.title")}</a>
      </p>
    </AuthShell>
  );
}
