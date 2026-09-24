"use client";

import { useCallback, useEffect, useState } from "react";
import { useUnsavedGuard } from "@/lib/unsaved-guard";
import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";
import { LayoutEditor, type BlockDef, type PageDraft } from "./layout-editor";

/* ── 타입 ─────────────────────────────────────────── */
interface PageRow { id: string; slug: string; title: string; status: string; updatedAt: string; publishedAt?: string | null }

/** 판 하나 (내용은 빼고 — 목록에 서른 판의 블록 JSON 을 실어 보내지 않는다) */
interface Revision {
  revNo: number;
  title: string;
  slug: string;
  status: string;
  note: string;
  createdAt: string;
  authorName: string | null;
  blockCount: number;
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
        onRestored={async () => {
          // 서버가 내용을 바꿨다 — 편집기를 다시 읽지 않으면 화면은 옛 내용을 들고 있다
          await open(draft.id!);
          setFailed(false);
          setMessage(t("pages.revRestored"));
          reload();
        }}
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
  /** 되돌린 뒤 편집기를 다시 읽는다 — 서버가 바꾼 내용을 화면이 알아야 한다 */
  onRestored: () => void;
}) {
  const t = useAdminT();
  const { draft, catalog, onChange } = props;
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revBusy, setRevBusy] = useState(0);

  /*
   * 판 목록은 저장할 때마다 달라진다 — draft.id 와 함께 마지막 저장 시각을
   * 의존성에 넣어, 저장 뒤에 목록이 옛것으로 남지 않게 한다.
   */
  useEffect(() => {
    if (!draft.id) { setRevisions([]); return; }
    fetch(`/api/pages/${draft.id}/revisions`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setRevisions(d.items ?? []))
      .catch(() => setRevisions([]));
  }, [draft.id, props.message]);

  async function restore(revNo: number) {
    if (!draft.id) return;
    if (!confirm(t("pages.revConfirm", { no: revNo }))) return;
    setRevBusy(revNo);
    try {
      const res = await fetch(`/api/pages/${draft.id}/revisions/${revNo}/restore`, { method: "POST" });
      if (res.ok) props.onRestored();
    } finally {
      setRevBusy(0);
    }
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

      <LayoutEditor draft={draft} catalog={catalog} onChange={onChange} pageSettings={(
        <div>
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
          {/*
            * 이전 버전 — 덮어쓴 뒤에 잘못을 알아채도 되돌릴 수 있게.
            * 새 페이지(아직 저장 전)에는 보여주지 않는다: 되돌릴 것이 없다.
            */}
          {draft.id && (
            <>
              <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--color-line)" }} />
              <strong style={{ fontSize: 13, color: "var(--color-muted)" }}>{t("pages.revisions")}</strong>
              {revisions.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--color-muted)", marginTop: 8 }}>{t("pages.revNone")}</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 8 }}>
                  {revisions.map((r, i) => (
                    <li key={r.revNo} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      <span style={{ color: "var(--color-muted)" }}>{formatWhen(r.createdAt)}</span>{" "}
                      <b>{t("pages.revNo", { no: r.revNo })}</b>
                      {/* 맨 위가 지금 화면의 내용이다 — 되돌릴 것이 없으므로 버튼 대신 표시한다 */}
                      {i === 0 ? <span style={{ color: "var(--color-success)" }}> {t("pages.revCurrent")}</span> : (
                        <button onClick={() => restore(r.revNo)} disabled={revBusy === r.revNo}
                          style={{ cursor: "pointer", marginLeft: 6, fontSize: 12 }}>
                          {revBusy === r.revNo ? t("pages.revRestoring") : t("pages.revRestore")}
                        </button>
                      )}
                      <br />
                      <span style={{ color: "var(--color-text-soft)" }}>
                        {r.title} · {t("pages.revBlocks", { n: r.blockCount })}
                        {r.authorName ? ` · ${r.authorName}` : ""}
                      </span>
                      {r.note ? <><br /><span style={{ color: "var(--color-muted)" }}>{r.note}</span></> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )} />
    </div>
  );
}
