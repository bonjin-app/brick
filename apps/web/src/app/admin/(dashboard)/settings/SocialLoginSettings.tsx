"use client";

import { useCallback, useEffect, useState } from "react";

interface ProviderRow {
  name: string;
  label: string;
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  /** 공급자 콘솔에 붙여넣을 값 — 이걸 못 찾아 헤매는 것이 설정의 실제 난관이다 */
  redirectUri: string;
  /** 사내 SSO처럼 주소를 직접 넣어야 하는 공급자 */
  needsUrls: boolean;
  authUrl: string;
  tokenUrl: string;
  profileUrl: string;
}

/**
 * 소셜 로그인 설정.
 *
 * Client Secret은 저장 후 되읽지 않는다(서버가 내려주지 않는다).
 * 비워둔 채 저장하면 "변경하지 않음"으로 처리되므로, 사용 여부만 바꿀 때
 * 비밀키를 다시 입력할 필요가 없다.
 */
export function SocialLoginSettings() {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const reload = useCallback(() => {
    fetch("/api/auth/oauth/admin/providers")
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d.items) ? d.items : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(reload, [reload]);

  async function save(row: ProviderRow) {
    const res = await fetch(`/api/auth/oauth/admin/providers/${row.name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: row.enabled,
        clientId: row.clientId,
        clientSecret: secrets[row.name] ?? "",
        ...(row.needsUrls
          ? { authUrl: row.authUrl, tokenUrl: row.tokenUrl, profileUrl: row.profileUrl }
          : {}),
      }),
    });
    if (res.ok) {
      setMessage(`${row.label} 설정을 저장했습니다.`);
      setSecrets({ ...secrets, [row.name]: "" });
      reload();
    } else {
      setMessage(`실패: ${(await res.json()).message}`);
    }
  }

  const input = { width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" as const };
  const mono = { fontFamily: "ui-monospace, monospace", fontSize: 12 };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, maxWidth: 720, marginTop: 24 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>소셜 로그인</h2>
      <p style={{ fontSize: 13, color: "#777", marginTop: 0 }}>
        각 공급자의 개발자 콘솔에서 앱을 만들고, 아래 <b>Redirect URI</b>를 그대로 등록하세요.
        Client Secret은 저장 후 다시 볼 수 없습니다 (비워두면 기존 값을 유지합니다).
      </p>

      {rows.map((row) => (
        <div
          key={row.name}
          style={{ borderTop: "1px solid #eee", paddingTop: 16, marginTop: 16 }}
        >
          <label style={{ fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={row.enabled}
              onChange={(e) =>
                setRows(rows.map((r) => (r.name === row.name ? { ...r, enabled: e.target.checked } : r)))
              }
            />{" "}
            {row.label}
            {row.hasSecret && (
              <span style={{ marginLeft: 8, fontSize: 11, color: "#0a7", fontWeight: 400 }}>
                비밀키 저장됨
              </span>
            )}
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
            <label style={{ fontSize: 13 }}>
              Client ID
              <input
                style={{ ...input, ...mono }}
                value={row.clientId}
                onChange={(e) =>
                  setRows(rows.map((r) => (r.name === row.name ? { ...r, clientId: e.target.value } : r)))
                }
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Client Secret
              <input
                style={{ ...input, ...mono }}
                type="password"
                autoComplete="new-password"
                placeholder={row.hasSecret ? "변경할 때만 입력" : ""}
                value={secrets[row.name] ?? ""}
                onChange={(e) => setSecrets({ ...secrets, [row.name]: e.target.value })}
              />
            </label>
          </div>

          {row.needsUrls && (
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              <p style={{ fontSize: 12, color: "#777", margin: 0 }}>
                표준 OpenID Connect 서버(Keycloak · Authentik · Azure AD · Okta 등)의 주소를 넣으세요.
                보통 공급자의 <code style={mono}>/.well-known/openid-configuration</code> 에 적혀 있습니다.
              </p>
              {([
                ["authUrl", "인증 주소 (authorization_endpoint)"],
                ["tokenUrl", "토큰 주소 (token_endpoint)"],
                ["profileUrl", "사용자 정보 주소 (userinfo_endpoint)"],
              ] as const).map(([field, label]) => (
                <label key={field} style={{ fontSize: 13 }}>
                  {label}
                  <input
                    style={{ ...input, ...mono }}
                    value={row[field]}
                    onChange={(e) =>
                      setRows(
                        rows.map((r) => (r.name === row.name ? { ...r, [field]: e.target.value } : r)),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          )}

          <p style={{ fontSize: 12, color: "#666", margin: "10px 0 0" }}>
            Redirect URI <code style={mono}>{row.redirectUri}</code>
          </p>

          <button
            onClick={() => save(row)}
            style={{ cursor: "pointer", padding: "7px 16px", marginTop: 10, fontSize: 13 }}
          >
            {row.label} 저장
          </button>
        </div>
      ))}
      {message && <p style={{ color: "#0a7", marginBottom: 0 }}>{message}</p>}
    </div>
  );
}
