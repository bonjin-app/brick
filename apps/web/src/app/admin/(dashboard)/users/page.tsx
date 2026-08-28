"use client";

import { useCallback, useEffect, useState } from "react";

interface UserRow {
  id: string; email: string; displayName: string;
  role: string; isActive: boolean; createdAt: string;
}

const ROLE_LABEL: Record<string, string> = { admin: "관리자", manager: "운영자", member: "회원" };

export default function AdminUsersPage() {
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
      setReauthError((await res.json()).message ?? "확인에 실패했습니다.");
      return;
    }
    setPassword("");
    setReauthError("");
    reload();
  }

  if (needReauth) {
    return (
      <div style={{ maxWidth: 420 }}>
        <h1>회원</h1>
        <div style={{ background: "#fff", borderRadius: 8, padding: 24 }}>
          <p style={{ marginTop: 0 }}>
            회원 개인정보를 보는 화면입니다. <strong>비밀번호를 다시 확인</strong>해주세요.
            (10분간 유지됩니다)
          </p>
          <form onSubmit={submitReauth} style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호"
              autoFocus
              style={{ flex: 1, padding: 8 }}
            />
            <button type="submit" style={{ padding: "8px 16px", cursor: "pointer" }}>확인</button>
          </form>
          {reauthError && <p style={{ color: "#c00" }}>{reauthError}</p>}
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
    setMessage(res.ok ? "변경되었습니다." : `실패: ${(await res.json()).message}`);
    reload();
  }

  return (
    <div>
      <h1>회원 <span style={{ color: "#999", fontSize: 16 }}>{data.total}명</span></h1>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <table style={{ width: "100%", background: "#fff", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th style={{ padding: 12 }}>이름</th><th>이메일</th><th>권한</th><th>상태</th><th>가입일</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
              <td style={{ padding: 12 }}><strong>{u.displayName}</strong></td>
              <td>{u.email}</td>
              <td>
                <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                  {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </td>
              <td>
                <button onClick={() => patch(u.id, { isActive: !u.isActive })} style={{ cursor: "pointer" }}>
                  {u.isActive ? "🟢 활성" : "🔴 정지"}
                </button>
              </td>
              <td style={{ color: "#999", fontSize: 13 }}>{new Date(u.createdAt).toLocaleDateString("ko-KR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
        본인 계정의 권한과 활성 상태는 변경할 수 없습니다 (관리자 전멸 방지).
      </p>
    </div>
  );
}
