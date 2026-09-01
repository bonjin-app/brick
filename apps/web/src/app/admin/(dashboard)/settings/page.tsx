"use client";

import { useCallback, useEffect, useState } from "react";
import { SocialLoginSettings } from "./SocialLoginSettings";
import { useAdminT } from "../../../../lib/i18n-admin";

export default function AdminSettingsPage() {
  const t = useAdminT();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState("");

  const reload = useCallback(() => {
    fetch("/api/settings").then((r) => r.json()).then(setSettings);
  }, []);
  useEffect(reload, [reload]);

  async function save() {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "site.name": String(settings["site.name"] ?? ""),
        "site.description": String(settings["site.description"] ?? ""),
        "site.registration_open": settings["site.registration_open"] !== false,
        "site.locale": String(settings["site.locale"] ?? "ko"),
      }),
    });
    setMessage(res.ok ? t("common.saved") : `${t("common.failPrefix")}${(await res.json()).message}`);
  }

  const input = { width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" as const };
  return (
    <div>
      <h1>{t("settings.title")}</h1>
      <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 20, maxWidth: 520 }}>
        <label>{t("settings.siteName")}
          <input style={input} value={String(settings["site.name"] ?? "")}
            onChange={(e) => setSettings({ ...settings, "site.name": e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>{t("settings.siteDesc")}
          <textarea style={{ ...input, height: 70 }} value={String(settings["site.description"] ?? "")}
            onChange={(e) => setSettings({ ...settings, "site.description": e.target.value })} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          <input type="checkbox" checked={settings["site.registration_open"] !== false}
            onChange={(e) => setSettings({ ...settings, "site.registration_open": e.target.checked })} />
          {" "}{t("settings.regOpen")}
        </label>
        <label style={{ display: "block", marginTop: 16 }}>{t("settings.locale")}
          <select style={{ display: "block", padding: 8, marginTop: 4 }}
            value={String(settings["site.locale"] ?? "ko")}
            onChange={(e) => setSettings({ ...settings, "site.locale": e.target.value })}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
          <small style={{ color: "var(--color-muted)" }}>{t("settings.localeHint")}</small>
        </label>
        <button onClick={save} style={{ cursor: "pointer", padding: "10px 24px", marginTop: 24, fontWeight: 700 }}>
          {t("common.save")}
        </button>
        {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}
      </div>
      <SocialLoginSettings />
    </div>
  );
}
