"use client";

/**
 * 메뉴 편집.
 *
 * ── 무엇을 고쳤나 ────────────────────────────────────
 *
 * 전에는 `이름 + 주소 직접 입력`이었다. 운영자는 만든 게시판의 slug 를 외워
 * `/board/free` 를 손으로 적어야 했고, **오타가 나도 저장은 되고 눌러야 404 를
 * 본다.** 페이지를 만들었는데 메뉴에 어떻게 붙이는지 모르는 것이 가장 흔한
 * 막힘이었다.
 *
 * 이제 `연결 대상 선택`을 누르면 페이지·게시판·쇼핑몰 화면이 목록으로 나오고,
 * 고르면 이름과 주소가 함께 채워진다. 직접 입력도 남겨 뒀다 — 외부 링크와
 * 앵커는 목록에 있을 수 없다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";

interface MenuItem { label: string; url: string }
interface LinkTarget { path: string; label: string; hint?: string | null }
interface TargetGroup { code: string; label: string; items: LinkTarget[] }

const input: React.CSSProperties = {
  padding: 8, boxSizing: "border-box", border: "1px solid var(--color-line-strong)", borderRadius: 6,
};
const btn: React.CSSProperties = {
  cursor: "pointer", padding: "8px 12px", borderRadius: 6, border: "1px solid var(--color-line-strong)", background: "var(--color-bg)",
};

export default function AdminMenusPage() {
  const t = useAdminT();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [message, setMessage] = useState("");
  /** 어느 항목의 선택기를 열었나 (null 이면 닫힘) */
  const [pickerFor, setPickerFor] = useState<number | null>(null);

  const reload = useCallback(() => {
    fetch("/api/menus/header").then((r) => r.json()).then((d) => setItems(d.items ?? []));
  }, []);
  useEffect(reload, [reload]);

  function update(i: number, patch: Partial<MenuItem>) {
    setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }
  function move(i: number, dir: -1 | 1) {
    const next = [...items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  }

  /**
   * 대상을 고르면 주소와 **이름까지** 채운다.
   *
   * 이름을 비워두면 운영자가 다시 타이핑해야 한다. 이미 비어 있지 않으면
   * 덮어쓰지 않는다 — 손으로 다듬은 이름을 지우면 안 된다.
   */
  function pick(i: number, target: LinkTarget) {
    const current = items[i];
    update(i, { url: target.path, label: current.label.trim() || target.label });
    setPickerFor(null);
  }

  async function save() {
    const res = await fetch("/api/menus/header", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json().catch(() => ({}));
    setMessage(
      res.ok
        ? t("menus.saved")
        : `${t("common.failPrefix")}${data.message ?? res.status}`,
    );
    if (res.ok) reload();
  }

  return (
    <div>
      <h1>{t("menus.title")}</h1>
      <p style={{ color: "var(--color-text-soft)", fontSize: 14, marginTop: -8 }}>
        {t("menus.guide")}
      </p>

      <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 16, maxWidth: 860 }}>
        {items.map((it, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div className="flex flex-wrap items-center gap-2">
              <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder={t("menus.labelPh")} value={it.label}
                onChange={(e) => update(i, { label: e.target.value })} />
              <input style={{ ...input, flex: 2, minWidth: 200, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}
                placeholder="/about 또는 https://…" value={it.url}
                onChange={(e) => update(i, { url: e.target.value })} />
              <button style={btn} onClick={() => setPickerFor(pickerFor === i ? null : i)}>
                {t("menus.pick")}
              </button>
              <button style={btn} onClick={() => move(i, -1)} title={t("common.up")}>↑</button>
              <button style={btn} onClick={() => move(i, 1)} title={t("common.down")}>↓</button>
              <button style={{ ...btn, color: "var(--color-danger)" }} title={t("common.delete")}
                onClick={() => { setItems(items.filter((_, j) => j !== i)); setPickerFor(null); }}>✕</button>
            </div>
            {pickerFor === i && <TargetPicker onPick={(t) => pick(i, t)} onClose={() => setPickerFor(null)} />}
          </div>
        ))}

        <button style={{ ...btn, marginTop: 8, borderStyle: "dashed", padding: "10px 16px" }}
          onClick={() => { setItems([...items, { label: "", url: "" }]); setPickerFor(items.length); }}>
          {t("menus.addItem")}
        </button>

        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--color-line)" }} />
        <button onClick={() => void save()}
          style={{ ...btn, padding: "10px 24px", fontWeight: 700, background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "var(--color-primary)" }}>
          {t("common.save")}
        </button>
        {message && <p style={{ color: message.startsWith(t("common.failPrefix").slice(0, 2)) ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>}
      </div>

      <p style={{ color: "var(--color-muted)", fontSize: 13, marginTop: 12 }}>
        {t("menus.anchorNote")}
      </p>
    </div>
  );
}

/**
 * 연결 대상 선택기.
 *
 * 검색을 서버로 보내는 이유: 게시판 50개·분류 200개인 사이트가 있어서 전부
 * 받아 화면에서 걸러내면 멈춘다. 공급자가 상한을 지켜 보내준다.
 */
function TargetPicker(props: { onPick: (t: LinkTarget) => void; onClose: () => void }) {
  const t = useAdminT();
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 타이핑마다 요청을 보내지 않는다
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/admin/link-targets?q=${encodeURIComponent(query)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("menus.loadFail")))))
        .then((d) => { setGroups(d.groups ?? []); setError(""); })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 바깥을 누르면 닫는다 — 열어둔 채 다른 항목을 편집하려다 헷갈린다
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) props.onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [props]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div ref={boxRef} style={{
      marginTop: 6, border: "1px solid var(--color-line-strong)", borderRadius: 8, background: "var(--color-bg)",
      boxShadow: "0 6px 20px rgba(0,0,0,.12)", maxHeight: 340, overflowY: "auto",
    }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--color-line)", position: "sticky", top: 0, background: "var(--color-bg)" }}>
        <input autoFocus style={{ ...input, width: "100%" }} placeholder={t("menus.searchPh")}
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {error && <p style={{ padding: 12, color: "var(--color-danger)", margin: 0 }}>{error}</p>}
      {!error && loading && total === 0 && <p style={{ padding: 12, color: "var(--color-muted)", margin: 0 }}>{t("common.loading")}</p>}
      {!error && !loading && total === 0 && (
        <p style={{ padding: 12, color: "var(--color-muted)", margin: 0 }}>
          {t("menus.notFound")}
        </p>
      )}

      {groups.map((g) => (
        <div key={g.code}>
          <div style={{
            padding: "6px 12px", background: "var(--color-bg-soft)", fontSize: 12, color: "var(--color-text-soft)", fontWeight: 600,
          }}>{g.label}</div>
          {g.items.map((tg) => (
            <div key={tg.path} onClick={() => props.onPick(tg)}
              style={{ padding: "9px 12px", cursor: "pointer", borderBottom: "1px solid var(--color-line)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-bg-soft)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-bg)"; }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <strong style={{ fontSize: 14 }}>{tg.label}</strong>
                <code style={{ fontSize: 12, color: "var(--color-muted)" }}>{tg.path}</code>
              </div>
              {tg.hint && <div style={{ fontSize: 12, color: "var(--color-warning)", marginTop: 2 }}>{tg.hint}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
