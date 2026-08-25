"use client";

import { useCallback, useEffect, useState } from "react";

/* ── 타입 ─────────────────────────────────────────── */
interface PageRow { id: string; slug: string; title: string; status: string; updatedAt: string }
interface BlockNode { block: string; props: Record<string, unknown>; children?: BlockNode[] }
interface BlockDef {
  name: string;
  displayName: string;
  propsSchema?: { properties?: Record<string, { type?: string; title?: string; format?: string; default?: unknown }> };
}
interface PageDraft {
  id?: string;
  slug: string;
  title: string;
  status: string;
  blocks: BlockNode[];
  seo: { title?: string; description?: string };
}

const EMPTY: PageDraft = { slug: "", title: "", status: "draft", blocks: [], seo: {} };

/* ── 페이지 목록 + 빌더 ─────────────────────────────── */
export default function AdminPagesPage() {
  const [rows, setRows] = useState<PageRow[]>([]);
  const [catalog, setCatalog] = useState<BlockDef[]>([]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [message, setMessage] = useState("");

  const reload = useCallback(() => {
    fetch("/api/pages").then((r) => r.json()).then(setRows);
  }, []);
  useEffect(() => {
    reload();
    fetch("/api/blocks").then((r) => r.json()).then(setCatalog);
  }, [reload]);

  async function open(id: string) {
    const page = await fetch(`/api/pages/${id}`).then((r) => r.json());
    setDraft({ ...page, blocks: page.blocks ?? [], seo: page.seo ?? {} });
  }

  async function save() {
    if (!draft) return;
    const isNew = !draft.id;
    const res = await fetch(isNew ? "/api/pages" : `/api/pages/${draft.id}`, {
      method: isNew ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (res.ok) {
      setMessage("저장 완료");
      if (isNew) setDraft(null);
      reload();
    } else setMessage(`저장 실패: ${(await res.json()).message ?? res.status}`);
  }

  async function remove(id: string) {
    if (!confirm("이 페이지를 삭제할까요?")) return;
    await fetch(`/api/pages/${id}`, { method: "DELETE" });
    setDraft(null);
    reload();
  }

  if (draft) {
    return (
      <PageEditor
        draft={draft}
        catalog={catalog}
        message={message}
        onChange={setDraft}
        onSave={save}
        onDelete={draft.id ? () => remove(draft.id!) : undefined}
        onClose={() => { setDraft(null); setMessage(""); }}
      />
    );
  }

  return (
    <div>
      <h1>페이지</h1>
      <button onClick={() => setDraft({ ...EMPTY })} style={{ cursor: "pointer", padding: "8px 16px", marginBottom: 16 }}>
        + 새 페이지
      </button>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <table style={{ width: "100%", background: "#fff", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th style={{ padding: 12 }}>제목</th><th>주소</th><th>상태</th><th>수정</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f3f3f3", cursor: "pointer" }} onClick={() => open(p.id)}>
              <td style={{ padding: 12 }}><strong>{p.title}</strong></td>
              <td><code>/{p.slug}</code></td>
              <td>{p.status === "published" ? "🟢 발행" : p.status === "draft" ? "📝 초안" : "📦 보관"}</td>
              <td style={{ color: "#999", fontSize: 13 }}>{new Date(p.updatedAt).toLocaleString("ko-KR")}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} style={{ padding: 24, color: "#999" }}>아직 페이지가 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ── 빌더(에디터) ───────────────────────────────────── */
function PageEditor(props: {
  draft: PageDraft;
  catalog: BlockDef[];
  message: string;
  onChange: (d: PageDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { draft, catalog, onChange } = props;
  const [picker, setPicker] = useState(false);

  function updateBlock(i: number, node: BlockNode) {
    const blocks = [...draft.blocks];
    blocks[i] = node;
    onChange({ ...draft, blocks });
  }
  function move(i: number, dir: -1 | 1) {
    const blocks = [...draft.blocks];
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    onChange({ ...draft, blocks });
  }
  function addBlock(name: string) {
    const def = catalog.find((b) => b.name === name);
    const propsInit: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def?.propsSchema?.properties ?? {})) {
      if (v.default !== undefined) propsInit[k] = v.default;
    }
    onChange({ ...draft, blocks: [...draft.blocks, { block: name, props: propsInit }] });
    setPicker(false);
  }

  const input = { width: "100%", padding: 8, boxSizing: "border-box" as const, marginTop: 4 };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={props.onClose} style={{ cursor: "pointer" }}>← 목록</button>
        <h1 style={{ margin: 0, flex: 1 }}>{draft.id ? "페이지 편집" : "새 페이지"}</h1>
        {draft.status === "published" && draft.slug && (
          <a href={`/${draft.slug === "home" ? "" : draft.slug}`} target="_blank" style={{ fontSize: 14 }}>
            사이트에서 보기 ↗
          </a>
        )}
        {props.onDelete && <button onClick={props.onDelete} style={{ cursor: "pointer", color: "crimson" }}>삭제</button>}
        <button onClick={props.onSave} style={{ cursor: "pointer", padding: "8px 20px", fontWeight: 700 }}>저장</button>
      </div>
      {props.message && <p style={{ color: "#0a7" }}>{props.message}</p>}

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* 좌: 블록 캔버스 */}
        <div style={{ flex: 1 }}>
          {draft.blocks.map((node, i) => (
            <BlockCard
              key={i}
              node={node}
              def={catalog.find((b) => b.name === node.block)}
              onChange={(n) => updateBlock(i, n)}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              onRemove={() => onChange({ ...draft, blocks: draft.blocks.filter((_, j) => j !== i) })}
            />
          ))}
          <div style={{ position: "relative" }}>
            <button onClick={() => setPicker(!picker)}
              style={{ width: "100%", padding: 14, cursor: "pointer", border: "2px dashed #ccc", background: "none", borderRadius: 8 }}>
              + 블록 추가
            </button>
            {picker && (
              <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, marginTop: 4, boxShadow: "0 4px 12px rgba(0,0,0,.1)" }}>
                {catalog.map((b) => (
                  <div key={b.name} onClick={() => addBlock(b.name)}
                    style={{ padding: "10px 16px", cursor: "pointer", borderBottom: "1px solid #f3f3f3" }}>
                    <strong>{b.displayName}</strong> <span style={{ color: "#999", fontSize: 12 }}>{b.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 우: 페이지 설정 */}
        <aside style={{ width: 280, background: "#fff", borderRadius: 8, padding: 16, flexShrink: 0 }}>
          <label>제목<input style={input} value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>주소(slug)<input style={input} value={draft.slug}
            placeholder="home 은 홈페이지" onChange={(e) => onChange({ ...draft, slug: e.target.value })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>상태
            <select style={input} value={draft.status} onChange={(e) => onChange({ ...draft, status: e.target.value })}>
              <option value="draft">초안</option>
              <option value="published">발행</option>
              <option value="archived">보관</option>
            </select>
          </label>
          <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
          <strong style={{ fontSize: 13, color: "#888" }}>SEO</strong>
          <label style={{ display: "block", marginTop: 8 }}>SEO 제목<input style={input} value={draft.seo.title ?? ""}
            onChange={(e) => onChange({ ...draft, seo: { ...draft.seo, title: e.target.value } })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>설명<textarea style={{ ...input, height: 60 }}
            value={draft.seo.description ?? ""}
            onChange={(e) => onChange({ ...draft, seo: { ...draft.seo, description: e.target.value } })} /></label>
        </aside>
      </div>
    </div>
  );
}

/* ── 블록 카드: propsSchema 기반 속성 편집 ────────────── */
function BlockCard(props: {
  node: BlockNode;
  def?: BlockDef;
  onChange: (n: BlockNode) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const { node, def } = props;
  const schema = def?.propsSchema?.properties ?? {};
  const input = { width: "100%", padding: 6, boxSizing: "border-box" as const, marginTop: 2 };

  function setProp(key: string, value: unknown) {
    props.onChange({ ...node, props: { ...node.props, [key]: value } });
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 16, marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>{def?.displayName ?? node.block}</strong>
        <button onClick={props.onMoveUp} style={{ cursor: "pointer" }}>↑</button>
        <button onClick={props.onMoveDown} style={{ cursor: "pointer", marginLeft: 4 }}>↓</button>
        <button onClick={props.onRemove} style={{ cursor: "pointer", marginLeft: 8, color: "crimson" }}>✕</button>
      </div>
      {Object.entries(schema).map(([key, meta]) => (
        <label key={key} style={{ display: "block", marginTop: 8, fontSize: 13 }}>
          {meta.title ?? key}
          {meta.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(node.props[key])} onChange={(e) => setProp(key, e.target.checked)}
              style={{ marginLeft: 8 }} />
          ) : meta.type === "number" ? (
            <input type="number" style={input} value={String(node.props[key] ?? "")}
              onChange={(e) => setProp(key, e.target.value === "" ? undefined : Number(e.target.value))} />
          ) : meta.format === "multiline" ? (
            <textarea style={{ ...input, height: 100, fontFamily: "monospace" }} value={String(node.props[key] ?? "")}
              onChange={(e) => setProp(key, e.target.value)} />
          ) : (
            <input style={input} value={String(node.props[key] ?? "")} onChange={(e) => setProp(key, e.target.value)} />
          )}
        </label>
      ))}
      {!Object.keys(schema).length && <p style={{ color: "#999", fontSize: 13 }}>설정할 속성이 없는 블록입니다.</p>}
    </div>
  );
}
