"use client";

import { useState } from "react";
import { AuthShell, authButton, authInput, authLabel, authLink } from "../../components/AuthShell";
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

  return (
    <AuthShell title={t("forgot.title")}>
      {sent ? (
        <div style={{ background: "color-mix(in srgb, var(--color-success) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--color-success) 34%, transparent)", borderRadius: 8, padding: 20 }}>
          <p style={{ margin: 0 }}>
            <strong>{email}</strong>{t("forgot.sent")}
          </p>
          <p style={{ color: "var(--color-muted)", fontSize: 14 }}>
            {t("forgot.hint")}
          </p>
          <p style={{ fontSize: 14 }}><a href="/login">{t("forgot.back")}</a></p>
        </div>
      ) : (
        <>
          <p style={{ color: "var(--color-muted)", fontSize: 14, marginTop: 0 }}>
            {t("forgot.desc")}
          </p>
          <form onSubmit={submit}>
            <label style={{ ...authLabel, marginTop: 0 }}>
              {t("login.email")}
              <input style={authInput} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button disabled={busy} style={authButton}>
              {busy ? t("forgot.busy") : t("forgot.submit")}
            </button>
          </form>
          <p style={{ textAlign: "center", marginTop: 18, fontSize: 14 }}>
            <a href="/login" style={authLink}>{t("login.title")}</a>
          </p>
        </>
      )}
    </AuthShell>
  );
}
