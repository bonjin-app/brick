"use client";

import { useCallback, useEffect, useState } from "react";

interface AuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  ip: string | null;
  createdAt: string;
}

/** 감사 로그 — 누가 언제 무엇을 바꿨는가 */
const ACTION_LABEL: Record<string, string> = {
  "page.create": "페이지 생성",
  "page.update": "페이지 수정",
  "page.delete": "페이지 삭제",
  "user.register": "회원가입",
  "user.role_change": "권한 변경",
  "user.status_change": "계정 상태 변경",
  "plugin.install": "플러그인 설치",
  "plugin.activate": "플러그인 활성화",
  "plugin.deactivate": "플러그인 비활성화",
  "theme.install": "테마 설치",
  "theme.activate": "테마 적용",
  "settings.update": "설정 변경",
  "menu.update": "메뉴 변경",
  "auth.password_reset_requested": "비밀번호 재설정 요청",
  "auth.password_reset_completed": "비밀번호 재설정 완료",
};

/** 주의가 필요한 동작은 눈에 띄게 */
const SENSITIVE = new Set(["user.role_change", "user.status_change", "plugin.install", "theme.install"]);

export default function AdminAuditPage() {
  const [data, setData] = useState<{ items: AuditRow[]; total: number }>({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");

  const reload = useCallback(() => {
    const q = new URLSearchParams({ page: String(page), ...(filter ? { action: filter } : {}) });
    fetch(`/api/audit?${q}`).then((r) => r.json()).then(setData);
  }, [page, filter]);
  useEffect(reload, [reload]);

  return (
    <div>
      <h1>감사 로그 <span style={{ color: "#999", fontSize: 15 }}>{data.total}건</span></h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        관리 동작의 이력입니다. 180일이 지난 기록은 자동으로 정리됩니다.
      </p>
      <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}
        style={{ padding: 8, marginBottom: 16 }}>
        <option value="">전체 동작</option>
        {Object.entries(ACTION_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
              <th style={{ padding: 12 }}>시각</th><th>행위자</th><th>동작</th><th>대상</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #f4f4f7" }}>
                <td style={{ padding: 12, whiteSpace: "nowrap", color: "#666" }}>
                  {new Date(r.createdAt).toLocaleString("ko-KR")}
                </td>
                <td>{r.actorEmail ?? <span style={{ color: "#aaa" }}>시스템</span>}</td>
                <td style={SENSITIVE.has(r.action) ? { color: "#c0392b", fontWeight: 600 } : undefined}>
                  {ACTION_LABEL[r.action] ?? r.action}
                </td>
                <td style={{ color: "#555" }}>{r.summary ?? r.targetId ?? "-"}</td>
                <td style={{ color: "#999", fontSize: 13 }}>{r.ip ?? "-"}</td>
              </tr>
            ))}
            {!data.items.length && (
              <tr><td colSpan={5} style={{ padding: 24, color: "#999" }}>기록이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data.total > data.items.length && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ cursor: "pointer" }}>← 이전</button>
          <span style={{ fontSize: 13, color: "#666" }}>{page} 페이지</span>
          <button disabled={!data.items.length} onClick={() => setPage(page + 1)} style={{ cursor: "pointer" }}>다음 →</button>
        </div>
      )}
    </div>
  );
}
