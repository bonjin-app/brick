"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useModalFocus } from "../../../../lib/use-modal";

interface ThemeRow {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  tokens?: Record<string, string>;
}

/**
 * 활성 테마를 못 읽어 다른 것으로 그리는 중이라는 알림.
 * 읽히지 않는 테마는 목록에 나오지 않으므로(discover 가 건너뛴다) 이 줄이 없으면
 * 운영자는 적용해 둔 테마가 통째로 사라진 화면만 본다.
 */
interface ThemeProblem {
  theme: string;
  message: string;
  /** 대신 그리는 테마. 비어 있으면 내장 기본 화면이다 */
  fallback: string;
}

/** 매니페스트 토큰에서 팔레트 견본 — 적용하기 전에 인상을 고를 수 있게 */
const SWATCH_KEYS = ["color-bg", "color-bg-soft", "color-primary", "color-text"];
function Swatches({ tokens, prefix, label }: { tokens: Record<string, string>; prefix: string; label: string }) {
  const colors = SWATCH_KEYS.map((k) => tokens[prefix + k]).filter(Boolean);
  if (colors.length < 2) return null;
  return (
    <span role="img" aria-label={label} title={label} style={{ display: "inline-flex", border: "1px solid var(--color-line)", borderRadius: 4, overflow: "hidden" }}>
      {colors.map((c, i) => <span key={i} style={{ width: 22, height: 16, background: c }} />)}
    </span>
  );
}

/**
 * 카드 속 축소 화면 — 그 테마로 그린 **내 사이트의 홈**.
 *
 * 색 견본과 설명만으로는 테마를 고를 수 없었다(카페24 디자인 센터가 데모 화면부터 보여 주는 이유다). 미리보기 단추는 한 번에
 * 하나만 열어 볼 수 있어 여덟 벌을 비교하려면 여덟 번 열고 닫아야 했다. 1280px 로 그린 화면을 카드 폭에 맞춰 줄인다.
 *
 * 화면에 들어올 때만 받는다(테마가 많아도 처음에 한꺼번에 그리지 않는다). iframe 은 스크립트를 막고(sandbox) 누를 수 없게 둔다 —
 * 축소판은 보는 것이지 쓰는 것이 아니고, 키보드 사용자가 그 안으로 들어가 길을 잃으면 안 된다.
 */
const THUMB_W = 1280;
const THUMB_H = 820;
/** 미리보기 주소 — 그 테마의 CSP 가 붙은 완성된 HTML (pages.controller 의 admin/render/preview-page) */
const previewUrl = (name: string) => `/api/admin/render/preview-page?path=&theme=${encodeURIComponent(name)}`;

function ThemeThumb({ name, label, loadingLabel, active }: {
  name: string; label: string; loadingLabel: string; active: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale((e?.contentRect.width ?? THUMB_W / 4) / THUMB_W));
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      style={{
        position: "relative", aspectRatio: `${THUMB_W} / ${THUMB_H}`, overflow: "hidden", borderRadius: 6, marginBottom: 12,
        border: `${active ? 2 : 1}px solid ${active ? "var(--color-primary)" : "var(--color-line)"}`, background: "var(--color-bg-soft)",
      }}
    >
      {/*
        sandbox="allow-same-origin" — 스크립트는 막고(축소판은 보는 것이다) 같은 출처로 열어 관리자 세션으로 그린다.
        srcdoc 이 아니라 주소로 여는 이유는 previewUrl 의 주석.
      */}
      {visible ? (
        <iframe
          title={label}
          src={`${previewUrl(name)}&bare=1`}
          sandbox="allow-same-origin"
          tabIndex={-1}
          aria-hidden="true"
          onLoad={() => setLoaded(true)}
          style={{
            width: THUMB_W, height: THUMB_H, border: 0, pointerEvents: "none",
            transform: `scale(${scale})`, transformOrigin: "0 0", background: "#fff",
          }}
        />
      ) : null}
      {!loaded ? (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12.5, color: "var(--color-muted)" }}>
          {loadingLabel}
        </span>
      ) : null}
    </div>
  );
}

export default function AdminThemesPage() {
  const t = useAdminT();
  const [data, setData] = useState<{ themes: ThemeRow[]; active: string; problem?: ThemeProblem | null }>({
    themes: [],
    active: "",
  });
  const [message, setMessage] = useState("");
  /* 성공과 실패가 같은 자리를 쓴다 — 색과 role 도 결과를 따라야 한다(문구로 판별하지 않는다) */
  const [failed, setFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 미리보기 — 팔레트 견본만으로는 레이아웃을 알 수 없다. 내 사이트 내용으로 그려 본다 */
  const [preview, setPreview] = useState<{ name: string; width: number } | null>(null);

  const reload = useCallback(() => {
    fetch("/api/themes").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function activate(name: string) {
    const res = await fetch(`/api/themes/${name}/activate`, { method: "POST" });
    setFailed(!res.ok);
    setMessage(res.ok ? t("themes.applied", { name }) : `${t("common.failPrefix")}${await res.text()}`);
    reload();
  }

  function openPreview(name: string) {
    setPreview({ name, width: 0 });
  }

  // Esc 로 닫고, 포커스를 모달 안에 가두고, 닫으면 열었던 자리로 돌려준다
  const previewRef = useModalFocus<HTMLDivElement>(() => setPreview(null), Boolean(preview));

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/themes/upload", { method: "POST", body: fd });
    setFailed(!res.ok);
    setMessage(res.ok ? t("themes.installDone") : `${t("themes.installFailPrefix")}${await res.text()}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  return (
    <div>
      <h1>{t("themes.title")}</h1>
      <form onSubmit={upload} className="brick-card" style={{ marginTop: 0, marginBottom: 20 }}>
        <strong>{t("themes.upload")}</strong>{" "}
        <input ref={fileRef} type="file" accept=".zip" required />{" "}
        <button style={{ cursor: "pointer" }}>{t("common.install")}</button>
        <span style={{ marginLeft: 8, color: "var(--color-muted)", fontSize: 13 }}>{t("themes.hint")}</span>
      </form>
      {data.problem && (
        <div className="brick-card" role="alert"
          style={{ marginTop: 0, marginBottom: 16, borderColor: "var(--color-danger)" }}>
          <strong>{t("themes.brokenTitle", { name: data.problem.theme })}</strong>
          <p style={{ margin: "6px 0 0", color: "var(--color-text-soft)", fontSize: 13.5 }}>
            {data.problem.message}
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--color-muted)", fontSize: 13 }}>
            {data.problem.fallback
              ? t("themes.brokenFallback", { name: data.problem.fallback })
              : t("themes.brokenBuiltin")}
          </p>
        </div>
      )}
      {message && (
        <p role={failed ? "alert" : "status"}
          style={{ color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 16 }}>
        {data.themes.map((th) => (
          <div key={th.name} className="brick-card" style={{ marginTop: 0, minWidth: 0 }}>
            <ThemeThumb
              name={th.name}
              active={data.active === th.name}
              label={t("themes.thumbOf", { name: th.displayName })}
              loadingLabel={t("themes.thumbLoading")}
            />
            {th.tokens ? (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <Swatches tokens={th.tokens} prefix="" label={t("themes.paletteLight")} />
                <Swatches tokens={th.tokens} prefix="dark-" label={t("themes.paletteDark")} />
              </div>
            ) : null}
            <strong style={th.tokens?.["font-display"] ? { fontFamily: th.tokens["font-display"], fontSize: 17 } : undefined}>{th.displayName}</strong>{" "}
            <span style={{ color: "var(--color-muted)", fontSize: 12 }}>v{th.version}</span>
            <p style={{ color: "var(--color-text-soft)", fontSize: 13, minHeight: 40, margin: "6px 0 12px" }}>{th.description}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {data.active === th.name ? (
                <span style={{ color: "var(--color-success)" }}>{t("themes.inUse")}</span>
              ) : (
                <button onClick={() => activate(th.name)} style={{ cursor: "pointer" }}>{t("common.apply")}</button>
              )}
              <button onClick={() => openPreview(th.name)} style={{ cursor: "pointer" }}>
                {t("themes.preview")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview ? (
        <div
          ref={previewRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("themes.previewOf", { name: preview.name })}
          onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
          style={{
            position: "fixed", inset: 0, zIndex: 60, background: "rgba(10,10,14,.55)",
            display: "flex", flexDirection: "column", padding: "min(3vh, 24px) min(3vw, 24px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, color: "#fff", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>{t("themes.previewOf", { name: preview.name })}</strong>
            {/* 폭 전환 — 테마의 반응형을 여기서 바로 본다 */}
            {[0, 768, 375].map((w) => (
              <button
                key={w}
                onClick={() => setPreview({ ...preview, width: w })}
                aria-pressed={preview.width === w}
                style={{ cursor: "pointer", fontWeight: preview.width === w ? 700 : 400 }}
              >
                {w === 0 ? t("themes.previewFull") : `${w}px`}
              </button>
            ))}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {data.active !== preview.name ? (
                <button onClick={() => { activate(preview.name); setPreview(null); }} style={{ cursor: "pointer" }}>
                  {t("common.apply")}
                </button>
              ) : null}
              <button onClick={() => setPreview(null)} style={{ cursor: "pointer" }}>{t("common.close")}</button>
            </span>
          </div>
          {/*
            주소로 연다 — 그 테마의 CSP 가 붙은 완성된 HTML 이라 웹폰트까지 실제와 같게 그려진다(srcdoc 은 관리 화면의 CSP 를
            물려받아 테마 글꼴이 막혔다). iframe 이라 테마 CSS 가 관리 화면에 새지 않는다.
          */}
          <iframe
            title={t("themes.previewOf", { name: preview.name })}
            src={previewUrl(preview.name)}
            style={{
              flex: 1, width: preview.width ? preview.width : "100%", margin: "0 auto",
              maxWidth: "100%", border: 0, borderRadius: 6, background: "#fff",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
