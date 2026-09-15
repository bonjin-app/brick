"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

type Info = Record<string, string>;

/** 쇼핑몰을 열려면 반드시 있어야 하는 항목 — 서버의 REQUIRED_FOR_COMMERCE 와 같다 */
const REQUIRED = new Set([
  "companyName", "representative", "businessNo", "mailOrderNo", "address", "phone",
]);
/** 한 줄로는 좁은 항목 */
const WIDE = new Set(["address", "escrow"]);

/**
 * 사업자정보 설정.
 *
 * **법적 표시 의무인데 입력할 자리가 없었다.** 서버에는 API 도 체크섬 검증도
 * (`000-00-00000` 같은 칸 채우기까지 거른다) 법 조항을 인용한 경고도 테마
 * 렌더도 스모크도 있었고, 문서는 "관리자 → 설정 → 사업자정보에서 입력합니다"
 * 라고 안내까지 했다 — 그 화면만 없었다. 그래서 모든 브릭 쇼핑몰의 푸터가
 * 비어 있었고, 전자상거래법 제13조 표시 의무를 지킬 방법이 없었다.
 *
 * 라벨은 **서버가 준 것을 쓴다**(`labels`). 검증 실패 문구가 같은 이름을
 * 쓰므로, 화면에 따로 적으면 "상호를 입력하세요" 라고 하는데 화면에는 다른
 * 이름이 적혀 있는 일이 생긴다.
 */
export function BusinessInfoSettings() {
  const t = useAdminT();
  const [info, setInfo] = useState<Info>({});
  const [labels, setLabels] = useState<Info>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [ready, setReady] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    fetch("/api/business-info")
      .then((r) => r.json())
      .then((d) => {
        setInfo(d.info ?? {});
        setLabels(d.labels ?? {});
        setReady(Boolean(d.commerceReady));
        setMissing(Array.isArray(d.missing) ? d.missing : []);
      })
      .catch(() => setLabels({}));
  }, []);
  useEffect(reload, [reload]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/business-info", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(info),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFailed(true);
      setWarnings([]);
      setMessage(`${t("common.failPrefix")}${d.message ?? ""}`);
      return;
    }
    setFailed(false);
    setMessage(t("business.saved"));
    // 저장은 됐지만 법이 요구하는 것이 빠졌을 수 있다 — 서버가 조항까지 알려준다
    setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
    setReady(Boolean(d.commerceReady));
    setMissing(Array.isArray(d.missing) ? d.missing : []);
  }

  const keys = Object.keys(labels);
  const input = { width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" as const };

  return (
    <section className="brick-card" aria-labelledby="settings-business">
      <h2 id="settings-business" className="brick-card-title">{t("business.title")}</h2>
      <p style={{ fontSize: 13, color: "var(--color-muted)", marginTop: 0 }}>{t("business.desc")}</p>

      {/* 쇼핑몰을 열 수 없는 상태라면 무엇이 빠졌는지 이름을 댄다 */}
      {!ready && missing.length > 0 && (
        <p role="status" data-testid="brick-biz-missing" style={{
          margin: "0 0 14px", padding: "10px 12px", fontSize: 13, borderRadius: 8,
          background: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-danger) 34%, transparent)",
        }}>{t("business.missing", { fields: missing.join(" · ") })}</p>
      )}

      <form onSubmit={save}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {keys.map((k) => (
            <label key={k} style={{ fontSize: 13, gridColumn: WIDE.has(k) ? "1 / -1" : undefined }}>
              {labels[k]}
              {REQUIRED.has(k) && <span style={{ color: "var(--color-danger)" }}> *</span>}
              <input style={input} value={info[k] ?? ""}
                placeholder={k === "businessNo" ? "000-00-00000" : k === "mailOrderNo" ? "제2026-서울강남-01234호" : ""}
                onChange={(e) => setInfo({ ...info, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{t("business.requiredNote")}</p>
        <button className="btn-primary" style={{ marginTop: 4 }}>{t("common.save")}</button>
      </form>

      {message && (
        <p role={failed ? "alert" : "status"}
          style={{ fontSize: 13, color: failed ? "var(--color-danger)" : "var(--color-success)" }}>
          {message}
        </p>
      )}
      {/* 저장은 됐지만 법이 더 요구하는 것 — 조항까지 서버가 말해 준다 */}
      {warnings.map((w) => (
        <p key={w} role="status" style={{ fontSize: 13, color: "var(--color-muted)", margin: "4px 0 0" }}>⚠ {w}</p>
      ))}
    </section>
  );
}
