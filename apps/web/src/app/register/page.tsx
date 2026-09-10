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
 *
 * 캡차도 같은 종류의 구멍이었다. 서버는 기본으로 캡차를 요구하는데(BRICK_CAPTCHA=off 로만
 * 끈다) 이 화면에 입력 칸이 없어서, **기본 설정으로 설치한 사이트는 회원가입이 아예
 * 되지 않았다** — 손님은 "자동입력 방지 문자가 올바르지 않습니다"를 보지만 그 문자를 넣을
 * 칸이 없다. 스모크가 전부 BRICK_CAPTCHA=off 로 돌아 아무도 보지 못했다.
 */
export default function RegisterPage() {
  const t = useT();
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  /*
   * 어느 칸이 문제인지 — 서버가 알려주면 그 칸에 표시를 걸고 포커스를 옮긴다.
   * 메시지만 띄우면 손님은 세 칸을 되짚어야 하고, 그 지점이 가입 직전이다.
   */
  const [badField, setBadField] = useState("");
  /** 캡차 — 서버가 켜져 있다고 하면 그린다(끈 사이트에서는 칸이 없다) */
  const [captcha, setCaptcha] = useState<{ token: string; svg: string; hint: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState("");

  /** 새 문제를 받는다 — 틀렸을 때도 다시 받아야 한다(한 번 쓴 토큰은 재사용되지 않는다) */
  const loadCaptcha = () => {
    fetch("/api/captcha")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setCaptcha(d?.enabled ? { token: d.token, svg: d.svg, hint: d.hint } : null))
      .catch(() => setCaptcha(null));
  };
  useEffect(loadCaptcha, []);

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
    setBadField("");
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        ageConfirmed,
        ...(captcha ? { captchaToken: captcha.token, captchaAnswer } : {}),
        agreements: Object.fromEntries(agreements.map((a) => [a.kind, checked[a.kind] === true])),
      }),
    });
    if (res.ok) {
      setState("done");
      setTimeout(() => (window.location.href = "/login"), 1200);
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? t("register.fail"));
      // 쓴 토큰은 다시 못 쓴다 — 새 문제를 받지 않으면 두 번째 시도가 반드시 실패한다
      if (captcha) { loadCaptcha(); setCaptchaAnswer(""); }
      const field = typeof body.field === "string" ? body.field : "";
      setBadField(field);
      setState("idle");
      // 표시만 하고 끝내면 손님이 어느 칸인지 찾아야 한다 — 그 칸으로 데려간다
      if (field) {
        requestAnimationFrame(() => {
          const el = document.getElementById(`register-${field}`);
          el?.focus();
          el?.scrollIntoView({ block: "center" });
        });
      }
    }
  }

  /*
   * 동의 줄 — 손가락으로 누를 수 있는 높이를 준다.
   *
   * 체크박스는 16px 이고 라벨 줄은 23px 였다. 폰에서 필수 동의가 넷이 위아래로
   * 붙어 있으면 그 높이로는 옆줄을 누르기 쉽고, 잘못 누르면 **다른 동의가 켜진다**.
   * 라벨 전체가 누르는 자리이므로 라벨에 높이를 준다 (체크박스만 키우면
   * 브라우저마다 모양이 달라진다).
   */
  const checkRow: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 10, marginTop: 4, fontSize: 14,
    color: "var(--color-text)", minHeight: 40, cursor: "pointer",
  };

  return (
    <AuthShell title={t("register.title")}>
      {state === "done" ? (
        <p style={{ textAlign: "center", color: "var(--color-success)" }}>{t("register.done")}</p>
      ) : (
        <form onSubmit={submit}>
          <label style={{ ...authLabel, marginTop: 0 }}>{t("register.name")}
            <input id="register-displayName" style={authInput} required minLength={2} maxLength={30}
              aria-invalid={badField === "displayName" || undefined} value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label style={authLabel}>{t("login.email")}
            <input id="register-email" style={authInput} type="email" required
              aria-invalid={badField === "email" || undefined} value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label style={authLabel}>{t("register.password8")}
            <input id="register-password" style={authInput} type="password" required minLength={8}
              aria-invalid={badField === "password" || undefined} value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>

          {captcha && (
            <label style={authLabel}>{t("register.captcha")}
              <span style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5 }}>
                {/* 서버가 만든 SVG — 문자만 그린 그림이라 마크업이 들어올 여지가 없다 */}
                <span aria-hidden="true" style={{ lineHeight: 0, borderRadius: 6, overflow: "hidden", flex: "0 0 auto" }}
                  dangerouslySetInnerHTML={{ __html: captcha.svg }} />
                <button type="button" onClick={() => { loadCaptcha(); setCaptchaAnswer(""); }}
                  style={{ padding: "8px 10px", minHeight: 34, border: "1px solid var(--color-line)",
                           borderRadius: 6, background: "var(--color-bg)", cursor: "pointer", fontSize: 13 }}>
                  {t("register.captchaReload")}
                </button>
              </span>
              <input id="register-captchaAnswer" style={{ ...authInput, marginTop: 6 }} required
                autoComplete="off" inputMode="text" aria-describedby="register-captcha-hint"
                aria-invalid={badField === "captchaAnswer" || undefined}
                value={captchaAnswer} onChange={(e) => setCaptchaAnswer(e.target.value)} />
              <span id="register-captcha-hint" style={{ display: "block", fontSize: 12.5, color: "var(--color-muted)", marginTop: 4 }}>
                {captcha.hint}
              </span>
            </label>
          )}

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
      {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 14 }}>{error}</p>}
      <SocialButtons next="/" />
      <p style={{ textAlign: "center", marginTop: 18, fontSize: 14, color: "var(--color-muted)" }}>
        {t("register.haveAccount")} <a href="/login" style={authLink}>{t("login.title")}</a>
      </p>
    </AuthShell>
  );
}
