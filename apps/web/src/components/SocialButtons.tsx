"use client";

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

interface Provider {
  name: string;
  label: string;
  color: string;
}

/**
 * 소셜 로그인 버튼.
 *
 * 설정된 공급자만 서버가 알려준다 — 화면에 켜기/끄기 목록을 두면 관리자가
 * 두 곳(설정과 화면)을 맞춰야 하고, 어긋나면 눌러도 안 되는 버튼이 남는다.
 *
 * 하나도 설정되지 않았으면 아무것도 그리지 않는다(구분선도 없다).
 */
export function SocialButtons({ next = "/" }: { next?: string }) {
  const t = useT();
  const [items, setItems] = useState<Provider[] | null>(null);

  useEffect(() => {
    fetch("/api/auth/oauth/providers")
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d.items) ? d.items : []))
      .catch(() => setItems([]));
  }, []);

  if (!items?.length) return null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 16px" }}>
        <span style={{ flex: 1, height: 1, background: "#e6e6ee" }} />
        <span style={{ fontSize: 12, color: "#999" }}>{t("social.or")}</span>
        <span style={{ flex: 1, height: 1, background: "#e6e6ee" }} />
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((p) => (
          <a
            key={p.name}
            href={`/api/auth/oauth/${p.name}?next=${encodeURIComponent(next)}`}
            style={{
              display: "block",
              padding: 12,
              borderRadius: 8,
              textAlign: "center",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 14,
              // 카카오는 노란 배경에 검은 글씨가 브랜드 규정이다
              background: p.color,
              color: p.name === "kakao" ? "#191600" : "#fff",
            }}
          >
            {t("social.continue", { label: p.label })}
          </a>
        ))}
      </div>
    </>
  );
}
