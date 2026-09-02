"use client";

import { useCallback, useEffect, useState } from "react";
import { SocialLoginSettings } from "./SocialLoginSettings";
import { useAdminT } from "../../../../lib/i18n-admin";

type Settings = Record<string, unknown>;

/**
 * 사이트 설정 — 서버의 EDITABLE_SETTINGS 를 주제별 카드로 나눈다.
 * 카드마다 저장 버튼이 따로 있다: 보안 카드는 저장 시 자기잠금 검사(400)가 있어
 * 실패 메시지가 그 카드 옆에 붙어야 하고, 한 카드의 실패가 다른 카드의 저장을 막지 않아야 한다.
 */
export default function AdminSettingsPage() {
  const t = useAdminT();
  const [settings, setSettings] = useState<Settings>({});
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});

  const reload = useCallback(() => {
    fetch("/api/settings").then((r) => r.json()).then(setSettings);
  }, []);
  useEffect(reload, [reload]);

  const str = (k: string, fallback = "") => String(settings[k] ?? fallback);
  const bool = (k: string, fallback: boolean) => (settings[k] === undefined ? fallback : settings[k] === true);
  const set = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v }));

  async function save(card: string, keys: string[]) {
    const body: Settings = {};
    for (const k of keys) body[k] = settings[k] ?? (BOOLEAN_KEYS.has(k) ? false : "");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = res.ok ? t("common.saved") : `${t("common.failPrefix")}${(await res.json().catch(() => ({}))).message ?? res.status}`;
    setMessages((m) => ({ ...m, [card]: { ok: res.ok, text } }));
  }

  const input: React.CSSProperties = { width: "100%", marginTop: 6, boxSizing: "border-box" };
  const list: React.CSSProperties = { ...input, minHeight: 84, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 };

  function Card(props: { id: string; title: string; desc?: string; keys: string[]; children: React.ReactNode }) {
    const msg = messages[props.id];
    return (
      <section className="brick-card" aria-labelledby={`settings-${props.id}`}>
        <h2 id={`settings-${props.id}`} className="brick-card-title">{props.title}</h2>
        {props.desc ? <p className="brick-card-desc">{props.desc}</p> : null}
        {props.children}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
          <button className="btn-primary" onClick={() => save(props.id, props.keys)}>{t("common.save")}</button>
          {msg ? <span style={{ fontSize: 13.5, color: msg.ok ? "var(--color-success)" : "var(--color-danger)" }}>{msg.text}</span> : null}
        </div>
      </section>
    );
  }

  const Field = (props: { label: string; hint?: string; children: React.ReactNode }) => (
    <label className="brick-field">
      <span className="brick-field-label">{props.label}</span>
      {props.children}
      {props.hint ? <small className="brick-field-hint">{props.hint}</small> : null}
    </label>
  );
  const Check = (props: { k: string; label: string; hint?: string; fallback?: boolean }) => (
    <label className="brick-check">
      <input type="checkbox" checked={bool(props.k, props.fallback ?? false)} onChange={(e) => set(props.k, e.target.checked)} />
      <span>
        {props.label}
        {props.hint ? <small className="brick-field-hint">{props.hint}</small> : null}
      </span>
    </label>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>{t("settings.title")}</h1>

      <Card id="general" title={t("settings.general")} keys={["site.name", "site.description", "site.locale", "site.seo_noindex"]}>
        <Field label={t("settings.siteName")}>
          <input style={input} value={str("site.name")} onChange={(e) => set("site.name", e.target.value)} />
        </Field>
        <Field label={t("settings.siteDesc")}>
          <textarea style={{ ...input, minHeight: 70 }} value={str("site.description")} onChange={(e) => set("site.description", e.target.value)} />
        </Field>
        <Field label={t("settings.locale")} hint={t("settings.localeHint")}>
          <select style={{ display: "block", marginTop: 6 }} value={str("site.locale", "ko")} onChange={(e) => set("site.locale", e.target.value)}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Check k="site.seo_noindex" label={t("settings.noindex")} hint={t("settings.noindexHint")} />
      </Card>

      <Card id="members" title={t("settings.members")} desc={t("settings.membersDesc")}
        keys={["site.registration_open", "member.nick_change_days", "moderation.denied_names", "moderation.denied_email_domains"]}>
        <Check k="site.registration_open" label={t("settings.regOpen")} fallback />
        <Field label={t("settings.nickDays")} hint={t("settings.nickDaysHint")}>
          <input style={{ ...input, width: 120 }} inputMode="numeric" value={str("member.nick_change_days", "0")}
            onChange={(e) => set("member.nick_change_days", e.target.value.replace(/[^0-9]/g, ""))} />
        </Field>
        <Field label={t("settings.deniedNames")} hint={t("settings.deniedNamesHint")}>
          <textarea style={list} value={str("moderation.denied_names")} onChange={(e) => set("moderation.denied_names", e.target.value)} />
        </Field>
        <Field label={t("settings.deniedDomains")} hint={t("settings.deniedDomainsHint")}>
          <textarea style={list} value={str("moderation.denied_email_domains")} onChange={(e) => set("moderation.denied_email_domains", e.target.value)} />
        </Field>
      </Card>

      <Card id="moderation" title={t("settings.moderation")} desc={t("settings.moderationDesc")} keys={["moderation.banned_words"]}>
        <Field label={t("settings.bannedWords")} hint={t("settings.bannedWordsHint")}>
          <textarea style={{ ...list, minHeight: 120 }} value={str("moderation.banned_words")} onChange={(e) => set("moderation.banned_words", e.target.value)} />
        </Field>
      </Card>

      <Card id="security" title={t("settings.security")} desc={t("settings.securityDesc")}
        keys={["security.require_2fa_for_staff", "security.admin_ip_allowlist", "security.blocked_ips"]}>
        <Check k="security.require_2fa_for_staff" label={t("settings.require2fa")} hint={t("settings.require2faHint")} />
        <Field label={t("settings.adminIps")} hint={t("settings.adminIpsHint")}>
          <textarea style={list} value={str("security.admin_ip_allowlist")} onChange={(e) => set("security.admin_ip_allowlist", e.target.value)} />
        </Field>
        <Field label={t("settings.blockedIps")} hint={t("settings.blockedIpsHint")}>
          <textarea style={list} value={str("security.blocked_ips")} onChange={(e) => set("security.blocked_ips", e.target.value)} />
        </Field>
      </Card>

      <Card id="extensions" title={t("settings.extensions")} keys={["extensions.registry_url"]}>
        <Field label={t("settings.registryUrl")} hint={t("settings.registryUrlHint")}>
          <input style={input} placeholder="https://" value={str("extensions.registry_url")} onChange={(e) => set("extensions.registry_url", e.target.value)} />
        </Field>
      </Card>

      <SocialLoginSettings />
    </div>
  );
}

/** 서버가 boolean 으로 검증하는 키 — 미설정이면 false 로 보낸다 ("" 를 보내면 400) */
const BOOLEAN_KEYS = new Set(["site.registration_open", "site.seo_noindex", "security.require_2fa_for_staff"]);
