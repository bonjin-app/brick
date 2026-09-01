"use client";

import { useEffect, useState } from "react";
import { authButton, authInput, authLabel } from "../../components/AuthShell";
import { useSiteName, useT } from "../../lib/i18n";

interface Profile {
  email: string;
  display_name: string;
  email_verified: boolean;
  marketing_opt_in: boolean;
  birth_month: number | null;
  birth_day: number | null;
  password_login_enabled: boolean;
}

interface Session {
  id: string;
  device: string;
  isCurrent: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * 마이페이지 — 내 정보 수정 · 비밀번호 변경 · 접속 기기 · 탈퇴.
 *
 * 전부 이미 있던 API(/api/me/*, /api/me/security/*)의 화면이다.
 * 탈퇴는 법이 보장하는 권리(M15)인데 API 로만 존재하면 회원 입장에서는
 * 없는 기능이다 — 화면이 있어야 기능이다.
 *
 * 로그인·가입과 같은 코어 화면 계층(CSR)이고, 테마 헤더의 이름을 눌러
 * 들어온다. 색은 전부 명시한다 (AuthShell 과 같은 이유 — UA 다크 잠식 방지).
 */
export default function AccountPage() {
  const t = useT();
  const siteName = useSiteName();
  const [me, setMe] = useState<Profile | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // 폼 상태
  const [name, setName] = useState("");
  const [birth, setBirth] = useState({ month: "", day: "" });
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [withdraw, setWithdraw] = useState({ password: "", confirm: "", deletePosts: false });
  const [losses, setLosses] = useState<Array<{ label: string; detail: string }>>([]);
  const [gone, setGone] = useState(false);

  const say = (ok: string) => { setNotice(ok); setError(""); };
  const oops = (message?: string) => { setError(message || t("account.fail")); setNotice(""); };

  async function load() {
    const r = await fetch("/api/me/profile");
    if (r.status === 401) { setNeedLogin(true); return; }
    if (!r.ok) { oops(); return; }
    const p: Profile = await r.json();
    setMe(p);
    setName(p.display_name);
    setBirth({ month: p.birth_month ? String(p.birth_month) : "", day: p.birth_day ? String(p.birth_day) : "" });
    fetch("/api/me/security/sessions").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setSessions(d.items ?? []))
      .catch(() => {});
    fetch("/api/me/withdraw/preview").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setLosses(d.items ?? []))
      .catch(() => {});
  }
  useEffect(() => { load().catch(() => oops()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function call(input: RequestInfo, init: RequestInit, done: string) {
    const r = await fetch(input, { headers: { "content-type": "application/json" }, ...init });
    if (!r.ok) { oops((await r.json().catch(() => ({}))).message); return false; }
    say(done);
    return true;
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    const month = birth.month === "" ? null : Number(birth.month);
    const day = birth.day === "" ? null : Number(birth.day);
    if (await call("/api/me", {
      method: "PUT",
      body: JSON.stringify({ displayName: name, birthMonth: month, birthDay: day }),
    }, t("account.saved"))) load();
  }

  async function toggleMarketing(optIn: boolean) {
    setMe(me ? { ...me, marketing_opt_in: optIn } : me);
    await call("/api/me/marketing", { method: "PUT", body: JSON.stringify({ optIn }) }, t("account.saved"));
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) { oops(t("reset.mismatch")); return; }
    if (await call("/api/me", {
      method: "PUT",
      body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
    }, t("account.passwordChanged"))) {
      setPw({ current: "", next: "", confirm: "" });
      load();
    }
  }

  async function revokeSession(id: string) {
    await fetch(`/api/me/security/sessions/${id}`, { method: "DELETE" });
    load();
  }

  async function revokeOthers() {
    if (await call("/api/me/security/sessions/revoke-others", { method: "POST" }, t("account.sessionsRevoked"))) load();
  }

  async function doWithdraw(e: React.FormEvent) {
    e.preventDefault();
    const body = me?.password_login_enabled
      ? { password: withdraw.password, deletePosts: withdraw.deletePosts }
      : { confirm: withdraw.confirm, deletePosts: withdraw.deletePosts };
    if (await call("/api/me/withdraw", { method: "POST", body: JSON.stringify(body) }, "")) setGone(true);
  }

  const page: React.CSSProperties = {
    minHeight: "100vh", margin: 0, background: "#f5f6f8", color: "#1a1a1a", colorScheme: "light",
    fontFamily: "'Pretendard', 'Apple SD Gothic Neo', sans-serif",
    padding: "40px 16px 72px", boxSizing: "border-box",
  };
  const card: React.CSSProperties = {
    width: "100%", maxWidth: 560, margin: "0 auto 18px", background: "#fff",
    border: "1px solid #e7e7ec", borderRadius: 14, padding: "24px 26px",
    boxShadow: "0 4px 16px rgba(20,20,31,.05)", boxSizing: "border-box",
  };
  const h2: React.CSSProperties = { margin: "0 0 14px", fontSize: 17, letterSpacing: "-0.3px" };
  const small: React.CSSProperties = { fontSize: 12.5, color: "#8b8b95" };
  const saveBtn: React.CSSProperties = { ...authButton, width: "auto", padding: "9px 18px", marginTop: 14 };

  if (gone) {
    return (
      <main style={page}>
        <div style={{ ...card, textAlign: "center", marginTop: "18vh" }}>
          <p style={{ margin: 0 }}>{t("account.withdrawDone")}</p>
          <p style={{ marginTop: 14 }}><a href="/">{t("account.backToSite")}</a></p>
        </div>
      </main>
    );
  }

  if (needLogin) {
    return (
      <main style={page}>
        <div style={{ ...card, textAlign: "center", marginTop: "18vh" }}>
          <p style={{ margin: 0 }}>{t("account.loginRequired")}</p>
          <p style={{ marginTop: 14 }}><a href="/login">{t("account.goLogin")}</a></p>
        </div>
      </main>
    );
  }

  return (
    <main style={page}>
      <header style={{ width: "100%", maxWidth: 560, margin: "0 auto 20px", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.5px" }}>{t("account.title")}</h1>
        <a href="/" style={{ fontSize: 13.5, color: "#e2574c", textDecoration: "none" }}>
          ← {siteName || t("account.backToSite")}
        </a>
      </header>

      {(notice || error) && (
        <div style={{ ...card, padding: "12px 18px", color: error ? "#c0392b" : "#0a7", fontSize: 14 }}>
          {error || notice}
        </div>
      )}

      {me && (
        <>
          {/* ── 기본 정보 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.profile")}</h2>
            <p style={{ margin: "0 0 4px", fontSize: 14 }}>
              {t("account.email")} — <strong>{me.email}</strong>{" "}
              {me.email_verified ? (
                <span style={{ color: "#0a7", fontSize: 12.5 }}>✓ {t("account.emailVerified")}</span>
              ) : (
                <>
                  <span style={{ color: "#c0392b", fontSize: 12.5 }}>{t("account.emailUnverified")}</span>{" "}
                  <button style={{ ...small, border: 0, background: "none", color: "#e2574c", cursor: "pointer", padding: 0 }}
                    onClick={() => call("/api/me/email/verify/send", { method: "POST", body: "{}" }, t("account.verifySent"))}>
                    {t("account.sendVerify")}
                  </button>
                </>
              )}
            </p>
            <form onSubmit={saveProfile}>
              <label style={authLabel}>{t("account.name")}
                <input style={authInput} required minLength={2} maxLength={30} value={name}
                  onChange={(e) => setName(e.target.value)} />
              </label>
              <label style={authLabel}>{t("account.birth")}
                <span style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...authInput, width: 90 }} type="number" min={1} max={12} placeholder="MM"
                    value={birth.month} onChange={(e) => setBirth({ ...birth, month: e.target.value })} />
                  <input style={{ ...authInput, width: 90 }} type="number" min={1} max={31} placeholder="DD"
                    value={birth.day} onChange={(e) => setBirth({ ...birth, day: e.target.value })} />
                </span>
              </label>
              <p style={{ ...small, margin: "6px 0 0" }}>{t("account.birthHint")}</p>
              <button style={saveBtn}>{t("account.save")}</button>
            </form>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, fontSize: 14 }}>
              <input type="checkbox" checked={me.marketing_opt_in} onChange={(e) => toggleMarketing(e.target.checked)} />
              {t("account.marketing")}
            </label>
          </section>

          {/* ── 비밀번호 변경 (비밀번호 로그인 계정만) ── */}
          {me.password_login_enabled && (
            <section style={card}>
              <h2 style={h2}>{t("account.password")}</h2>
              <form onSubmit={changePassword}>
                <label style={{ ...authLabel, marginTop: 0 }}>{t("account.currentPassword")}
                  <input style={authInput} type="password" required value={pw.current}
                    onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                </label>
                <label style={authLabel}>{t("account.newPassword")}
                  <input style={authInput} type="password" required minLength={8} value={pw.next}
                    onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </label>
                <label style={authLabel}>{t("account.confirmPassword")}
                  <input style={authInput} type="password" required value={pw.confirm}
                    onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
                </label>
                <button style={saveBtn}>{t("account.change")}</button>
              </form>
            </section>
          )}

          {/* ── 접속 중인 기기 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.sessions")}</h2>
            {sessions.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #f0f0f4", fontSize: 14 }}>
                <span style={{ flex: 1 }}>
                  {s.device}{" "}
                  {s.isCurrent && <em style={{ fontStyle: "normal", color: "#0a7", fontSize: 12.5 }}>· {t("account.sessionCurrent")}</em>}
                  <br />
                  <span style={small}>{t("account.lastSeen")}: {new Date(s.lastSeenAt ?? s.createdAt).toLocaleString()}</span>
                </span>
                {!s.isCurrent && (
                  <button style={{ ...small, border: "1px solid #e7e7ec", background: "#fff", borderRadius: 7, padding: "5px 10px", cursor: "pointer" }}
                    onClick={() => revokeSession(s.id)}>
                    {t("account.sessionRevoke")}
                  </button>
                )}
              </div>
            ))}
            {sessions.length > 1 && (
              <button style={{ ...saveBtn, background: "#fff", color: "#c0392b", border: "1px solid #f0c9c4" }} onClick={revokeOthers}>
                {t("account.sessionRevokeOthers")}
              </button>
            )}
          </section>

          {/* ── 탈퇴 ── */}
          <section style={{ ...card, borderColor: "#f0c9c4" }}>
            <h2 style={{ ...h2, color: "#c0392b" }}>{t("account.withdraw")}</h2>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "#6b6b75" }}>{t("account.withdrawDesc")}</p>
            {losses.length > 0 && (
              <details style={{ fontSize: 13.5, marginBottom: 10 }}>
                <summary style={{ cursor: "pointer" }}>{t("account.withdrawLosses")}</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#6b6b75" }}>
                  {losses.map((l, i) => <li key={i}><strong>{l.label}</strong> — {l.detail}</li>)}
                </ul>
              </details>
            )}
            <form onSubmit={doWithdraw}>
              <label style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 14 }}>
                <input type="checkbox" checked={withdraw.deletePosts}
                  onChange={(e) => setWithdraw({ ...withdraw, deletePosts: e.target.checked })} />
                <span>{t("account.deletePosts")} <span style={small}>{t("account.deletePostsHint")}</span></span>
              </label>
              {me.password_login_enabled ? (
                <label style={authLabel}>{t("account.withdrawPassword")}
                  <input style={authInput} type="password" required value={withdraw.password}
                    onChange={(e) => setWithdraw({ ...withdraw, password: e.target.value })} />
                </label>
              ) : (
                <label style={authLabel}>{t("account.withdrawConfirmPhrase")}
                  <input style={authInput} required value={withdraw.confirm}
                    onChange={(e) => setWithdraw({ ...withdraw, confirm: e.target.value })} />
                </label>
              )}
              <button style={{ ...saveBtn, background: "#c0392b" }}>{t("account.withdrawButton")}</button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
