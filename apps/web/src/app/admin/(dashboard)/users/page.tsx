"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

interface UserRow {
  id: string; email: string; displayName: string;
  role: string; isActive: boolean; createdAt: string; adminMemo?: string | null;
  /** 운영자의 관리 화면 범위 — null 이면 전부 */
  adminScopes?: string[] | null;
}

interface AreaGroup { key: string; title: string; areas: Array<{ key: string; title: string }> }

const ROLES = ["admin", "manager", "member"] as const;

export default function AdminUsersPage() {
  const localeTag = useLocaleTag();
  const t = useAdminT();
  const [data, setData] = useState<{ items: UserRow[]; total: number }>({ items: [], total: 0 });
  const [message, setMessage] = useState("");
  /* 성공과 실패가 같은 자리를 쓴다 — 색과 role 도 결과를 따라야 한다(문구로 판별하지 않는다) */
  const [failed, setFailed] = useState(false);
  // 회원 목록은 개인정보(이메일) 열람이라 최근 10분 내 비밀번호 재확인이 필요하다.
  // 서버가 code: "reauth_required" 를 주면 비밀번호 창을 띄운다.
  const [needReauth, setNeedReauth] = useState(false);
  const [password, setPassword] = useState("");
  const [reauthError, setReauthError] = useState("");
  /*
   * 검색 — 입력칸과 **보낸 값**을 나눈다.
   * 한 글자마다 목록을 다시 받으면 회원 만 명짜리 표를 여섯 번 훑는다.
   */
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  /*
   * 운영자 권한 범위 — "이 운영자는 주문만". 운영자 줄의 버튼을 누르면 아래에 편집 칸이 열린다.
   * 역할이 세 단계뿐이라 주문 담당에게 상품 가격·쿠폰 권한까지 줘야 했던 것을 좁힌다.
   */
  const [areas, setAreas] = useState<AreaGroup[]>([]);
  const [scopeUser, setScopeUser] = useState<UserRow | null>(null);
  const [scopeAll, setScopeAll] = useState(true);
  const [scopePicked, setScopePicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch("/api/admin/areas").then((r) => (r.ok ? r.json() : { plugins: [] }))
      .then((d) => setAreas(d.plugins ?? [])).catch(() => {});
  }, []);
  function openScopes(u: UserRow) {
    setScopeUser(u);
    setScopeAll(!Array.isArray(u.adminScopes));
    setScopePicked(new Set(Array.isArray(u.adminScopes) ? u.adminScopes : []));
  }
  function togglePick(key: string, on: boolean) {
    setScopePicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }
  const scopeSummary = (u: UserRow) =>
    !Array.isArray(u.adminScopes) ? t("users.scopeAll") : t("users.scopeN", { n: u.adminScopes.length });

  const reload = useCallback(() => {
    const qs = search ? `?q=${encodeURIComponent(search)}` : "";
    fetch(`/api/users${qs}`).then(async (r) => {
      const json = await r.json();
      if (r.status === 403 && json?.code === "reauth_required") {
        setNeedReauth(true);
        return;
      }
      setNeedReauth(false);
      setData(json);
    });
  }, [search]);
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
          {reauthError && <p role="alert" style={{ color: "var(--color-danger)" }}>{reauthError}</p>}
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
    setFailed(!res.ok);
    setMessage(res.ok ? t("users.changed") : `${t("common.failPrefix")}${(await res.json()).message}`);
    reload();
  }

  return (
    <div>
      <h1>{t("users.title")} <span style={{ color: "var(--color-muted)", fontSize: 16 }}>{t("users.countN", { n: data.total })}</span></h1>
      {message && (
        <p role={failed ? "alert" : "status"}
          style={{ color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
      )}
      {/*
        검색 — 회원이 만 명인 사이트에서 "김철수" 를 찾으려면 서른 명씩 삼백 쪽을
        넘겨야 했다. 운영자가 이 화면을 여는 이유는 대개 한 사람을 찾기 위해서다.
      */}
      <form
        style={{ display: "flex", gap: 6, margin: "0 0 12px" }}
        onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("users.searchPlaceholder")}
          aria-label={t("x.search")}
          style={{ flex: "0 1 320px", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--color-line-strong)" }}
        />
        <button type="submit" style={{ padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}>{t("x.search")}</button>
        {search && (
          <button type="button" style={{ padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}
            onClick={() => { setQuery(""); setSearch(""); }}>{t("x.searchClear")}</button>
        )}
      </form>
      {search && data.items.length === 0 && (
        <p style={{ color: "var(--color-muted)" }}>{t("x.emptySearch")}</p>
      )}
      {/*
        좁은 화면에서는 카드로 접힌다 (관리 셸의 .brick-x-table).
        이 표에는 역할 선택·정지 버튼·운영 메모가 있고 메모 칸만 200px 을 쓴다 —
        접지 않으면 폰에서 이름 말고는 아무것도 닿지 않는다.
      */}
      <table className="brick-x-table" style={{ width: "100%", background: "var(--color-bg)", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
            <th style={{ padding: 12 }}>{t("common.name")}</th><th>{t("common.email")}</th><th>{t("users.role")}</th><th>{t("common.status")}</th><th>{t("users.memo")}</th><th>{t("users.colJoined")}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--color-line)" }}>
              <td data-label={t("common.name")} style={{ padding: 12 }}><strong>{u.displayName}</strong></td>
              <td data-label={t("common.email")}>{u.email}</td>
              <td data-label={t("users.role")}>
                <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                  {ROLES.map((v) => <option key={v} value={v}>{t(v === "admin" ? "users.roleAdmin" : v === "manager" ? "users.roleManager" : "users.roleMember")}</option>)}
                </select>
                {u.role === "manager" && (
                  <button type="button" className="btn-link" style={{ display: "block", marginTop: 4, fontSize: 12.5 }}
                    aria-label={t("users.scopeEditFor", { name: u.displayName })}
                    onClick={() => openScopes(u)}>
                    {t("users.scopeLabel")}: {scopeSummary(u)}
                  </button>
                )}
              </td>
              <td data-label={t("common.status")}>
                <button onClick={() => patch(u.id, { isActive: !u.isActive })} style={{ cursor: "pointer" }}>
                  {u.isActive ? t("users.active") : t("users.suspended")}
                </button>
              </td>
              <td data-label={t("users.memo")} style={{ padding: "6px 8px 6px 0", minWidth: 200 }}>
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
              <td data-label={t("users.colJoined")} style={{ color: "var(--color-muted)", fontSize: 13 }}>{new Date(u.createdAt).toLocaleDateString(localeTag)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--color-muted)", fontSize: 13, marginTop: 12 }}>
        {t("users.selfNote")}
      </p>

      {scopeUser && (
        <section aria-labelledby="scope-title"
          style={{ background: "var(--color-bg)", borderRadius: 8, padding: 20, marginTop: 16, maxWidth: 720 }}>
          <h2 id="scope-title" style={{ fontSize: 17, margin: "0 0 6px" }}>{t("users.scopeTitle", { name: scopeUser.displayName })}</h2>
          <p style={{ margin: "0 0 12px", color: "var(--color-text-soft)", fontSize: 13.5 }}>{t("users.scopeHint")}</p>
          <label style={{ display: "block", margin: "6px 0" }}>
            <input type="radio" name="scope-mode" checked={scopeAll} onChange={() => setScopeAll(true)} /> {t("users.scopeModeAll")}
          </label>
          <label style={{ display: "block", margin: "6px 0 12px" }}>
            <input type="radio" name="scope-mode" checked={!scopeAll} onChange={() => setScopeAll(false)} /> {t("users.scopeModePick")}
          </label>
          {!scopeAll && (
            <div style={{ display: "grid", gap: 14, marginBottom: 14 }}>
              {areas.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>{t("users.scopeNone")}</p>}
              {areas.map((g) => (
                <fieldset key={g.key} style={{ border: "1px solid var(--color-line)", borderRadius: 6, padding: "8px 12px" }}>
                  <legend style={{ fontWeight: 600, fontSize: 14 }}>
                    <label>
                      <input type="checkbox" checked={scopePicked.has(g.key)} onChange={(e) => togglePick(g.key, e.target.checked)} />{" "}
                      {g.title} — {t("users.scopeWhole")}
                    </label>
                  </legend>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
                    {g.areas.map((a) => (
                      <label key={a.key} style={{ fontSize: 13.5, minHeight: 32, display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" disabled={scopePicked.has(g.key)}
                          checked={scopePicked.has(g.key) || scopePicked.has(a.key)}
                          onChange={(e) => togglePick(a.key, e.target.checked)} />
                        {a.title}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" type="button"
              onClick={async () => {
                await patch(scopeUser.id, { adminScopes: scopeAll ? null : [...scopePicked] });
                setScopeUser(null);
              }}>{t("users.scopeSave")}</button>
            <button type="button" className="btn-link" onClick={() => setScopeUser(null)}>{t("common.cancel")}</button>
          </div>
        </section>
      )}
    </div>
  );
}
