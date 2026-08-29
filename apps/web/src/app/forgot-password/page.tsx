"use client";

import { useState } from "react";
import { useT } from "../../lib/i18n";

/**
 * 비밀번호 찾기.
 * 서버는 계정 존재 여부를 알려주지 않으므로(이메일 열거 방지)
 * 화면도 항상 "메일을 보냈습니다"로 안내한다.
 */
export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await fetch("/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSent(true);
    setBusy(false);
  }

  const input = { width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 400, margin: "100px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center" }}>{t("forgot.title")}</h1>
      {sent ? (
        <div style={{ background: "#f2f8f4", border: "1px solid #cde8d6", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>
            <strong>{email}</strong>{t("forgot.sent")}
          </p>
          <p style={{ color: "#666", fontSize: 14 }}>
            {t("forgot.hint")}
          </p>
          <p style={{ fontSize: 14 }}><a href="/login">{t("forgot.back")}</a></p>
        </div>
      ) : (
        <>
          <p style={{ color: "#666", fontSize: 14, textAlign: "center" }}>
            {t("forgot.desc")}
          </p>
          <form onSubmit={submit}>
            <label>
              {t("login.email")}
              <input style={input} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button disabled={busy} style={{ width: "100%", padding: 12, marginTop: 20, cursor: "pointer" }}>
              {busy ? t("forgot.busy") : t("forgot.submit")}
            </button>
          </form>
          <p style={{ textAlign: "center", marginTop: 16, fontSize: 14 }}>
            <a href="/login">{t("login.title")}</a>
          </p>
        </>
      )}
    </main>
  );
}
