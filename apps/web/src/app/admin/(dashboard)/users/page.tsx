"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface UserRow {
  id: string; email: string; displayName: string;
  role: string; isActive: boolean; createdAt: string; adminMemo?: string | null;
}

const ROLES = ["admin", "manager", "member"] as const;

export default function AdminUsersPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ items: UserRow[]; total: number }>({ items: [], total: 0 });
  const [message, setMessage] = useState("");
  // 회원 목록은 개인정보(이메일) 열람이라 최근 10분 내 비밀번호 재확인이 필요하다.
  // 서버가 code: "reauth_required" 를 주면 비밀번호 창을 띄운다.
  const [needReauth, setNeedReauth] = useState(false);
  const [password, setPassword] = useState("");
  const [reauthError, setReauthError] = useState("");

  const reload = useCallback(() => {
    fetch("/api/users").then(async (r) => {
      const json = await r.json();
      if (r.status === 403 && json?.code === "reauth_required") {
        setNeedReauth(true);
        return;
      }
      setNeedReauth(false);
      setData(json);
    });
  }, []);
  useEffect(reload, [reload]);

  async function submitReauth(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/me/security/reauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setReauthError((await res.json()).message ?? t("users.reauthFail"));
      return;
    }
    setPassword("");
    setReauthError("");
    reload();
  }

  if (needReauth) {
    return (
      <div style={{ maxWidth: 420 }}>
        <h1>{t("users.title")}</h1>
        <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 24 }}>
          <p style={{ marginTop: 0 }}>
            {t("users.reauthNotice")} {t("users.reauthKeep")}
          </p>
          <form onSubmit={submitReauth} style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("common.password")}
              autoFocus
              style={{ flex: 1, padding: 8 }}
            />
            <button type="submit" style={{ padding: "8px 16px", cursor: "pointer" }}>{t("common.confirm")}</button>
          </form>
          {reauthError && <p style={{ color: "var(--color-danger)" }}>{reauthError}</p>}
        </div>
      </div>
    );
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/users/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setMessage(res.ok ? t("users.changed") : `${t("common.failPrefix")}${(await res.json()).message}`);
    reload();
  }

  return (
    <div>
      <h1>{t("users.title")} <span style={{ color: "var(--color-muted)", fontSize: 16 }}>{t("users.countN", { n: data.total })}</span></h1>
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}
      <table style={{ width: "100%", background: "var(--color-bg)", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
            <th style={{ padding: 12 }}>{t("common.name")}</th><th>{t("common.email")}</th><th>{t("users.role")}</th><th>{t("common.status")}</th><th>{t("users.memo")}</th><th>{t("users.colJoined")}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--color-line)" }}>
              <td style={{ padding: 12 }}><strong>{u.displayName}</strong></td>
              <td>{u.email}</td>
              <td>
                <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                  {ROLES.map((v) => <option key={v} value={v}>{t(v === "admin" ? "users.roleAdmin" : v === "manager" ? "users.roleManager" : "users.roleMember")}</option>)}
                </select>
              </td>
              <td>
                <button onClick={() => patch(u.id, { isActive: !u.isActive })} style={{ cursor: "pointer" }}>
                  {u.isActive ? t("users.active") : t("users.suspended")}
                </button>
              </td>
              <td style={{ padding: "6px 8px 6px 0", minWidth: 200 }}>
                {/* 회원에게 보이지 않는 운영 메모 — 포커스를 벗어나면 저장한다 */}
                <textarea
                  key={u.id + (u.adminMemo ?? "")}
                  defaultValue={u.adminMemo ?? ""}
                  placeholder={t("users.memoPlaceholder")}
                  rows={1}
                  maxLength={2000}
                  aria-label={t("users.memo")}
                  onBlur={(e) => { if (e.target.value.trim() !== (u.adminMemo ?? "")) patch(u.id, { adminMemo: e.target.value }); }}
                  style={{ width: "100%", fontSize: 13, resize: "vertical", minHeight: 32 }}
                />
              </td>
              <td style={{ color: "var(--color-muted)", fontSize: 13 }}>{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--color-muted)", fontSize: 13, marginTop: 12 }}>
        {t("users.selfNote")}
      </p>
    </div>
  );
}
