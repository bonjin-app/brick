"use client";

import { useEffect, useState } from "react";
import { SocialButtons } from "../../components/SocialButtons";
import { AuthShell, authButton, authInput, authLabel, authLink } from "../../components/AuthShell";
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
    if (res.ok) window.location.href = safeNext();
    else {
      setError((await res.json()).message ?? t("login.fail"));
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("login.title")}>
      <form onSubmit={submit}>
        {/*
          * name·autocomplete 가 없으면 비밀번호 관리자가 이 칸을 알아보지 못한다 —
          * 저장해 둔 비밀번호가 채워지지 않아 손님이 폰에서 손으로 친다.
          * 주문서에는 이미 넣어 두었는데 로그인·가입만 빠져 있었다.
          */}
        <label style={{ ...authLabel, marginTop: 0 }}>{t("login.email")}
          <input style={authInput} type="email" required name="email" autoComplete="username"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label style={authLabel}>{t("login.password")}
          <input style={authInput} type="password" required name="password" autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <button disabled={busy} style={authButton}>
          {busy ? t("login.busy") : t("login.title")}
        </button>
      </form>
      {/* role="alert" 가 없으면 스크린리더에는 아무 일도 안 일어난 화면이다 */}
      {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 14 }}>{error}</p>}
      <SocialButtons next={safeNext()} />
      <p style={{ textAlign: "center", marginTop: 18, fontSize: 14, color: "var(--color-muted)" }}>
        {t("login.noAccount")} <a href="/register" style={authLink}>{t("login.register")}</a>
        {" · "}
        <a href="/forgot-password" style={authLink}>{t("login.forgot")}</a>
      </p>
    </AuthShell>
  );
}

/** 로그인·가입 계열 — 여기로 돌려보내면 제자리를 맴돈다 */
const AUTH_PATHS = /^\/(login|register|forgot-password|reset-password|admin\/login)(\/|$)/;

/**
 * 로그인 뒤 돌아갈 곳.
 *
 * 먼저 ?next= 를 본다. 그런데 **그것을 보내는 화면이 하나뿐이었다**(1:1 문의).
 * 게시판의 비밀글·답글, 쿠폰함, 마이페이지는 전부 맨 `/login` 으로 보내고 있어서,
 * 읽던 글에서 로그인을 누른 손님이 홈으로 떨어졌다 — 글을 다시 찾아 들어가야 한다.
 * 테마가 직접 넣은 로그인 링크까지 생각하면 진입로를 하나씩 고쳐서는 끝이 없다.
 *
 * 그래서 ?next= 가 없으면 **같은 사이트에서 온 경우** 그 자리로 돌려보낸다.
 * referrer-policy 가 strict-origin-when-cross-origin 이라 같은 출처의 이동에는
 * 전체 주소가 실려 온다(바깥에서 왔으면 출처만 오므로 여기서 걸러진다).
 *
 * 어느 쪽이든 **같은 사이트의 경로만** 받는다: "//evil.example" 같은 프로토콜
 * 상대 주소는 오픈 리다이렉트가 된다.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  if (/^\/(?!\/)/.test(next) && !AUTH_PATHS.test(next)) return next;
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === window.location.origin && !AUTH_PATHS.test(ref.pathname)) {
      return ref.pathname + ref.search;
    }
  } catch {
    // 주소가 이상하면 홈으로
  }
  return "/";
}
