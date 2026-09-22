"use client";

import { useCallback, useEffect, useState } from "react";
import { useUnsavedGuard } from "@/lib/unsaved-guard";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

/* ── 타입 ─────────────────────────────────────────── */
interface PageRow { id: string; slug: string; title: string; status: string; updatedAt: string; publishedAt?: string | null }
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
  /** 예약 발행이면 공개할 시각 (ISO). 다른 상태에서는 쓰지 않는다 */
  publishedAt?: string | null;
  blocks: BlockNode[];
  seo: { title?: string; description?: string };
}

/** ISO → datetime-local 입력값 (브라우저 시간대). 값이 없으면 빈 칸 */
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 목록에 보여줄 짧은 시각 */
function formatWhen(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : toLocalInput(iso).replace("T", " ");
}

const EMPTY: PageDraft = { slug: "", title: "", status: "draft", blocks: [], seo: {} };

/* ── 페이지 목록 + 빌더 ─────────────────────────────── */
export default function AdminPagesPage() {
  const localeTag = useLocaleTag();
  const t = useAdminT();
  const [rows, setRows] = useState<PageRow[]>([]);
  const [catalog, setCatalog] = useState<BlockDef[]>([]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  // 연 시점의 모습 — 이것과 다르면 저장하지 않은 편집이 있다
  const [pristine, setPristine] = useState<string>("");
  const [message, setMessage] = useState("");
  /*
   * 성공과 실패가 **같은 자리**를 쓴다 — 그러면 색과 role 도 결과를 따라야 한다.
   * 초록 글씨로 "저장 실패: …" 를 띄우고 있었고, role 이 없어 스크린리더에는 아무
   * 일도 일어나지 않은 화면이었다. 문구로 판별하지 않는다 — 번역을 고치면 색이
   * 뒤집힌다(메뉴 화면에서 겪은 일이다).
   */
  const [failed, setFailed] = useState(false);
  const dirty = draft !== null && JSON.stringify(draft) !== pristine;
  useUnsavedGuard(dirty);
  /*
   * "닫기" 는 화면 안에서만 움직이므로 브라우저 경고가 뜨지 않는다 — 오히려 이쪽이
   * 더 흔한 손실 경로다. 블록을 열몇 개 쌓아 둔 채 닫으면 그대로 사라졌다.
   */
  function closeEditor() {
    if (dirty && !confirm(t("common.discardChanges"))) return;
    setDraft(null);
    setMessage("");
    setFailed(false);
  }

  const reload = useCallback(() => {
    fetch("/api/pages").then((r) => r.json()).then(setRows);
  }, []);
  useEffect(() => {
    reload();
    fetch("/api/blocks").then((r) => r.json()).then(setCatalog);
  }, [reload]);

  async function open(id: string) {
    const page = await fetch(`/api/pages/${id}`).then((r) => r.json());
    const opened = { ...page, blocks: page.blocks ?? [], seo: page.seo ?? {} };
    setDraft(opened);
    setPristine(JSON.stringify(opened));
  }

  async function save() {
    if (!draft) return;
    const isNew = !draft.id;
    const res = await fetch(isNew ? "/api/pages" : `/api/pages/${draft.id}`, {
      method: isNew ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    setFailed(!res.ok);
    if (res.ok) {
      setMessage(t("pages.saveDone"));
      if (isNew) setDraft(null);
      else setPristine(JSON.stringify(draft));
      reload();
    } else setMessage(`${t("common.saveFailPrefix")}${(await res.json()).message ?? res.status}`);
  }

  async function remove(id: string) {
    if (!confirm(t("pages.confirmDelete"))) return;
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
        failed={failed}
        onChange={setDraft}
        onSave={save}
        onDelete={draft.id ? () => remove(draft.id!) : undefined}
        onClose={closeEditor}
      />
    );
  }

  return (
    <div>
      <h1>{t("pages.title")}</h1>
      <button onClick={() => { setDraft({ ...EMPTY }); setPristine(JSON.stringify(EMPTY)); }} style={{ cursor: "pointer", padding: "8px 16px", marginBottom: 16 }}>
        {t("pages.new")}
      </button>
      {message && (
        <p role={failed ? "alert" : "status"}
          style={{ color: failed ? "var(--color-danger)" : "var(--color-success)" }}>{message}</p>
      )}
      {/* 좁은 화면에서는 카드로 접힌다 (관리 셸의 .brick-x-table) */}
      <table className="brick-x-table" style={{ width: "100%", background: "var(--color-bg)", borderRadius: 8, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
            <th style={{ padding: 12 }}>{t("common.title")}</th><th>{t("pages.colSlug")}</th><th>{t("common.status")}</th><th>{t("pages.colUpdated")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--color-line)", cursor: "pointer" }} onClick={() => open(p.id)}>
              {/*
                행 클릭만으로는 키보드로 페이지를 열 수 없었다 — 이 표에는 수정
                버튼이 따로 없어서 **여는 길이 마우스뿐**이었다. 제목을 버튼으로
                두어 Tab 으로 닿게 한다(행 클릭은 마우스 편의로 그대로 둔다).
              */}
              <td data-label={t("common.title")} style={{ padding: 12 }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); open(p.id); }}
                  style={{ font: "inherit", color: "inherit", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}>
                  <strong>{p.title}</strong>
                </button>
              </td>
              <td data-label={t("pages.colSlug")}><code>/{p.slug}</code></td>
              <td data-label={t("common.status")}>
                {p.status === "scheduled"
                  /* 예약은 **언제**가 곧 상태다 — 시각 없이 "예약" 만 보이면 확인하러 들어가야 한다 */
                  ? `${t("pages.statusScheduled")} · ${formatWhen(p.publishedAt)}`
                  : p.status === "published" ? t("pages.published")
                  : p.status === "draft" ? t("pages.draft")
                  : t("pages.archived")}
              </td>
              <td data-label={t("pages.colUpdated")} style={{ color: "var(--color-muted)", fontSize: 13 }}>{new Date(p.updatedAt).toLocaleString(localeTag)}</td>
            </tr>
          ))}
          {!rows.length && <tr className="brick-x-empty"><td data-label="" colSpan={4} style={{ padding: 24, color: "var(--color-muted)" }}>{t("pages.empty")}</td></tr>}
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
  failed: boolean;
  onChange: (d: PageDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const t = useAdminT();
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
      <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 16 }}>
        <button onClick={props.onClose} style={{ cursor: "pointer" }}>{t("pages.backToList")}</button>
        <h1 style={{ margin: 0, flex: 1 }}>{draft.id ? t("pages.editTitle") : t("pages.newTitle")}</h1>
        {draft.status === "published" && draft.slug && (
          <a href={`/${draft.slug === "home" ? "" : draft.slug}`} target="_blank" style={{ fontSize: 14 }}>
            {t("pages.viewOnSite")}
          </a>
        )}
        {/*
          * 아직 공개 전인 페이지는 사이트 주소로 열면 404 다 — 그래서 예약해 둔
          * 화면을 열기 전에 확인할 방법이 없었다. 관리자 미리보기로 연결한다.
          * (저장하지 않은 수정은 보이지 않는다 — 서버가 저장된 것을 그린다)
          */}
        {draft.status !== "published" && draft.id && (
          <a href={`/api/admin/pages/${draft.id}/preview`} target="_blank" rel="noopener" style={{ fontSize: 14 }}>
            {t("pages.previewUnpublished")}
          </a>
        )}
        {props.onDelete && <button onClick={props.onDelete} style={{ cursor: "pointer", color: "var(--color-danger)" }}>{t("common.delete")}</button>}
        <button onClick={props.onSave} style={{ cursor: "pointer", padding: "8px 20px", fontWeight: 700 }}>{t("common.save")}</button>
      </div>
      {props.message && (
        <p role={props.failed ? "alert" : "status"}
          style={{ color: props.failed ? "var(--color-danger)" : "var(--color-success)" }}>{props.message}</p>
      )}

      {/* 좁은 화면에서는 설정 패널이 아래로 내려간다 — 편집 영역이 먼저 */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
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
              style={{ width: "100%", padding: 14, cursor: "pointer", border: "2px dashed var(--color-line-strong)", background: "none", borderRadius: 8 }}>
              {t("pages.addBlock")}
            </button>
            {picker && (
              <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line-strong)", borderRadius: 8, marginTop: 4, boxShadow: "0 4px 12px rgba(0,0,0,.1)" }}>
                {/*
                  진짜 버튼이어야 한다. div + onClick 은 마우스로만 눌린다 —
                  Tab 으로 닿지 않고 스크린리더도 "그냥 글"로 읽는다.
                  블록을 고르는 것은 이 CMS 의 중심 동작이라 특히 그렇다.
                */}
                {catalog.map((b) => (
                  <button key={b.name} type="button" onClick={() => addBlock(b.name)}
                    style={{
                      display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit",
                      background: "none", border: 0, borderBottom: "1px solid var(--color-line)",
                      padding: "10px 16px", cursor: "pointer",
                    }}>
                    <strong>{b.displayName}</strong> <span style={{ color: "var(--color-muted)", fontSize: 12 }}>{b.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 우: 페이지 설정 */}
        <aside className="w-full shrink-0 lg:w-[280px]" style={{ background: "var(--color-bg)", borderRadius: 8, padding: 16 }}>
          <label>{t("common.title")}<input style={input} value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>{t("pages.fieldSlug")}<input style={input} value={draft.slug}
            placeholder={t("pages.slugPh")} onChange={(e) => onChange({ ...draft, slug: e.target.value })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>{t("common.status")}
            <select style={input} value={draft.status} onChange={(e) => onChange({ ...draft, status: e.target.value })}>
              <option value="draft">{t("pages.statusDraft")}</option>
              <option value="scheduled">{t("pages.statusScheduled")}</option>
              <option value="published">{t("pages.statusPublished")}</option>
              <option value="archived">{t("pages.statusArchived")}</option>
            </select>
          </label>
          {/*
            * 예약을 고른 뒤에야 시각을 묻는다 — 늘 보이면 다른 상태에서
            * 아무 뜻도 없는 칸이 하나 늘어난다.
            *
            * datetime-local 은 **브라우저의 시간대**로 읽고 쓴다. 운영자가 보는
            * 시계가 곧 예약 시각이어야 하므로 그것이 맞다 — 저장할 때 ISO 로
            * 바꾸면서 시간대가 함께 실린다.
            */}
          {draft.status === "scheduled" && (
            <label style={{ display: "block", marginTop: 12 }}>{t("pages.publishAt")}
              <input type="datetime-local" style={input}
                value={toLocalInput(draft.publishedAt)}
                min={toLocalInput(new Date().toISOString())}
                onChange={(e) => onChange({
                  ...draft,
                  publishedAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                })} />
              <span style={{ fontSize: 12, color: "var(--color-muted)" }}>{t("pages.publishAtHint")}</span>
            </label>
          )}
          <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--color-line)" }} />
          <strong style={{ fontSize: 13, color: "var(--color-muted)" }}>SEO</strong>
          <label style={{ display: "block", marginTop: 8 }}>{t("pages.seoTitle")}<input style={input} value={draft.seo.title ?? ""}
            onChange={(e) => onChange({ ...draft, seo: { ...draft.seo, title: e.target.value } })} /></label>
          <label style={{ display: "block", marginTop: 12 }}>{t("common.description")}<textarea style={{ ...input, height: 60 }}
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
  const t = useAdminT();
  const { node, def } = props;
  const schema = def?.propsSchema?.properties ?? {};
  const input = { width: "100%", padding: 6, boxSizing: "border-box" as const, marginTop: 2 };

  function setProp(key: string, value: unknown) {
    props.onChange({ ...node, props: { ...node.props, [key]: value } });
  }

  return (
    <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 16, marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>{def?.displayName ?? node.block}</strong>
        <button onClick={props.onMoveUp} style={{ cursor: "pointer" }}>↑</button>
        <button onClick={props.onMoveDown} style={{ cursor: "pointer", marginLeft: 4 }}>↓</button>
        <button onClick={props.onRemove} style={{ cursor: "pointer", marginLeft: 8, color: "var(--color-danger)" }}>✕</button>
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
      {!Object.keys(schema).length && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>{t("pages.noProps")}</p>}
    </div>
  );
}
