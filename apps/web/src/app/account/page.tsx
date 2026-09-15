"use client";

import { useEffect, useState } from "react";
import { authButton, authInput, authLabel } from "../../components/AuthShell";
import { useSiteName, useT, useLocaleTag } from "../../lib/i18n";

interface Profile {
  email: string;
  display_name: string;
  email_verified: boolean;
  marketing_opt_in: boolean;
  birth_month: number | null;
  birth_day: number | null;
  password_login_enabled: boolean;
  avatar_url?: string | null;
  display_name_changed_at?: string | null;
}

interface PendingAgreement {
  kind: string;
  version: number;
  title: string;
  body: string;
}

interface Identity {
  provider: string;
  label: string;
  email: string | null;
  created_at: string;
}

interface TotpStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  enabledAt: string | null;
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
  const localeTag = useLocaleTag();
  const t = useT();
  const siteName = useSiteName();
  const [me, setMe] = useState<Profile | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  /*
   * 연결된 로그인 수단.
   *
   * API 는 처음부터 있었는데(연결·해제·목록) 보여 주는 화면이 없었다. 그래서
   * 소셜 계정이 자기 계정에 붙어 있어도 회원은 볼 수도 뗄 수도 없었다 — 훔친
   * 세션으로 심어진 뒷문이라면 더더욱 그렇다. 연결 알림 메일이 "내 정보에서
   * 해제하세요" 라고 안내하는데 정작 그 화면이 없었다.
   */
  /*
   * 다시 동의해야 하는 약관.
   *
   * 개정·목록(agreements/pending)·수락(agreements/accept) API 가 다 있었고
   * 서버는 `pendingAgreements` 개수까지 내려보내고 있었다. 그런데 그것을 읽는
   * 화면이 없었다 — 운영자가 약관을 개정해도 기존 회원에게는 **묻지 않았다.**
   * 필수 약관은 동의해야 계속 이용할 수 있다고 서버가 말하는데(acceptPending),
   * 물어볼 자리가 없었던 것이다.
   */
  const [pending, setPending] = useState<PendingAgreement[]>([]);
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [identities, setIdentities] = useState<Identity[]>([]);
  /*
   * 2단계 인증.
   *
   * TOTP·복구 코드·도전 토큰·감사 로그까지 서버는 전부 갖춰 두었는데
   * `2fa/begin` 을 부르는 화면이 한 곳도 없었다 — 아무도 켤 수 없었다는 뜻이다.
   * 그런데 관리 설정에는 "관리자에게 2단계 인증 요구" 체크박스가 있어서, 그것을
   * 켜면 **등록할 방법이 없는 채로** 관리 화면 전체에서 잠겼다. 서비스 주석이
   * "강제 설정이 켜져 있어도 등록 경로는 열어 둔다" 며 대비한 잠금을, 화면이
   * 없다는 이유로 그대로 맞고 있었던 것이다.
   */
  const [totp, setTotp] = useState<TotpStatus | null>(null);
  const [staff2fa, setStaff2fa] = useState(false);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpPw, setTotpPw] = useState("");
  const [totpCode, setTotpCode] = useState("");
  // 한 번만 보여 주는 값이라 화면을 떠나면 사라진다 — 그래서 저장을 강하게 안내한다
  const [recovery, setRecovery] = useState<string[]>([]);
  const [recoveryNote, setRecoveryNote] = useState("");
  const [providers, setProviders] = useState<Array<{ name: string; label: string }>>([]);
  const [linkPw, setLinkPw] = useState("");
  const [linking, setLinking] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // 폼 상태
  const [name, setName] = useState("");
  const [birth, setBirth] = useState({ month: "", day: "" });
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [withdraw, setWithdraw] = useState({ password: "", confirm: "", deletePosts: false });
  const [losses, setLosses] = useState<Array<{ label: string; detail: string }>>([]);
  /**
   * 회원 메뉴 — 플러그인이 선언한 회원 화면(쪽지함·포인트 내역·스크랩 …).
   *
   * 이 목록이 없던 동안 그 화면들은 주소를 아는 사람만 쓸 수 있었다. 헤더는
   * 자리가 좁아 늘 쓰는 것만 올라가므로, 나머지가 닿는 곳은 여기여야 한다.
   */
  const [memberMenu, setMemberMenu] = useState<Array<{ label: string; path: string }>>([]);
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
    // 세션·2단계 인증 상태·강제 여부가 한 응답에 같이 온다
    fetch("/api/me/security").then((r2) => (r2.ok ? r2.json() : null))
      .then((d) => {
        if (!d) return;
        setSessions(d.sessions ?? []);
        setTotp(d.twoFactor ?? null);
        setStaff2fa(Boolean(d.requiredForStaff));
      })
      .catch(() => {});
    fetch("/api/me/withdraw/preview").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setLosses(d.items ?? []))
      .catch(() => {});
    fetch("/api/member/menu").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setMemberMenu(d.items ?? []))
      .catch(() => {});
    fetch("/api/agreements/pending").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setPending(d.items ?? []))
      .catch(() => {});
    fetch("/api/auth/oauth/my/identities").then((s) => (s.ok ? s.json() : []))
      .then((d) => setIdentities(Array.isArray(d) ? d : (d.items ?? [])))
      .catch(() => {});
    fetch("/api/auth/oauth/providers").then((s) => (s.ok ? s.json() : { items: [] }))
      .then((d) => setProviders(d.items ?? []))
      .catch(() => {});
  }
  useEffect(() => { load().catch(() => oops()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function acceptPending() {
    const r = await fetch("/api/agreements/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accepted: agreed }),
    });
    if (!r.ok) { oops((await r.json().catch(() => ({}))).message); return; }
    say(t("account.pendingDone"));
    setPending([]);
    setAgreed({});
  }

  /** 등록 시작 — 비밀을 받아 온다. 아직 켜지지 않는다 */
  async function beginTotp(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/me/security/2fa/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: totpPw }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { oops(d.message); return; }
    setTotpPw("");
    setEnroll({ secret: String(d.secret ?? ""), otpauthUri: String(d.otpauthUri ?? "") });
    setNotice("");
    setError("");
  }

  /** 코드를 확인해야 켜진다 — 여기서 복구 코드가 한 번 나온다 */
  async function completeTotp(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/me/security/2fa/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totpCode }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { oops(d.message); return; }
    setEnroll(null);
    setTotpCode("");
    setRecovery(d.recoveryCodes ?? []);
    setRecoveryNote(String(d.warning ?? ""));
    say(t("account.totpOn"));
    load();
  }

  async function regenRecovery() {
    const r = await fetch("/api/me/security/2fa/recovery-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: totpPw }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { oops(d.message); return; }
    setTotpPw("");
    setRecovery(d.recoveryCodes ?? []);
    setRecoveryNote(String(d.warning ?? ""));
    load();
  }

  async function disableTotp() {
    const r = await fetch("/api/me/security/2fa/disable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: totpPw }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { oops(d.message); return; }
    setTotpPw("");
    say(t("account.totpDisabled"));
    load();
  }

  /** 복사가 막힌 브라우저(비 HTTPS·권한 거부)에서도 키는 눈으로 옮겨 적을 수 있다 */
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      say(t("account.totpCopied"));
    } catch {
      // 조용히 넘어간다 — 화면의 값은 그대로 선택할 수 있다
    }
  }

  async function unlinkIdentity(it: Identity) {
    if (!confirm(t("account.identityUnlinkConfirm", { label: it.label }))) return;
    const r = await fetch(`/api/auth/oauth/my/identities/${encodeURIComponent(it.provider)}`, { method: "DELETE" });
    if (!r.ok) { oops((await r.json().catch(() => ({}))).message); return; }
    say(t("account.identityUnlinked"));
    setIdentities((list) => list.filter((x) => x.provider !== it.provider));
  }

  /*
   * 연결은 비밀번호를 다시 확인한 뒤에만 시작한다(서버가 재인증을 요구한다).
   * 승격이 끝나면 공급자로 넘어가는 것이라, 그 이동은 링크가 아니라 여기서 한다.
   */
  async function startLink(provider: string) {
    const r = await fetch("/api/me/security/reauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: linkPw }),
    });
    if (!r.ok) { setLinking(null); oops(t("account.identityPasswordWrong")); return; }
    setLinkPw("");
    window.location.href = `/api/auth/oauth/${encodeURIComponent(provider)}?link=1&next=/account`;
  }

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
    // colorScheme 을 라이트로 못 박으면 다크 화면에 흰 체크박스가 남는다 —
    // 밝기는 루트가 손님의 선택에 따라 정한다
    minHeight: "100dvh", margin: 0, background: "var(--color-bg-soft)", color: "var(--color-text)",
    fontFamily: "'Pretendard', 'Apple SD Gothic Neo', sans-serif",
    padding: "40px 16px 72px", boxSizing: "border-box",
  };
  const card: React.CSSProperties = {
    width: "100%", maxWidth: 560, margin: "0 auto 18px", background: "var(--color-bg)",
    border: "1px solid var(--color-line)", borderRadius: 14, padding: "24px 26px",
    boxShadow: "0 4px 16px rgba(20,20,31,.05)", boxSizing: "border-box",
  };
  const h2: React.CSSProperties = { margin: "0 0 14px", fontSize: 17, letterSpacing: "-0.3px" };
  const small: React.CSSProperties = { fontSize: 12.5, color: "var(--color-muted)" };
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
        {/*
          색은 `--color-primary` 가 아니라 `--color-primary-text` 다. 앞의 것은
          **면을 칠하는 색**이고(버튼 배경), 글자로 쓰면 밝은 테마에서 4.29:1 로
          AA(4.5)를 넘기지 못한다 — 대비 감사가 이 링크에서 정확히 그것을 짚었다.
          테마들은 글자용 변종을 따로 정의해 둔다(default #b63a2e, storefront 는
          아예 먹색). 게시판 플러그인은 이미 그 토큰을 쓰고 있었고 여기만 남았다.

          폰에서 이 링크의 실제 높이는 16px 였다 — 손가락으로는 잘 안 눌리고, 바로
          위아래에 제목과 카드가 있어 빗나가면 엉뚱한 곳을 누른다. 가입 화면에서
          같은 것을 이미 고쳤는데(홈 링크 44px) 마이페이지는 남아 있었다.
          글자 크기는 그대로 두고 누를 자리만 넓힌다.
        */}
        <a href="/" style={{
          fontSize: 13.5, color: "var(--color-primary-text)", textDecoration: "none",
          display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 4px",
        }}>
          ← {siteName || t("account.backToSite")}
        </a>
      </header>

      {(notice || error) && (
        // 실패는 눈으로만 알려주면 안 된다 — 스크린리더에는 아무 일도 없는 화면이 된다
        <div role={error ? "alert" : "status"}
          style={{ ...card, padding: "12px 18px", color: error ? "var(--color-danger)" : "var(--color-success)", fontSize: 14 }}>
          {error || notice}
        </div>
      )}

      {me && (
        <>
          {/* ── 다시 동의해야 하는 약관 (있을 때만, 맨 위에) ── */}
          {pending.length > 0 && (
            <section style={{ ...card, borderColor: "var(--color-warning)" }} role="alert">
              <h2 style={h2}>{t("account.pendingTitle")}</h2>
              <p style={{ ...small, marginTop: 0 }}>{t("account.pendingDesc")}</p>
              {pending.map((a) => (
                <div key={a.kind} style={{ marginTop: 14 }}>
                  <strong>{a.title}</strong>
                  <span style={{ ...small, marginLeft: 6 }}>
                    {t("account.pendingVersion", { version: String(a.version) })}
                  </span>
                  <div style={{
                    marginTop: 6, maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap",
                    border: "1px solid var(--color-line)", borderRadius: 8, padding: 12,
                    fontSize: 13.5, lineHeight: 1.6,
                  }}>{a.body}</div>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, minHeight: 40 }}>
                    <input type="checkbox" checked={agreed[a.kind] === true}
                      onChange={(e) => setAgreed((m) => ({ ...m, [a.kind]: e.target.checked }))} />
                    {t("account.pendingAgree")}
                  </label>
                </div>
              ))}
              <button style={{ ...saveBtn, marginTop: 14 }}
                disabled={pending.some((a) => agreed[a.kind] !== true)}
                onClick={() => void acceptPending()}>
                {t("account.pendingSubmit")}
              </button>
            </section>
          )}

          {/* ── 내 활동 (플러그인이 선언한 회원 화면) ── */}
          {memberMenu.length > 0 && (
            <section style={card}>
              <h2 style={h2}>{t("account.myActivity")}</h2>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {memberMenu.map((m) => (
                  <a key={m.path} href={m.path}
                    style={{
                      padding: "9px 14px", borderRadius: 8, fontSize: 14, textDecoration: "none",
                      color: "inherit", border: "1px solid var(--color-line-strong)",
                    }}>
                    {m.label}
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* ── 기본 정보 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.profile")}</h2>
            <p style={{ margin: "0 0 4px", fontSize: 14 }}>
              {t("account.email")} — <strong>{me.email}</strong>{" "}
              {me.email_verified ? (
                <span style={{ color: "var(--color-success)", fontSize: 12.5 }}>✓ {t("account.emailVerified")}</span>
              ) : (
                <>
                  <span style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{t("account.emailUnverified")}</span>{" "}
                  <button style={{ ...small, border: 0, background: "none", color: "var(--color-primary-text)", cursor: "pointer", padding: 0 }}
                    onClick={() => call("/api/me/email/verify/send", { method: "POST", body: "{}" }, t("account.verifySent"))}>
                    {t("account.sendVerify")}
                  </button>
                </>
              )}
              {" · "}
              <button type="button" style={{ ...small, border: 0, background: "none", color: "var(--color-primary-text)", cursor: "pointer", padding: 0 }}
                aria-expanded={emailOpen} onClick={() => setEmailOpen((v) => !v)}>
                {t("account.changeEmail")}
              </button>
            </p>
            {emailOpen && (
              /* 이메일 변경 — 새 주소로 인증 메일을 보내고, 링크를 열어야 바뀐다 (탈취 세션만으로는 못 바꾼다) */
              <form style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "4px 0 8px" }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await call("/api/me/email/verify/send", { method: "POST", body: JSON.stringify({ email: newEmail }) }, t("account.changeEmailSent"))) {
                    setNewEmail(""); setEmailOpen(false);
                  }
                }}>
                <input type="email" required name="email" autoComplete="email"
                  value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                  placeholder={t("account.newEmail")} aria-label={t("account.newEmail")} style={{ fontSize: 14, padding: "6px 8px", minWidth: 240 }} />
                <button type="submit" style={{ ...small, cursor: "pointer" }}>{t("account.sendVerify")}</button>
                <span style={{ color: "var(--color-muted)", fontSize: 12.5, flexBasis: "100%" }}>{t("account.changeEmailHint")}</span>
              </form>
            )}
            {/* ── 프로필 이미지 — 글·댓글·헤더에 이름 옆에 보인다 ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "14px 0 4px" }}>
              {me.avatar_url ? (
                <img src={String(me.avatar_url)} alt="" style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--color-line)" }} />
              ) : (
                <span aria-hidden style={{ width: 56, height: 56, borderRadius: "50%", display: "grid", placeItems: "center",
                  background: "var(--color-primary-soft)", color: "var(--color-primary-text)", fontWeight: 800, fontSize: 22 }}>
                  {(me.display_name || "?").trim().slice(0, 1)}
                </span>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ ...authLabel, marginTop: 0 }}>{t("account.avatar")}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <label style={{ ...saveBtn, marginTop: 0, cursor: "pointer", display: "inline-block" }}>
                    {t("account.avatarChange")}
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
                      onChange={async (e) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        const fd = new FormData(); fd.append("file", f);
                        const r = await fetch("/api/me/avatar", { method: "POST", body: fd });
                        const d = await r.json().catch(() => ({}));
                        if (r.ok) { setNotice(t("account.avatarSaved")); load(); } else oops(d.message ?? t("account.fail"));
                        e.target.value = "";
                      }} />
                  </label>
                  {me.avatar_url && (
                    <button type="button" style={{ ...saveBtn, marginTop: 0, background: "transparent", color: "var(--color-text-soft)", border: "1px solid var(--color-line-strong)" }}
                      onClick={async () => { if (await call("/api/me/avatar", { method: "DELETE" }, t("account.saved"))) load(); }}>
                      {t("account.avatarRemove")}
                    </button>
                  )}
                </div>
                <span style={small}>{t("account.avatarHint")}</span>
              </div>
            </div>
            <form onSubmit={saveProfile}>
              <label style={authLabel}>{t("account.name")}
                <input style={authInput} required minLength={2} maxLength={30} value={name}
                  onChange={(e) => setName(e.target.value)} />
              </label>
              <span style={small}>{t("account.nameHint")}</span>
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
                  <input style={authInput} type="password" required
                    name="current-password" autoComplete="current-password" value={pw.current}
                    onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                </label>
                <label style={authLabel}>{t("account.newPassword")}
                  <input style={authInput} type="password" required minLength={8}
                    name="new-password" autoComplete="new-password" value={pw.next}
                    onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </label>
                <label style={authLabel}>{t("account.confirmPassword")}
                  <input style={authInput} type="password" required
                    name="confirm-password" autoComplete="new-password" value={pw.confirm}
                    onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
                </label>
                <button style={saveBtn}>{t("account.change")}</button>
              </form>
            </section>
          )}

          {/* ── 연결된 로그인 수단 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.identities")}</h2>
            <p style={{ ...small, marginTop: 0 }}>{t("account.identitiesDesc")}</p>
            {identities.length === 0 ? (
              <p style={small}>{t("account.identitiesEmpty")}</p>
            ) : (
              identities.map((it) => (
                <div key={it.provider} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--color-line)", fontSize: 14, flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 140 }}>
                    <strong>{it.label}</strong>
                    {it.email ? <span style={{ color: "var(--color-muted)" }}> · {it.email}</span> : null}
                    <span style={{ ...small, display: "block" }}>
                      {t("account.identityLinked", { date: new Date(it.created_at).toLocaleDateString(localeTag) })}
                    </span>
                  </span>
                  <button onClick={() => void unlinkIdentity(it)}
                    style={{ ...small, cursor: "pointer", minHeight: 36, padding: "0 12px", color: "var(--color-danger)" }}>
                    {t("account.identityUnlink")}
                  </button>
                </div>
              ))
            )}
            {me.password_login_enabled && providers.some((p) => !identities.some((i) => i.provider === p.name)) && (
              <div style={{ marginTop: 14 }}>
                <p style={{ ...small, marginTop: 0 }}>{t("account.identityAddNote")}</p>
                <label style={{ ...authLabel, marginTop: 0 }}>{t("account.identityPassword")}
                  <input style={authInput} type="password" name="current-password" autoComplete="current-password"
                    value={linkPw} onChange={(e) => setLinkPw(e.target.value)} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  {providers.filter((p) => !identities.some((i) => i.provider === p.name)).map((p) => (
                    <button key={p.name} disabled={!linkPw || linking === p.name}
                      onClick={() => { setLinking(p.name); void startLink(p.name); }}
                      style={{ ...small, cursor: "pointer", minHeight: 40, padding: "0 14px" }}>
                      {t("account.identityAdd", { label: p.label })}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ── 2단계 인증 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.totp")}</h2>
            <p style={{ ...small, marginTop: 0 }}>{t("account.totpDesc")}</p>

            {/* 강제 설정이 켜졌는데 아직 등록하지 않았다면, 관리 화면이 막혀 있다 */}
            {staff2fa && !totp?.enabled && (
              <p role="alert" data-testid="brick-totp-required" style={{
                margin: "0 0 12px", padding: "10px 12px", fontSize: 13.5, borderRadius: 10,
                background: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-danger) 34%, transparent)",
              }}>{t("account.totpRequired")}</p>
            )}

            {/* 복구 코드 — 지금 한 번만 보인다 */}
            {recovery.length > 0 && (
              <div role="alert" data-testid="brick-totp-codes" style={{
                margin: "0 0 14px", padding: "12px 14px", borderRadius: 10,
                background: "var(--color-bg-soft)", border: "1px solid var(--color-line-strong)",
              }}>
                <strong style={{ fontSize: 14 }}>{t("account.totpCodesTitle")}</strong>
                <p style={{ ...small, margin: "6px 0 10px" }}>{recoveryNote || t("account.totpCodesWarn")}</p>
                <ul style={{
                  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                  gap: 6, margin: 0, padding: 0, listStyle: "none",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14,
                }}>
                  {recovery.map((c) => <li key={c}>{c}</li>)}
                </ul>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button type="button" onClick={() => void copy(recovery.join("\n"))}
                    style={{ ...small, cursor: "pointer", minHeight: 36, padding: "0 14px" }}>
                    {t("account.totpCopy")}
                  </button>
                  <button type="button" onClick={() => setRecovery([])}
                    style={{ ...small, cursor: "pointer", minHeight: 36, padding: "0 14px" }}>
                    {t("account.totpCodesKept")}
                  </button>
                </div>
              </div>
            )}

            {totp?.enabled ? (
              <>
                <p style={{ margin: "0 0 4px", fontSize: 14, color: "var(--color-success)" }}>
                  {totp.enabledAt
                    ? t("account.totpOnSince", { date: new Date(totp.enabledAt).toLocaleDateString(localeTag) })
                    : t("account.totpOn")}
                </p>
                <p style={{ ...small, margin: "0 0 10px" }}>
                  {t("account.totpCodesLeft", { count: String(totp.recoveryCodesLeft) })}
                </p>
                {/* 다 쓰고 나서 알면 늦는다 — 휴대폰을 잃었을 때 쓸 것이 없다 */}
                {totp.recoveryCodesLeft <= 2 && (
                  <p role="alert" style={{ ...small, color: "var(--color-danger)", marginTop: 0 }}>
                    {t("account.totpCodesLow")}
                  </p>
                )}
                <label style={{ ...authLabel, marginTop: 0 }}>{t("account.currentPassword")}
                  <input style={authInput} type="password" name="current-password" autoComplete="current-password"
                    value={totpPw} onChange={(e) => setTotpPw(e.target.value)} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button type="button" disabled={!totpPw} onClick={() => void regenRecovery()}
                    style={{ ...small, cursor: "pointer", minHeight: 40, padding: "0 14px" }}>
                    {t("account.totpRegen")}
                  </button>
                  {/* 강제 설정이 켜져 있으면 서버가 거절한다 — 누를 수 있게 두면 거짓말이다 */}
                  <button type="button" disabled={!totpPw || staff2fa} onClick={() => void disableTotp()}
                    style={{ ...small, cursor: "pointer", minHeight: 40, padding: "0 14px", color: "var(--color-danger)" }}>
                    {t("account.totpDisable")}
                  </button>
                </div>
                {staff2fa && <p style={{ ...small, marginBottom: 0 }}>{t("account.totpCannotDisable")}</p>}
              </>
            ) : enroll ? (
              <form onSubmit={completeTotp}>
                <ol style={{ margin: "0 0 14px", paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
                  <li>{t("account.totpStep1")}</li>
                  <li>
                    {t("account.totpStep2")}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
                      {/* 손으로 옮겨 적는 값이라 4자씩 끊어 준다 */}
                      <code data-testid="brick-totp-secret" style={{
                        flex: "1 1 220px", padding: "8px 10px", borderRadius: 8, wordBreak: "break-all",
                        background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14,
                      }}>{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                      <button type="button" onClick={() => void copy(enroll.secret)}
                        style={{ ...small, cursor: "pointer", minHeight: 36, padding: "0 14px" }}>
                        {t("account.totpCopy")}
                      </button>
                    </div>
                    {/* 휴대폰에서는 이 링크가 인증 앱을 바로 연다 */}
                    <a href={enroll.otpauthUri} style={{ ...small, textDecoration: "underline" }}>
                      {t("account.totpOpenApp")}
                    </a>
                  </li>
                  <li>{t("account.totpStep3")}</li>
                </ol>
                <label style={{ ...authLabel, marginTop: 0 }}>{t("account.totpCode")}
                  <input style={authInput} required inputMode="numeric" autoComplete="one-time-code"
                    pattern="[0-9]*" maxLength={6} value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style={saveBtn}>{t("account.totpTurnOn")}</button>
                  <button type="button" onClick={() => { setEnroll(null); setTotpCode(""); }}
                    style={{ ...saveBtn, background: "var(--color-bg)", color: "var(--color-text)", border: "1px solid var(--color-line-strong)" }}>
                    {t("account.totpCancel")}
                  </button>
                </div>
              </form>
            ) : me.password_login_enabled ? (
              <form onSubmit={beginTotp}>
                <p style={{ ...small, marginTop: 0 }}>{t("account.totpOff")}</p>
                <label style={{ ...authLabel, marginTop: 0 }}>{t("account.currentPassword")}
                  <input style={authInput} type="password" required name="current-password"
                    autoComplete="current-password" value={totpPw}
                    onChange={(e) => setTotpPw(e.target.value)} />
                </label>
                <button style={saveBtn}>{t("account.totpStart")}</button>
              </form>
            ) : (
              /* 등록은 비밀번호 재확인을 요구한다 — 소셜 전용 계정은 켤 수 없다 */
              <p style={small}>{t("account.totpNeedPassword")}</p>
            )}
          </section>

          {/* ── 접속 중인 기기 ── */}
          <section style={card}>
            <h2 style={h2}>{t("account.sessions")}</h2>
            {sessions.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--color-line)", fontSize: 14 }}>
                <span style={{ flex: 1 }}>
                  {s.device}{" "}
                  {s.isCurrent && <em style={{ fontStyle: "normal", color: "var(--color-success)", fontSize: 12.5 }}>· {t("account.sessionCurrent")}</em>}
                  <br />
                  <span style={small}>{t("account.lastSeen")}: {new Date(s.lastSeenAt ?? s.createdAt).toLocaleString(localeTag)}</span>
                </span>
                {/* 27px 였다 — 기기를 끊는 버튼은 잘못 눌러도, 못 눌러도 곤란하다 */}
                {!s.isCurrent && (
                  <button style={{ ...small, border: "1px solid var(--color-line)", background: "var(--color-bg)", borderRadius: 7, padding: "0 12px", minHeight: 32, cursor: "pointer" }}
                    onClick={() => revokeSession(s.id)}>
                    {t("account.sessionRevoke")}
                  </button>
                )}
              </div>
            ))}
            {sessions.length > 1 && (
              <button style={{ ...saveBtn, background: "var(--color-bg)", color: "var(--color-danger)", border: "1px solid color-mix(in srgb, var(--color-danger) 34%, transparent)" }} onClick={revokeOthers}>
                {t("account.sessionRevokeOthers")}
              </button>
            )}
          </section>

          {/* ── 탈퇴 ── */}
          <section style={{ ...card, borderColor: "color-mix(in srgb, var(--color-danger) 34%, transparent)" }}>
            <h2 style={{ ...h2, color: "var(--color-danger)" }}>{t("account.withdraw")}</h2>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "var(--color-muted)" }}>{t("account.withdrawDesc")}</p>
            {losses.length > 0 && (
              <details style={{ fontSize: 13.5, marginBottom: 10 }}>
                <summary style={{ cursor: "pointer" }}>{t("account.withdrawLosses")}</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--color-muted)" }}>
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
                  <input style={authInput} type="password" required
                    name="current-password" autoComplete="current-password" value={withdraw.password}
                    onChange={(e) => setWithdraw({ ...withdraw, password: e.target.value })} />
                </label>
              ) : (
                <label style={authLabel}>{t("account.withdrawConfirmPhrase")}
                  <input style={authInput} required value={withdraw.confirm}
                    onChange={(e) => setWithdraw({ ...withdraw, confirm: e.target.value })} />
                </label>
              )}
              <button style={{ ...saveBtn, background: "var(--color-danger)" }}>{t("account.withdrawButton")}</button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
