"use client";

import { useCallback, useEffect, useState } from "react";

interface MenuItem { label: string; url: string }

export default function AdminMenusPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [message, setMessage] = useState("");

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

  async function save() {
    const res = await fetch("/api/menus/header", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    setMessage(res.ok ? "메뉴가 저장되었습니다. 사이트에 즉시 반영됩니다." : `실패: ${(await res.json()).message}`);
    if (res.ok) reload();
  }

  const input = { padding: 8, boxSizing: "border-box" as const };
  return (
    <div>
      <h1>메뉴 (헤더)</h1>
      <div style={{ background: "#fff", borderRadius: 8, padding: 16, maxWidth: 700 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <input style={{ ...input, flex: 1 }} placeholder="이름" value={it.label}
              onChange={(e) => update(i, { label: e.target.value })} />
            <input style={{ ...input, flex: 2 }} placeholder="/about 또는 https://…" value={it.url}
              onChange={(e) => update(i, { url: e.target.value })} />
            <button onClick={() => move(i, -1)} style={{ cursor: "pointer" }}>↑</button>
            <button onClick={() => move(i, 1)} style={{ cursor: "pointer" }}>↓</button>
            <button onClick={() => setItems(items.filter((_, j) => j !== i))}
              style={{ cursor: "pointer", color: "crimson" }}>✕</button>
          </div>
        ))}
        <button onClick={() => setItems([...items, { label: "", url: "/" }])}
          style={{ cursor: "pointer", padding: "8px 16px", marginTop: 8 }}>+ 항목 추가</button>
        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
        <button onClick={save} style={{ cursor: "pointer", padding: "10px 24px", fontWeight: 700 }}>저장</button>
        {message && <p style={{ color: "#0a7" }}>{message}</p>}
      </div>
      <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
        주소는 <code>/</code> 로 시작하는 내부 경로, <code>https://</code> 외부 링크, <code>#</code> 앵커만 허용됩니다.
      </p>
    </div>
  );
}
