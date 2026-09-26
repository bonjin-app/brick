"use client";

/**
 * 관리자 → 본인인증 — **어디서 인증을 받고, 얼마나 쓰고 있나.**
 *
 * 본인인증을 요구하는 곳이 흩어져 있었다(사이트 설정의 셋, 쇼핑몰의 성인 상품, 게시판마다의 요구). 건당 요금이
 * 나가는 기능인데 한 화면에서 볼 수 없었다. 여기서 모아 보여 주고, 고치는 곳으로 보낸다 — 이 화면에서 설정을
 * 바꾸지는 않는다(설정마다 이미 제자리가 있고, 두 곳에서 바꾸게 하면 어느 쪽이 맞는지 헷갈린다).
 */
import { useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface Overview {
  providers: Array<{ name: string; plugin: string; displayName: string }>;
  settings: { required: boolean; signup: boolean; onePerson: boolean };
  purposes: Array<{ plugin: string; key: string; label: string; count: number | null; detail: string; manageUrl: string | null; failed?: boolean }>;
  usage: {
    days: number; requests: number; verified: number; failed: number; open: number;
    member: number; guest: number; certified: number;
    daily: Array<{ date: string; requests: number; verified: number }>;
  };
}

const card = { background: "var(--color-bg)", borderRadius: 8, padding: 16, marginBottom: 16 } as const;
const cell = { padding: "8px 10px", borderBottom: "1px solid var(--color-line)", textAlign: "left" as const };

export default function AdminIdentityPage() {
  const t = useAdminT();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/identity/overview")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).message ?? String(r.status)))))
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p role="alert" style={{ color: "var(--color-danger)" }}>{t("idv.loadFail", { msg: error })}</p>;
  if (!data) return <p>{t("nav.checking")}</p>;

  const ready = data.providers.length > 0;
  const onOff = (on: boolean) => (
    <strong style={{ color: on ? "var(--color-success)" : "var(--color-muted)" }}>{on ? t("idv.on") : t("idv.off")}</strong>
  );
  // 켜 두었어도 수단이 없으면 강제하지 않는다 — 켰는데 왜 안 막히나를 여기서 답한다
  const idle = (on: boolean) => (on && !ready ? <span style={{ color: "var(--color-danger)", fontSize: 12.5, marginLeft: 6 }}>{t("idv.idle")}</span> : null);
  const u = data.usage;

  return (
    <div>
      <h1>{t("idv.title")}</h1>
      <p style={{ color: "var(--color-muted)", marginTop: -4 }}>{t("idv.desc")}</p>

      <section style={card} aria-labelledby="idv-providers">
        <h2 id="idv-providers" style={{ fontSize: 16, marginTop: 0 }}>{t("idv.providers")}</h2>
        {ready ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.providers.map((p) => <li key={p.name}>{p.displayName} <span style={{ color: "var(--color-muted)", fontSize: 12.5 }}>({p.plugin})</span></li>)}
          </ul>
        ) : (
          <p style={{ margin: 0 }}>{t("idv.noProvider")} <a href="/admin/plugins">{t("idv.goPlugins")}</a></p>
        )}
      </section>

      <section style={card} aria-labelledby="idv-where">
        <h2 id="idv-where" style={{ fontSize: 16, marginTop: 0 }}>{t("idv.where")}</h2>
        <div style={{ overflowX: "auto" }}>
          {/* 좁은 화면에서는 카드로 접힌다 (관리 셸의 .brick-x-table) */}
          <table className="brick-x-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr><th style={cell}>{t("idv.colPurpose")}</th><th style={cell}>{t("idv.colState")}</th><th style={cell}>{t("idv.colManage")}</th></tr></thead>
            <tbody>
              <tr><td data-label={t("idv.colPurpose")} style={cell}>{t("idv.required")}</td><td data-label={t("idv.colState")} style={cell}>{onOff(data.settings.required)}{idle(data.settings.required)}</td><td data-label={t("idv.colManage")} style={cell}><a href="/admin/settings">{t("idv.goSettings")}</a></td></tr>
              <tr><td data-label={t("idv.colPurpose")} style={cell}>{t("idv.signup")}</td><td data-label={t("idv.colState")} style={cell}>{onOff(data.settings.signup)}{idle(data.settings.signup)}</td><td data-label={t("idv.colManage")} style={cell}><a href="/admin/settings">{t("idv.goSettings")}</a></td></tr>
              <tr><td data-label={t("idv.colPurpose")} style={cell}>{t("idv.onePerson")}</td><td data-label={t("idv.colState")} style={cell}>{onOff(data.settings.onePerson)}</td><td data-label={t("idv.colManage")} style={cell}><a href="/admin/settings">{t("idv.goSettings")}</a></td></tr>
              {data.purposes.map((p) => (
                <tr key={`${p.plugin}/${p.key}`}>
                  <td data-label={t("idv.colPurpose")} style={cell}>{p.label} <span style={{ color: "var(--color-muted)", fontSize: 12.5 }}>({p.plugin})</span></td>
                  <td data-label={t("idv.colState")} style={cell}>
                    {p.failed ? <span role="status" style={{ color: "var(--color-danger)" }}>{t("idv.unknown")}</span>
                      : <>{onOff((p.count ?? 0) > 0)} <span style={{ fontSize: 13 }}>{p.detail}</span></>}
                  </td>
                  <td data-label={t("idv.colManage")} style={cell}>{p.manageUrl ? <a href={p.manageUrl}>{t("idv.goManage")}</a> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={card} aria-labelledby="idv-usage">
        <h2 id="idv-usage" style={{ fontSize: 16, marginTop: 0 }}>{t("idv.usage", { days: u.days })}</h2>
        <p style={{ margin: "0 0 10px", fontSize: 14 }}>
          {t("idv.usageLine", { requests: u.requests, verified: u.verified, failed: u.failed, open: u.open, member: u.member, guest: u.guest })}
        </p>
        <p style={{ margin: "0 0 10px", fontSize: 14 }}>{t("idv.certified", { n: u.certified })}</p>
        {u.daily.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className="brick-x-table" style={{ borderCollapse: "collapse", fontSize: 13.5, width: "100%" }}>
              <thead><tr><th style={cell}>{t("idv.colDate")}</th><th style={cell}>{t("idv.colRequests")}</th><th style={cell}>{t("idv.colVerified")}</th></tr></thead>
              <tbody>
                {u.daily.map((d) => (
                  <tr key={d.date}><td data-label={t("idv.colDate")} style={cell}>{d.date}</td><td data-label={t("idv.colRequests")} style={cell}>{d.requests}</td><td data-label={t("idv.colVerified")} style={cell}>{d.verified}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p style={{ color: "var(--color-muted)", margin: 0 }}>{t("idv.noUsage")}</p>}
        <p style={{ color: "var(--color-muted)", fontSize: 12.5, margin: "10px 0 0" }}>{t("idv.usageNote")}</p>
      </section>
    </div>
  );
}
