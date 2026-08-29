"use client";

import { useEffect, useState } from "react";
import { useAdminT } from "../../../lib/i18n-admin";

export default function AdminDashboard() {
  const t = useAdminT();
  const [stats, setStats] = useState({ plugins: 0, activePlugins: 0, themes: 0, activeTheme: "-" });

  useEffect(() => {
    Promise.all([fetch("/api/plugins").then((r) => r.json()), fetch("/api/themes").then((r) => r.json())]).then(
      ([plugins, themes]) =>
        setStats({
          plugins: plugins.length,
          activePlugins: plugins.filter((p: { isActive: boolean }) => p.isActive).length,
          themes: themes.themes.length,
          activeTheme: themes.active,
        }),
    );
  }, []);

  const card = { background: "#fff", borderRadius: 8, padding: 20, minWidth: 160, boxShadow: "0 1px 3px rgba(0,0,0,.08)" };
  return (
    <div>
      <h1>{t("nav.dashboard")}</h1>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={card}><div style={{ color: "#888" }}>{t("nav.plugins")}</div><div style={{ fontSize: 28 }}>{stats.activePlugins} / {stats.plugins}</div></div>
        <div style={card}><div style={{ color: "#888" }}>{t("nav.themes")}</div><div style={{ fontSize: 28 }}>{stats.themes}</div></div>
        <div style={card}><div style={{ color: "#888" }}>{t("dash.activeTheme")}</div><div style={{ fontSize: 28 }}>{stats.activeTheme}</div></div>
      </div>
    </div>
  );
}
