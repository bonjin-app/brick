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

interface MenuItem { label: string; url: string }
interface LinkTarget { path: string; label: string; hint?: string | null }
interface TargetGroup { code: string; label: string; items: LinkTarget[] }

const input: React.CSSProperties = {
  padding: 8, boxSizing: "border-box", border: "1px solid #ddd", borderRadius: 6,
};
const btn: React.CSSProperties = {
  cursor: "pointer", padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
};

export default function AdminMenusPage() {
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
        ? "메뉴가 저장되었습니다. 사이트에 즉시 반영됩니다."
        : `실패: ${data.message ?? res.status}`,
    );
    if (res.ok) reload();
  }

  return (
    <div>
      <h1>메뉴 (헤더)</h1>
      <p style={{ color: "#666", fontSize: 14, marginTop: -8 }}>
        <strong>연결 대상 선택</strong>을 누르면 만들어 둔 페이지·게시판·쇼핑몰 화면이 목록으로 나옵니다.
      </p>

      <div style={{ background: "#fff", borderRadius: 8, padding: 16, maxWidth: 860 }}>
        {items.map((it, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...input, flex: 1 }} placeholder="메뉴에 보일 이름" value={it.label}
                onChange={(e) => update(i, { label: e.target.value })} />
              <input style={{ ...input, flex: 2, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}
                placeholder="/about 또는 https://…" value={it.url}
                onChange={(e) => update(i, { url: e.target.value })} />
              <button style={btn} onClick={() => setPickerFor(pickerFor === i ? null : i)}>
                연결 대상 선택
              </button>
              <button style={btn} onClick={() => move(i, -1)} title="위로">↑</button>
              <button style={btn} onClick={() => move(i, 1)} title="아래로">↓</button>
              <button style={{ ...btn, color: "crimson" }} title="삭제"
                onClick={() => { setItems(items.filter((_, j) => j !== i)); setPickerFor(null); }}>✕</button>
            </div>
            {pickerFor === i && <TargetPicker onPick={(t) => pick(i, t)} onClose={() => setPickerFor(null)} />}
          </div>
        ))}

        <button style={{ ...btn, marginTop: 8, borderStyle: "dashed", padding: "10px 16px" }}
          onClick={() => { setItems([...items, { label: "", url: "" }]); setPickerFor(items.length); }}>
          + 항목 추가
        </button>

        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
        <button onClick={() => void save()}
          style={{ ...btn, padding: "10px 24px", fontWeight: 700, background: "#1a1a2e", color: "#fff", borderColor: "#1a1a2e" }}>
          저장
        </button>
        {message && <p style={{ color: message.startsWith("실패") ? "crimson" : "#0a7" }}>{message}</p>}
      </div>

      <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
        주소는 <code>/</code> 로 시작하는 내부 경로, <code>https://</code> 외부 링크,
        <code>#</code> 앵커만 허용됩니다.
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
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("목록을 불러오지 못했습니다."))))
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
      marginTop: 6, border: "1px solid #ddd", borderRadius: 8, background: "#fff",
      boxShadow: "0 6px 20px rgba(0,0,0,.12)", maxHeight: 340, overflowY: "auto",
    }}>
      <div style={{ padding: 10, borderBottom: "1px solid #eee", position: "sticky", top: 0, background: "#fff" }}>
        <input autoFocus style={{ ...input, width: "100%" }} placeholder="이름으로 찾기"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {error && <p style={{ padding: 12, color: "crimson", margin: 0 }}>{error}</p>}
      {!error && loading && total === 0 && <p style={{ padding: 12, color: "#999", margin: 0 }}>불러오는 중…</p>}
      {!error && !loading && total === 0 && (
        <p style={{ padding: 12, color: "#999", margin: 0 }}>
          찾는 것이 없습니다. 주소를 직접 입력할 수 있습니다.
        </p>
      )}

      {groups.map((g) => (
        <div key={g.code}>
          <div style={{
            padding: "6px 12px", background: "#f7f7fa", fontSize: 12, color: "#666", fontWeight: 600,
          }}>{g.label}</div>
          {g.items.map((t) => (
            <div key={t.path} onClick={() => props.onPick(t)}
              style={{ padding: "9px 12px", cursor: "pointer", borderBottom: "1px solid #f4f4f7" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f2f6ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <strong style={{ fontSize: 14 }}>{t.label}</strong>
                <code style={{ fontSize: 12, color: "#888" }}>{t.path}</code>
              </div>
              {t.hint && <div style={{ fontSize: 12, color: "#c07000", marginTop: 2 }}>{t.hint}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
