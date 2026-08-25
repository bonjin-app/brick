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

  const reload = useCallback(() => {
    fetch("/api/users").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

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
