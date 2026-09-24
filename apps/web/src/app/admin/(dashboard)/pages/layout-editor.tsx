"use client";

/**
 * 페이지 배치 편집기.
 *
 * 전에는 블록을 폼 카드로 세로로 늘어놓았다 — 무엇이 어떻게 놓이는지는 저장하고 사이트를 열어야
 * 알았고, 다단 레이아웃은 **안에 블록을 넣을 길이 없어** 빈 틀뿐이었다.
 *
 *   왼쪽  구성 — 블록 트리. 끌어서 옮기고, 다단 레이아웃 안에 넣는다(키보드는 오른쪽 단추로 같은 일).
 *   가운데 미리보기 — 저장하지 않은 지금 내용을 **실제 테마로** 서버가 그린다. 누르면 그 블록을 고른다.
 *   오른쪽 고른 블록의 설정 · 페이지 설정.
 *
 * 미리보기는 서버에 초안을 맡기고(POST) 그 주소를 창에 띄운다 — 사이트와 같은 보안 정책으로 떠야
 * 테마의 글꼴·스크립트가 공개 화면과 똑같이 돈다(pages.controller.ts 의 draft-preview 참고).
 * 편집할 때마다 새로 그리므로 창 둘을 번갈아 쓴다: 뒤에서 다 그린 창을 앞으로 올려 깜빡임을 없앤다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useAdminT } from "../../../../lib/i18n-admin";
import {
  applyTextEdit, duplicateAt, flatten, getNode, indentIntoPrevious, insertAt, isPrefix, moveNode, moveSibling,
  outdent, parsePath, pathKey, removeAt, samePath, updateAt, type BlockNode, type Path,
} from "../../../../lib/block-tree";

export type { BlockNode } from "../../../../lib/block-tree";

export interface BlockDef {
  name: string;
  displayName: string;
  acceptsChildren?: boolean;
  propsSchema?: { properties?: Record<string, { type?: string; title?: string; format?: string; default?: unknown }> };
}

export interface PageDraft {
  id?: string;
  slug: string;
  title: string;
  status: string;
  publishedAt?: string | null;
  blocks: BlockNode[];
  seo: { title?: string; description?: string };
}

type Viewport = "desktop" | "tablet" | "mobile";
const VIEWPORT_WIDTH: Record<Viewport, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };

/** 편집기 창 하나의 이름 — 초안 미리보기 칸을 가른다. http 로 연 관리 화면에는 randomUUID 가 없다 */
function newSession(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** 입력 칸에서 누른 단축키는 가로채지 않는다 — 글자 되돌리기는 칸의 몫이다 */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function LayoutEditor(props: {
  draft: PageDraft;
  catalog: BlockDef[];
  onChange: (d: PageDraft) => void;
  /** 페이지 설정(제목·주소·상태·SEO·이전 버전) — 목록 화면이 가진 것을 그대로 받는다 */
  pageSettings: ReactNode;
}) {
  const t = useAdminT();
  const { draft, catalog, onChange } = props;
  const defOf = useCallback((name: string) => catalog.find((b) => b.name === name), [catalog]);
  const accepts = useCallback((name: string) => Boolean(defOf(name)?.acceptsChildren), [defOf]);
  const labelOf = useCallback(
    (name: string) => defOf(name)?.displayName ?? `${t("pages.unknownBlock")} (${name})`,
    [defOf, t],
  );

  const [selected, setSelected] = useState<Path | null>(null);
  const [tab, setTab] = useState<"block" | "page">("block");
  const [picker, setPicker] = useState<{ parent: Path; index: number } | null>(null);

  // ── 되돌리기 ──────────────────────────────────────
  // 블록 트리만 기록한다. 같은 칸을 이어서 타이핑하면 한 번으로 묶는다(글자마다 쌓이면 되돌리기가 쓸모없다)
  const past = useRef<BlockNode[][]>([]);
  const future = useRef<BlockNode[][]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commit = useCallback((blocks: BlockNode[], opts: { select?: Path | null; coalesce?: string } = {}) => {
    const now = Date.now();
    const same = opts.coalesce && lastKey.current?.key === opts.coalesce && now - lastKey.current.at < 1200;
    if (!same) {
      past.current.push(draftRef.current.blocks);
      if (past.current.length > 100) past.current.shift();
    }
    future.current = [];
    lastKey.current = opts.coalesce ? { key: opts.coalesce, at: now } : null;
    onChange({ ...draftRef.current, blocks });
    if (opts.select !== undefined) setSelected(opts.select);
    bump((n) => n + 1);
  }, [onChange]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(draftRef.current.blocks);
    lastKey.current = null;
    onChange({ ...draftRef.current, blocks: prev });
    setSelected((s) => (s && getNode(prev, s) ? s : null));
    bump((n) => n + 1);
  }, [onChange]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(draftRef.current.blocks);
    lastKey.current = null;
    onChange({ ...draftRef.current, blocks: next });
    setSelected((s) => (s && getNode(next, s) ? s : null));
    bump((n) => n + 1);
  }, [onChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || typingIn(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── 트리 조작 ─────────────────────────────────────
  const apply = (r: { tree: BlockNode[]; path: Path } | null) => { if (r) commit(r.tree, { select: r.path }); };
  const selectedNode = selected ? getNode(draft.blocks, selected) : undefined;

  function addBlock(name: string) {
    if (!picker) return;
    const def = defOf(name);
    const init: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def?.propsSchema?.properties ?? {})) {
      if (v.default !== undefined) init[k] = v.default;
    }
    const node: BlockNode = def?.acceptsChildren ? { block: name, props: init, children: [] } : { block: name, props: init };
    apply(insertAt(draft.blocks, picker.parent, picker.index, node));
    setPicker(null);
    setTab("block");
  }

  // ── 미리보기 ──────────────────────────────────────
  const [session] = useState(newSession);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [showPreview, setShowPreview] = useState(true);
  const [frames, setFrames] = useState<[string, string]>(["", ""]);
  const [front, setFront] = useState<0 | 1>(0);
  const [previewState, setPreviewState] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const frameA = useRef<HTMLIFrameElement>(null);
  const frameB = useRef<HTMLIFrameElement>(null);
  const frameOf = (i: 0 | 1) => (i === 0 ? frameA : frameB);
  const scrollY = useRef(0);
  const seq = useRef(0);
  const frontRef = useRef<0 | 1>(0);
  frontRef.current = front;

  // 미리보기가 그리는 것은 블록·제목·주소·SEO 뿐이다 — 상태·예약 시각을 바꿔도 다시 그리지 않는다
  const previewBody = useMemo(
    () => JSON.stringify({ session, slug: draft.slug, title: draft.title, blocks: draft.blocks, seo: draft.seo }),
    [session, draft.slug, draft.title, draft.blocks, draft.seo],
  );

  useEffect(() => {
    if (!showPreview) return;
    const my = ++seq.current;
    setPreviewState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/pages/draft-preview", {
          method: "POST", headers: { "content-type": "application/json" }, body: previewBody,
        });
        const data = await res.json().catch(() => ({}));
        if (my !== seq.current) return;
        if (!res.ok || !data.url) {
          setPreviewState({ busy: false, error: String(data.message ?? res.status) });
          return;
        }
        // 뒤쪽 창에 그린다 — 다 그리면(onLoad) 앞으로 올린다
        const back = frontRef.current === 0 ? 1 : 0;
        const src = `${data.url}?v=${my}#y=${scrollY.current}`;
        setFrames((f) => (back === 0 ? [src, f[1]] : [f[0], src]));
        setPreviewState({ busy: true, error: "" });
      } catch (err) {
        if (my === seq.current) setPreviewState({ busy: false, error: err instanceof Error ? err.message : String(err) });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [previewBody, showPreview]);

  const highlight = useCallback((reveal: boolean) => {
    const win = (frontRef.current === 0 ? frameA : frameB).current?.contentWindow;
    if (!win) return;
    const node = selected ? getNode(draftRef.current.blocks, selected) : undefined;
    win.postMessage({
      brick: "highlight",
      path: selected && node ? pathKey(selected) : "",
      label: node ? labelOf(node.block) : "",
      reveal,
    }, window.location.origin);
  }, [selected, labelOf]);

  useEffect(() => { highlight(true); }, [highlight]);

  // 메시지 처리기는 한 번만 단다 — 그 안에서 쓰는 최신 값은 ref 로 본다
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const fromFront = e.source === (frontRef.current === 0 ? frameA : frameB).current?.contentWindow;
      const d = (e.data ?? {}) as { brick?: string; path?: string; y?: number; prop?: unknown; value?: unknown };
      if (!fromFront || !d.brick) return;
      if (d.brick === "text") {
        // 미리보기에서 글자를 고쳤다 — 스키마의 글자 속성인지 다시 보고 반영한다
        const r = applyTextEdit(draftRef.current.blocks, d.path, d.prop, d.value,
          (block) => catalogRef.current.find((b) => b.name === block)?.propsSchema?.properties);
        if (r && r.tree !== draftRef.current.blocks) commitRef.current(r.tree, { select: r.path });
        else if (r) setSelected(r.path);
        return;
      }
      if (d.brick === "select") {
        const p = d.path ? parsePath(d.path) : null;
        setSelected(p && getNode(draftRef.current.blocks, p) ? p : null);
        if (p) setTab("block");
      } else if (d.brick === "scroll" && typeof d.y === "number") {
        scrollY.current = d.y;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function onFrameLoad(i: 0 | 1) {
    if (!frames[i]) return;
    // 뒤에서 다 그린 창을 앞으로 — 옛 창의 스크롤을 새 창이 이어받는다(#y=)
    if (i !== frontRef.current) { setFront(i); frontRef.current = i; }
    setPreviewState((s) => ({ ...s, busy: false }));
    highlight(false);
  }

  // ── 구성(개요) 끌어다 놓기 ─────────────────────────
  const rows = flatten(draft.blocks);
  const dragging = useRef<Path | null>(null);
  const [dropHint, setDropHint] = useState<{ key: string; where: "before" | "after" | "inside" } | null>(null);

  function whereFor(e: DragEvent<HTMLElement>, node: BlockNode): "before" | "after" | "inside" {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientY - box.top) / Math.max(1, box.height);
    if (accepts(node.block) && rel > 0.28 && rel < 0.72) return "inside";
    return rel < 0.5 ? "before" : "after";
  }
  function onDrop(e: DragEvent<HTMLElement>, path: Path, node: BlockNode) {
    e.preventDefault();
    const from = dragging.current;
    dragging.current = null;
    setDropHint(null);
    if (!from) return;
    const where = whereFor(e, node);
    const parent = where === "inside" ? path : path.slice(0, -1);
    const index = where === "inside" ? (node.children?.length ?? 0) : path[path.length - 1] + (where === "after" ? 1 : 0);
    apply(moveNode(draft.blocks, from, parent, index));
  }

  const iconBtn = { cursor: "pointer", minWidth: 32, minHeight: 32, padding: "0 8px" } as const;
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  return (
    <div>
      {/* 도구 줄 */}
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        <button type="button" onClick={undo} disabled={!canUndo} style={iconBtn} title={`${t("pages.undo")} (Ctrl+Z)`}>↶ {t("pages.undo")}</button>
        <button type="button" onClick={redo} disabled={!canRedo} style={iconBtn} title={`${t("pages.redo")} (Ctrl+Shift+Z)`}>↷ {t("pages.redo")}</button>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label={t("pages.viewport")} className="flex gap-1">
          {(["desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <button key={v} type="button" onClick={() => { setViewport(v); setShowPreview(true); }}
              aria-pressed={showPreview && viewport === v} style={{ ...iconBtn, fontWeight: showPreview && viewport === v ? 700 : 400 }}>
              {t(v === "desktop" ? "pages.vpDesktop" : v === "tablet" ? "pages.vpTablet" : "pages.vpMobile")}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setShowPreview((s) => !s)} aria-pressed={!showPreview} style={iconBtn}>
          {showPreview ? t("pages.previewHide") : t("pages.previewShow")}
        </button>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        {/* ── 왼쪽: 구성 ── */}
        <nav aria-label={t("pages.outline")} className="w-full shrink-0 xl:w-[250px]"
          style={{ background: "var(--color-bg)", borderRadius: 8, padding: 12 }}>
          <strong style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("pages.outline")}</strong>
          {!rows.length && <p style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("pages.outlineEmpty")}</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
            {rows.map(({ path, node, depth }) => {
              const key = pathKey(path);
              const isSel = samePath(path, selected);
              const hint = dropHint?.key === key ? dropHint.where : null;
              return (
                <li key={key}
                  draggable
                  onDragStart={(e) => { dragging.current = path; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", key); }}
                  onDragEnd={() => { dragging.current = null; setDropHint(null); }}
                  onDragOver={(e) => {
                    const from = dragging.current;
                    if (!from || isPrefix(from, path)) return;
                    e.preventDefault();
                    const where = whereFor(e, node);
                    if (dropHint?.key !== key || dropHint.where !== where) setDropHint({ key, where });
                  }}
                  onDragLeave={() => { if (dropHint?.key === key) setDropHint(null); }}
                  onDrop={(e) => onDrop(e, path, node)}
                  style={{
                    marginLeft: depth * 14,
                    borderTop: hint === "before" ? "2px solid var(--color-primary, #2563eb)" : "2px solid transparent",
                    borderBottom: hint === "after" ? "2px solid var(--color-primary, #2563eb)" : "2px solid transparent",
                    outline: hint === "inside" ? "2px dashed var(--color-primary, #2563eb)" : "none",
                    borderRadius: 6,
                  }}>
                  <button type="button" onClick={() => { setSelected(path); setTab("block"); }}
                    aria-current={isSel ? "true" : undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", font: "inherit", fontSize: 13,
                      color: "inherit", cursor: "grab", border: 0, borderRadius: 6, padding: "6px 8px",
                      background: isSel ? "var(--color-primary-soft, rgba(37,99,235,.12))" : "none",
                      fontWeight: isSel ? 700 : 400,
                    }}>
                    <span aria-hidden="true" style={{ color: "var(--color-muted)" }}>⋮⋮</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelOf(node.block)}</span>
                    {accepts(node.block) && <span style={{ fontSize: 11, color: "var(--color-muted)" }}>{node.children?.length ?? 0}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => setPicker({ parent: [], index: draft.blocks.length })}
            style={{ width: "100%", padding: 10, cursor: "pointer", border: "2px dashed var(--color-line-strong)", background: "none", borderRadius: 8 }}>
            {t("pages.addBlock")}
          </button>
          {rows.length > 0 && <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "8px 0 0" }}>{t("pages.dragHint")}</p>}
          {rows.length > 0 && showPreview && <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "6px 0 0" }}>{t("pages.inlineHint")}</p>}
        </nav>

        {/* ── 가운데: 미리보기 ── */}
        {showPreview && (
          <section aria-label={t("pages.preview")} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: previewState.error ? "var(--color-danger)" : "var(--color-muted)", minHeight: 18, marginBottom: 4 }}
              role={previewState.error ? "alert" : "status"}>
              {previewState.error ? t("pages.previewFail", { msg: previewState.error }) : previewState.busy ? t("pages.previewLoading") : ""}
            </div>
            <div style={{ overflowX: "auto", background: "var(--color-surface, #f4f4f5)", borderRadius: 8, padding: viewport === "desktop" ? 0 : 12 }}>
              <div style={{ position: "relative", width: VIEWPORT_WIDTH[viewport], maxWidth: viewport === "desktop" ? "100%" : undefined, margin: "0 auto", height: "calc(100vh - 220px)", minHeight: 480 }}>
                {([0, 1] as const).map((i) => (
                  <iframe key={i} ref={frameOf(i)} src={frames[i] || "about:blank"}
                    title={t("pages.previewFrame")}
                    sandbox="allow-scripts allow-same-origin"
                    onLoad={() => onFrameLoad(i)}
                    tabIndex={i === front ? 0 : -1}
                    aria-hidden={i === front ? undefined : true}
                    style={{
                      position: "absolute", inset: 0, width: "100%", height: "100%", border: "1px solid var(--color-line)",
                      borderRadius: 8, background: "#fff",
                      visibility: i === front ? "visible" : "hidden",
                    }} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── 오른쪽: 설정 ── */}
        <aside className="w-full shrink-0 xl:w-[300px]" style={{ background: "var(--color-bg)", borderRadius: 8, padding: 12 }}>
          <div role="tablist" className="flex gap-1" style={{ marginBottom: 12 }}>
            {(["block", "page"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                style={{ flex: 1, cursor: "pointer", padding: "6px 8px", fontWeight: tab === k ? 700 : 400,
                  borderBottom: tab === k ? "2px solid var(--color-primary, #2563eb)" : "2px solid transparent" }}>
                {k === "block" ? t("pages.tabBlock") : t("pages.tabPage")}
              </button>
            ))}
          </div>

          {tab === "page" ? props.pageSettings : !selected || !selectedNode ? (
            <p style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("pages.pickHint")}</p>
          ) : (
            <div>
              <strong>{labelOf(selectedNode.block)}</strong>
              <div className="flex flex-wrap gap-1" style={{ margin: "8px 0 12px" }}>
                <button type="button" style={iconBtn} title={t("pages.moveUp")} aria-label={t("pages.moveUp")}
                  onClick={() => apply(moveSibling(draft.blocks, selected, -1))}>↑</button>
                <button type="button" style={iconBtn} title={t("pages.moveDown")} aria-label={t("pages.moveDown")}
                  onClick={() => apply(moveSibling(draft.blocks, selected, 1))}>↓</button>
                <button type="button" style={iconBtn} title={t("pages.outdent")} aria-label={t("pages.outdent")}
                  disabled={selected.length < 2} onClick={() => apply(outdent(draft.blocks, selected))}>⇤</button>
                <button type="button" style={iconBtn} title={t("pages.indent")} aria-label={t("pages.indent")}
                  onClick={() => apply(indentIntoPrevious(draft.blocks, selected, accepts))}>⇥</button>
                <button type="button" style={iconBtn} title={t("pages.duplicate")} aria-label={t("pages.duplicate")}
                  onClick={() => apply(duplicateAt(draft.blocks, selected))}>⧉</button>
                <button type="button" style={{ ...iconBtn, color: "var(--color-danger)" }} title={t("pages.remove")} aria-label={t("pages.remove")}
                  onClick={() => commit(removeAt(draft.blocks, selected), { select: null })}>✕</button>
              </div>
              <PropsForm node={selectedNode} def={defOf(selectedNode.block)}
                onChange={(n, key) => commit(updateAt(draft.blocks, selected, () => n), { coalesce: `${pathKey(selected)}:${key}` })} />
              <div className="flex flex-col gap-2" style={{ marginTop: 16 }}>
                <button type="button" style={{ cursor: "pointer", padding: 8 }}
                  onClick={() => setPicker({ parent: selected.slice(0, -1), index: selected[selected.length - 1] + 1 })}>
                  {t("pages.addAfter")}
                </button>
                {accepts(selectedNode.block) && (
                  <button type="button" style={{ cursor: "pointer", padding: 8 }}
                    onClick={() => setPicker({ parent: selected, index: selectedNode.children?.length ?? 0 })}>
                    {t("pages.addInside")}
                  </button>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {picker && <BlockPicker catalog={catalog} onPick={addBlock} onClose={() => setPicker(null)} />}
    </div>
  );
}

/* ── 블록 고르기 ─────────────────────────────────────── */
function BlockPicker(props: { catalog: BlockDef[]; onPick: (name: string) => void; onClose: () => void }) {
  const t = useAdminT();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const needle = q.trim().toLowerCase();
  const list = needle
    ? props.catalog.filter((b) => b.displayName.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle))
    : props.catalog;
  return (
    <div role="dialog" aria-modal="true" aria-label={t("pages.addBlock")}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center", padding: 16 }}>
      <div aria-hidden="true" onClick={props.onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.35)" }} />
      <div style={{ position: "relative", width: "min(520px, 100%)", maxHeight: "80vh", overflow: "auto", background: "var(--color-bg)", borderRadius: 10, padding: 16, boxShadow: "0 10px 30px rgba(0,0,0,.2)" }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pages.searchBlocks")}
            aria-label={t("pages.searchBlocks")} style={{ flex: 1, padding: 8 }} />
          <button type="button" onClick={props.onClose} style={{ cursor: "pointer", padding: "8px 12px" }}>{t("common.close")}</button>
        </div>
        {!list.length && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>{t("pages.noBlocksFound")}</p>}
        {list.map((b) => (
          <button key={b.name} type="button" onClick={() => props.onPick(b.name)}
            style={{
              display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit",
              background: "none", border: 0, borderBottom: "1px solid var(--color-line)", padding: "10px 8px", cursor: "pointer",
            }}>
            <strong>{b.displayName}</strong> <span style={{ color: "var(--color-muted)", fontSize: 12 }}>{b.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── 블록 속성: propsSchema 로 만든 폼 ───────────────────── */
function PropsForm(props: { node: BlockNode; def?: BlockDef; onChange: (n: BlockNode, key: string) => void }) {
  const t = useAdminT();
  const { node, def } = props;
  const schema = def?.propsSchema?.properties ?? {};
  const input = { width: "100%", padding: 6, boxSizing: "border-box" as const, marginTop: 2 };
  // 옮겨 온 페이지에는 props 가 없는 노드가 있다
  const values = node.props ?? {};
  const setProp = (key: string, value: unknown) => props.onChange({ ...node, props: { ...values, [key]: value } }, key);
  if (!def) return <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{t("pages.unknownBlockHelp")}</p>;
  if (!Object.keys(schema).length) return <p style={{ color: "var(--color-muted)", fontSize: 13 }}>{t("pages.noProps")}</p>;
  return (
    <div>
      {Object.entries(schema).map(([key, meta]) => (
        <label key={key} style={{ display: "block", marginTop: 8, fontSize: 13 }}>
          {meta.title ?? key}
          {meta.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(values[key])} onChange={(e) => setProp(key, e.target.checked)}
              style={{ marginLeft: 8 }} />
          ) : meta.type === "number" ? (
            <input type="number" style={input} value={String(values[key] ?? "")}
              onChange={(e) => setProp(key, e.target.value === "" ? undefined : Number(e.target.value))} />
          ) : meta.format === "multiline" ? (
            <textarea style={{ ...input, height: 120, fontFamily: "monospace" }} value={String(values[key] ?? "")}
              onChange={(e) => setProp(key, e.target.value)} />
          ) : (
            <input style={input} value={String(values[key] ?? "")} onChange={(e) => setProp(key, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}
