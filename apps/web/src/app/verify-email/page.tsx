"use client";

import { useEffect, useState } from "react";
import { AuthShell } from "../../components/AuthShell";
import { useT } from "../../lib/i18n";

type State = "working" | "done" | "invalid";

/**
 * 이메일 인증 — 인증 메일의 링크로 진입한다 (?token=...).
 *
 * 서버는 가입·주소 변경 때 이 주소로 링크를 보내고 확인 API 도 갖추고 있었는데
 * (`POST /api/email/verify`), **이 화면이 없어서 링크를 누르면 404 였다.** 회원은 메일을
 * 받고도 인증할 길이 없었다 — 캡차와 같은 종류의 구멍이다(서버는 되는데 화면이 없다).
 *
 * 토큰은 한 번만 쓸 수 있으므로 자동으로 한 번만 보낸다. React StrictMode 의 이중 실행에
 * 두 번 보내면 두 번째가 "이미 사용된 링크"로 실패하므로 플래그로 막는다.
 */
export default function VerifyEmailPage() {
  const t = useT();
  const [state, setState] = useState<State>("working");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let sent = false;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token) {
      setState("invalid");
      return;
    }
    if (sent) return;
    sent = true;
    fetch("/api/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.ok) {
          setEmail(String(body.email ?? ""));
          setState("done");
        } else {
          setMessage(String(body.message ?? ""));
          setState("invalid");
        }
      })
      .catch(() => setState("invalid"));
  }, []);

  return (
    <AuthShell title={t("verify.title")}>
      {state === "working" && (
        <p style={{ textAlign: "center", color: "var(--color-muted)" }}>{t("verify.working")}</p>
      )}

      {state === "done" && (
        <div style={{
          background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-success) 34%, transparent)",
          borderRadius: 8, padding: 20,
        }}>
          <p style={{ margin: 0 }}>{email ? t("verify.doneWith", { email }) : t("verify.done")}</p>
          <p style={{ fontSize: 14 }}><a href="/account">{t("verify.goAccount")}</a></p>
        </div>
      )}

      {state === "invalid" && (
        <div role="alert" style={{
          background: "var(--color-primary-soft)",
          border: "1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)",
          borderRadius: 8, padding: 20,
        }}>
          <p style={{ margin: 0 }}>{message || t("verify.invalid")}</p>
          {/* 링크는 한 번만·기간 안에만 쓸 수 있다 — 막다른 길이 되지 않게 다시 받을 곳을 준다 */}
          <p style={{ color: "var(--color-muted)", fontSize: 14 }}>{t("verify.invalidHint")}</p>
          <p style={{ fontSize: 14 }}><a href="/account">{t("verify.goAccount")}</a></p>
        </div>
      )}
    </AuthShell>
  );
}
