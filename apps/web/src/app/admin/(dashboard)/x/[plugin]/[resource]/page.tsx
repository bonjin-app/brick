"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useAdminT } from "../../../../../../lib/i18n-admin";

/* ── 타입 (packages/core의 AdminResource와 대응) ───────── */
interface AdminField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "boolean" | "select" | "date" | "image" | "images" | "richtext";
  options?: Array<{ value: string; label: string }>;
  /** 선택지를 이 경로(플러그인 기준)에서 가져온다 */
  optionsFrom?: string;
  max?: number;
  required?: boolean;
  help?: string;
  inList?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}
interface AdminBulkAction {
  code: string;
  label: string;
  confirm?: string;
  destructive?: boolean;
  input?: { name: string; label: string; optionsFrom: string };
}
interface AdminResource {
  plugin: string;
  name: string;
  title: string;
  itemLabel: string;
  basePath: string;
  fields: AdminField[];
  idField?: string;
  can?: { create?: boolean; update?: boolean; delete?: boolean };
  description?: string;
  bulkActions?: AdminBulkAction[];
}
type Row = Record<string, unknown>;

/**
 * 범용 플러그인 관리 화면.
 *
 * 플러그인이 registerAdminResource로 선언한 스키마를 읽어
 * 목록·생성·수정·삭제 UI를 런타임에 생성한다.
 * 플러그인은 React 코드를 배포하지 않고도 완전한 관리 화면을 얻는다.
 */
export default function PluginResourcePage() {
  const t = useAdminT();
  const params = useParams<{ plugin: string; resource: string }>();
  const [res, setRes] = useState<AdminResource | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // 일괄 작업 — 선택된 행, 고른 작업, 작업에 딸린 값(예: 이동 대상)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCode, setBulkCode] = useState("");
  const [bulkParam, setBulkParam] = useState("");
  const [bulkOptions, setBulkOptions] = useState<Array<{ value: string; label: string }>>([]);

  const api = res ? `/api/plugins/${res.plugin}${res.basePath}` : null;
  const idField = res?.idField ?? "id";

  // 리소스 스키마 로드
  useEffect(() => {
    setRes(null);
    setError("");
    fetch(`/api/admin/resources/${params.plugin}/${params.resource}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("x.resourceNotFound")))))
      .then(async (loaded: AdminResource) => {
        // optionsFrom 이 있는 필드의 선택지를 라우트에서 채운다.
        // 분류처럼 선택지가 테이블 행인 경우가 있다.
        const dynamic = loaded.fields.filter((f) => f.optionsFrom);
        if (dynamic.length === 0) return loaded;
        const fetched = await Promise.all(
          dynamic.map(async (f) => {
            try {
              const r = await fetch(`/api/plugins/${loaded.plugin}${f.optionsFrom}`);
              if (!r.ok) return { name: f.name, options: [] };
              const d = await r.json();
              return { name: f.name, options: Array.isArray(d) ? d : [] };
            } catch {
              // 선택지를 못 가져와도 폼 전체를 막지 않는다 — 나머지는 편집할 수 있어야 한다
              return { name: f.name, options: [] };
            }
          }),
        );
        const byName = new Map(fetched.map((x) => [x.name, x.options]));
        return {
          ...loaded,
          fields: loaded.fields.map((f) =>
            f.optionsFrom ? { ...f, options: [...(f.options ?? []), ...(byName.get(f.name) ?? [])] } : f,
          ),
        };
      })
      .then(setRes)
      .catch((e: Error) => setError(e.message));
  }, [params.plugin, params.resource]);

  const reload = useCallback(async () => {
    if (!api) return;
    const r = await fetch(`${api}?page=${page}`);
    if (!r.ok) { setError(t("x.listLoadFail")); return; }
    const d = await r.json();
    // 플러그인은 { items, total } 또는 배열을 반환할 수 있다
    setRows(Array.isArray(d) ? d : (d.items ?? []));
    setTotal(Array.isArray(d) ? d.length : (d.total ?? 0));
  }, [api, page]);
  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (!api || !editing) return;
    const id = editing[idField];
    const isNew = !id;
    const body: Row = {};
    for (const f of res!.fields) {
      if (f.readOnly) continue;
      body[f.name] = editing[f.name];
    }
    const r = await fetch(isNew ? api : `${api}/${id}`, {
      method: isNew ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setMessage(t("x.savedItem", { label: res!.itemLabel }));
      setEditing(null);
      void reload();
    } else {
      const d = await r.json().catch(() => ({}));
      setMessage(`${t("common.saveFailPrefix")}${d.message ?? r.status}`);
    }
  }

  // 작업을 고르면 필요한 선택지(대상 게시판 등)를 그때 받는다
  const bulkAction = res?.bulkActions?.find((a) => a.code === bulkCode);
  useEffect(() => {
    setBulkParam("");
    setBulkOptions([]);
    if (!res || !bulkAction?.input) return;
    fetch(`/api/plugins/${res.plugin}${bulkAction.input.optionsFrom}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setBulkOptions(Array.isArray(d) ? d : []))
      .catch(() => setBulkOptions([]));
  }, [res, bulkAction]);

  async function runBulk() {
    if (!api || !bulkAction || selected.size === 0) return;
    if (bulkAction.input && !bulkParam) { setMessage(t("x.bulkNeedParam", { label: bulkAction.input.label })); return; }
    if (bulkAction.confirm && !confirm(bulkAction.confirm)) return;
    const params: Row = {};
    if (bulkAction.input) params[bulkAction.input.name] = bulkParam;
    const r = await fetch(`${api}/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: bulkAction.code, ids: [...selected], params }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      setMessage(t("x.bulkDone", { n: Number(d.affected ?? selected.size) }));
      setSelected(new Set());
      setBulkCode("");
      void reload();
    } else {
      setMessage(`${t("common.saveFailPrefix")}${d.message ?? r.status}`);
    }
  }
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(rows.map((r) => String(r[idField]))) : new Set());
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => { const next = new Set(prev); on ? next.add(id) : next.delete(id); return next; });

  async function remove(row: Row) {
    if (!api) return;
    if (!confirm(t("x.confirmDelete", { label: res!.itemLabel }))) return;
    const r = await fetch(`${api}/${row[idField]}`, { method: "DELETE" });
    setMessage(r.ok ? t("x.deleted") : `${t("x.deleteFailPrefix")}${(await r.json().catch(() => ({}))).message ?? r.status}`);
    void reload();
  }

  function blank(): Row {
    const row: Row = {};
    for (const f of res!.fields) {
      if (f.type === "boolean") row[f.name] = false;
      else if (f.type === "number" || f.type === "money") row[f.name] = 0;
      else if (f.type === "select") row[f.name] = f.required ? (f.options?.[0]?.value ?? "") : "";
      else row[f.name] = "";
    }
    return row;
  }

  if (error) return <div><h1>{t("common.error")}</h1><p style={{ color: "var(--color-danger)" }}>{error}</p></div>;
  if (!res) return <p>{t("common.loading")}</p>;

  const listFields = res.fields.filter((f) => f.inList);
  const can = { create: true, update: true, delete: true, ...res.can };
  const hasBulk = Boolean(res.bulkActions?.length);
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(String(r[idField])));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0, flex: 1 }}>
          {res.title} <span style={{ color: "var(--color-muted)", fontSize: 15 }}>{t("x.countN", { n: total })}</span>
        </h1>
        {can.create && !editing && (
          <button onClick={() => setEditing(blank())} style={btn}>{t("x.addItem", { label: res.itemLabel })}</button>
        )}
      </div>
      {res.description && <p style={{ color: "var(--color-text-soft)", fontSize: 14 }}>{res.description}</p>}
      {message && <p style={{ color: "var(--color-success)" }}>{message}</p>}

      {editing ? (
        <ResourceForm
          resource={res}
          value={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          {hasBulk && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "0 0 10px",
              padding: "10px 12px", borderRadius: 8, background: "var(--color-bg)", border: "1px solid var(--color-line)",
            }}>
              <span style={{ fontSize: 13.5, color: "var(--color-text-soft)" }}>
                {t("x.selectedN", { n: selected.size })}
              </span>
              <select aria-label={t("x.bulkPick")} value={bulkCode} onChange={(e) => setBulkCode(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-line-strong)" }}>
                <option value="">{t("x.bulkPick")}</option>
                {res.bulkActions!.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
              </select>
              {bulkAction?.input && (
                <select aria-label={bulkAction.input.label} value={bulkParam} onChange={(e) => setBulkParam(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-line-strong)" }}>
                  <option value="">{bulkAction.input.label}</option>
                  {bulkOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
              <button onClick={runBulk} disabled={!bulkAction || selected.size === 0}
                style={{ ...btnSm, ...(bulkAction?.destructive ? { color: "var(--color-danger)", borderColor: "var(--color-danger)" } : {}) }}>
                {t("x.bulkRun")}
              </button>
            </div>
          )}
          <div style={{ overflowX: "auto", background: "var(--color-bg)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
                  {hasBulk && (
                    <th style={{ padding: 12, width: 36 }}>
                      <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)}
                        aria-label={t("x.selectAll")} />
                    </th>
                  )}
                  {listFields.map((f) => <th key={f.name} style={{ padding: 12 }}>{f.label}</th>)}
                  <th style={{ padding: 12, width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={String(row[idField] ?? i)} style={{ borderBottom: "1px solid var(--color-line)" }}>
                    {hasBulk && (
                      <td style={{ padding: 12 }}>
                        <input type="checkbox" checked={selected.has(String(row[idField]))}
                          onChange={(e) => toggleOne(String(row[idField]), e.target.checked)} />
                      </td>
                    )}
                    {listFields.map((f) => (
                      <td key={f.name} style={{ padding: 12 }}>{formatCell(row[f.name], f)}</td>
                    ))}
                    <td style={{ padding: 12, whiteSpace: "nowrap" }}>
                      {can.update && <button onClick={() => setEditing({ ...row })} style={btnSm}>{t("common.edit")}</button>}
                      {can.delete && <button onClick={() => remove(row)} style={{ ...btnSm, color: "var(--color-danger)", marginLeft: 6 }}>{t("common.delete")}</button>}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={listFields.length + 1 + (hasBulk ? 1 : 0)} style={{ padding: 24, color: "var(--color-muted)" }}>
                    {t("x.emptyItems", { label: res.itemLabel })}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <button style={btnSm} disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("common.prev")}</button>
              <span style={{ fontSize: 13, color: "var(--color-text-soft)" }}>{t("common.pageN", { n: page })}</span>
              <button style={btnSm} disabled={rows.length === 0} onClick={() => setPage(page + 1)}>{t("common.next")}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── 폼: 필드 타입별 입력 위젯 ───────────────────────── */
function ResourceForm(props: {
  resource: AdminResource;
  value: Row;
  onChange: (r: Row) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useAdminT();
  const { resource, value, onChange } = props;
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });

  return (
    <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 24, maxWidth: 680 }}>
      <h2 style={{ marginTop: 0 }}>{value[resource.idField ?? "id"] ? t("x.editItem", { label: resource.itemLabel }) : t("x.newItem", { label: resource.itemLabel })}</h2>
      {resource.fields.filter((f) => !f.readOnly).map((f) => (
        <div key={f.name} style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 14, fontWeight: 600 }}>
            {f.label}{f.required && <span style={{ color: "var(--color-danger)" }}> *</span>}
          </label>
          <FieldInput field={f} value={value[f.name]} onChange={(v) => set(f.name, v)} />
          {f.help && <div style={{ fontSize: 12.5, color: "var(--color-muted)", marginTop: 4 }}>{f.help}</div>}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <button onClick={props.onSave} style={{ ...btn, fontWeight: 700 }}>{t("common.save")}</button>
        <button onClick={props.onCancel} style={btn}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

/** 입력칸의 공용 모양 — 사진 필드가 같은 모양을 써야 한다 */
const inputBase = {
  width: "100%", padding: 9, marginTop: 4, boxSizing: "border-box" as const,
  border: "1px solid var(--color-line-strong)", borderRadius: 6,
};

function FieldInput({ field, value, onChange }: { field: AdminField; value: unknown; onChange: (v: unknown) => void }) {
  const t = useAdminT();
  const base = inputBase;

  switch (field.type) {
    case "boolean":
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 6 }} />;
    case "number":
    case "money":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="number" style={base} value={String(value ?? "")} placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
          {field.type === "money" && <span style={{ color: "var(--color-text-soft)", whiteSpace: "nowrap" }}>원</span>}
        </div>
      );
    case "select":
      return (
        <select style={base} value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
          {/* 필수가 아니면 비울 수 있어야 한다 — 분류를 지정하지 않은 상품이 있다 */}
          {!field.required && <option value="">{t("x.noneOption")}</option>}
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "textarea":
      return <textarea style={{ ...base, height: 100 }} value={String(value ?? "")} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)} />;
    case "richtext":
      return <textarea style={{ ...base, height: 220, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}
        value={String(value ?? "")} placeholder={field.placeholder ?? t("x.richtextPh")}
        onChange={(e) => onChange(e.target.value)} />;
    case "image":
      return <ImageField value={value} onChange={onChange} />;
    case "images":
      return <ImageListField value={value} onChange={onChange} max={field.max ?? 20} />;
    case "date":
      return <input type="date" style={base} value={String(value ?? "").slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input style={base} value={String(value ?? "")} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)} />;
  }
}

/**
 * 사진 필드 — 주소를 직접 넣을 수도, 미디어에서 고를 수도 있다.
 *
 * 고르는 길이 없을 때 운영자는 새 탭으로 미디어를 열고 업로드한 뒤 주소를 복사해 돌아와
 * 붙여야 했다. 상품 하나에 사진 한 장이면 그 왕복이 한 번이지만, 스무 개를 등록하는 날에는
 * 스무 번이다. 주소 입력을 없애지는 않는다 — 외부 사진을 쓰는 운영자가 있다.
 */
function ImageField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const t = useAdminT();
  const [picking, setPicking] = useState(false);
  const url = typeof value === "string" ? value : "";
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input style={{ ...inputBase, flex: 1 }} value={url} placeholder="/uploads/... 또는 https://..."
          onChange={(e) => onChange(e.target.value)} />
        <button type="button" onClick={() => setPicking(true)}
          style={{ padding: "0 12px", border: "1px solid var(--color-line)", borderRadius: 6,
                   background: "var(--color-bg)", cursor: "pointer", whiteSpace: "nowrap" }}>
          {t("x.pickFromMedia")}
        </button>
      </div>
      {url && <img src={url} alt="" style={{ maxHeight: 90, marginTop: 8, borderRadius: 6 }} />}
      <div style={{ fontSize: 12.5, color: "var(--color-muted)", marginTop: 4 }}>
        <a href="/admin/media" target="_blank">{t("x.mediaLink")}</a> — {t("x.imageHint")}
      </div>
      {picking && <MediaPicker onClose={() => setPicking(false)} onPick={(picked) => { onChange(picked); setPicking(false); }} />}
    </div>
  );
}

/**
 * 사진 여러 장 — 값은 "한 줄에 주소 하나"인 문자열이다.
 *
 * 모양을 바꾸지 않는 이유: 서버는 이미 그 문자열을 파싱하고 있고(상품의 추가 이미지 20장),
 * 배열로 바꾸면 API·마이그레이션·기존 데이터가 전부 딸려 온다. 바뀐 것은 **편집하는 방법**
 * 뿐이다 — 주소를 스무 번 복사해 붙이던 것을 한 번에 고르고 순서로 정렬한다.
 */
function ImageListField({ value, onChange, max }: { value: unknown; onChange: (v: unknown) => void; max: number }) {
  const t = useAdminT();
  const [picking, setPicking] = useState(false);
  const [manual, setManual] = useState("");
  const list = String(value ?? "").split("\n").map((v) => v.trim()).filter(Boolean);
  const write = (next: string[]) => onChange(next.slice(0, max).join("\n"));
  const move = (i: number, by: number) => {
    const next = [...list];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setPicking(true)}
          style={{ padding: "7px 12px", border: "1px solid var(--color-line)", borderRadius: 6,
                   background: "var(--color-bg)", cursor: "pointer" }}>
          {t("x.pickFromMedia")}
        </button>
        <span style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{t("x.imagesCount", { n: list.length, max })}</span>
      </div>
      {list.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(96px,1fr))", gap: 10, marginTop: 10 }}>
          {list.map((url, i) => (
            <div key={`${url}-${i}`} style={{ border: "1px solid var(--color-line)", borderRadius: 8, overflow: "hidden",
                                              background: "var(--color-bg)", position: "relative" }}>
              <img src={url} alt="" loading="lazy" decoding="async"
                style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              {/* 첫 장이 대표가 된다 — 순서가 뜻을 가지므로 옮길 수단을 함께 둔다 */}
              <div style={{ display: "flex", gap: 2, padding: 3, justifyContent: "center" }}>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t("x.moveLeft")}
                  style={{ cursor: i > 0 ? "pointer" : "default", padding: "1px 6px" }}>←</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label={t("x.moveRight")}
                  style={{ cursor: i < list.length - 1 ? "pointer" : "default", padding: "1px 6px" }}>→</button>
                <button type="button" onClick={() => write(list.filter((_, j) => j !== i))} aria-label={t("common.delete")}
                  style={{ cursor: "pointer", padding: "1px 6px" }}>✕</button>
              </div>
              {i === 0 && (
                <span style={{ position: "absolute", top: 4, left: 4, fontSize: 10.5, fontWeight: 700, padding: "2px 5px",
                               borderRadius: 4, background: "rgba(20,20,28,.78)", color: "#fff" }}>{t("x.mainImage")}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {/* 외부 사진을 쓰는 운영자를 막지 않는다 */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <input style={{ ...inputBase, marginTop: 0, flex: 1 }} value={manual} placeholder="https://... 또는 /uploads/..."
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (manual.trim()) { write([...list, manual.trim()]); setManual(""); }
          }} />
        <button type="button" disabled={!manual.trim()}
          onClick={() => { write([...list, manual.trim()]); setManual(""); }}
          style={{ padding: "0 12px", border: "1px solid var(--color-line)", borderRadius: 6,
                   background: "var(--color-bg)", cursor: manual.trim() ? "pointer" : "default" }}>
          {t("x.addUrl")}
        </button>
      </div>
      {picking && (
        <MediaPicker multiple onClose={() => setPicking(false)}
          onPickMany={(urls) => { write([...list, ...urls]); setPicking(false); }} />
      )}
    </div>
  );
}

interface PickerRow { id: string; url: string; thumbUrl?: string; fileName: string; contentType: string }

/**
 * 미디어에서 사진 고르기 — 격자는 썸네일로 그리고, 고른 값은 원본 주소다.
 * (저장할 때 서버가 대응하는 썸네일을 찾아 적으므로 목록은 알아서 작은 사진을 쓴다.)
 *
 * `multiple` 이면 여러 장을 담아 한 번에 돌려준다. 한 장씩 닫고 다시 여는 것은
 * 스무 장을 고르는 날에 스무 번의 왕복이다.
 */
function MediaPicker({ onPick, onPickMany, onClose, multiple }: {
  onPick?: (url: string) => void;
  onPickMany?: (urls: string[]) => void;
  onClose: () => void;
  multiple?: boolean;
}) {
  const t = useAdminT();
  const [chosen, setChosen] = useState<string[]>([]);
  const [data, setData] = useState<{ items: PickerRow[]; total: number; pageSize: number }>({ items: [], total: 0, pageSize: 40 });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback((p: number) => {
    fetch(`/api/media?page=${p}`).then((r) => r.json()).then(setData).catch(() => undefined);
  }, []);
  useEffect(() => load(page), [load, page]);
  // 모달은 Esc 로 닫힌다 (테마 미리보기와 같은 관례)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(t("x.uploading"));
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/media/upload", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    setBusy("");
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok || !body.url) { setBusy(`${t("common.failPrefix")}${body.message ?? res.status}`); return; }
    // 올리자마자 쓰려고 올린 것이다 — 고르는 손을 한 번 더 요구하지 않는다
    if (multiple) { setChosen((c) => [...c, String(body.url)]); load(page); }
    else onPick?.(String(body.url));
  }

  const images = data.items.filter((f) => f.contentType?.startsWith("image/"));
  const lastPage = Math.max(1, Math.ceil(data.total / (data.pageSize || 40)));
  return (
    <div role="dialog" aria-modal="true" aria-label={t("x.pickFromMedia")}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(10,10,14,.55)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: "min(4vh, 32px) min(4vw, 32px)" }}>
      <div style={{ background: "var(--color-bg-sunken, #fff)", borderRadius: 10, padding: 18,
                    width: "min(880px, 100%)", maxHeight: "100%", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <strong style={{ fontSize: 15 }}>{t("x.pickFromMedia")}</strong>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept="image/*" onChange={upload} style={{ fontSize: 13 }} />
            <button type="button" onClick={onClose}
              style={{ padding: "6px 12px", border: "1px solid var(--color-line)", borderRadius: 6,
                       background: "var(--color-bg)", cursor: "pointer" }}>{t("common.close")}</button>
          </span>
        </div>
        {busy && <p style={{ fontSize: 13, color: "var(--color-muted)" }}>{busy}</p>}
        {images.length === 0
          ? <p style={{ color: "var(--color-muted)", fontSize: 13, padding: "24px 0" }}>{t("x.noImages")}</p>
          : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 12 }}>
              {images.map((f) => {
                const on = chosen.includes(f.url);
                return (
                <button key={f.id} type="button" title={f.fileName}
                  onClick={() => multiple
                    ? setChosen((c) => on ? c.filter((u) => u !== f.url) : [...c, f.url])
                    : onPick?.(f.url)}
                  style={{ padding: 0, borderRadius: 8, overflow: "hidden", position: "relative",
                           border: on ? "2px solid var(--color-primary, #d0402c)" : "1px solid var(--color-line)",
                           background: "var(--color-bg)", cursor: "pointer", display: "block" }}>
                  <img src={f.thumbUrl ?? f.url} alt={f.fileName} loading="lazy" decoding="async"
                    style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                  <span style={{ display: "block", fontSize: 11.5, padding: "5px 6px", overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-muted)" }}>{f.fileName}</span>
                  {on && (
                    <span style={{ position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: 10,
                                   display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
                                   background: "var(--color-primary, #d0402c)", color: "#fff" }}>
                      {chosen.indexOf(f.url) + 1}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          )}
        {multiple && (
          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
            <button type="button" disabled={chosen.length === 0} onClick={() => onPickMany?.(chosen)}
              style={{ padding: "8px 14px", borderRadius: 6, border: 0, fontWeight: 700,
                       background: chosen.length ? "var(--color-primary, #d0402c)" : "var(--color-line)",
                       color: chosen.length ? "#fff" : "var(--color-muted)",
                       cursor: chosen.length ? "pointer" : "default" }}>
              {t("x.addChosen", { n: chosen.length })}
            </button>
            {chosen.length > 0 && (
              <button type="button" onClick={() => setChosen([])} style={{ padding: "8px 12px", cursor: "pointer" }}>
                {t("x.clearChosen")}
              </button>
            )}
            <span style={{ fontSize: 12.5, color: "var(--color-muted)" }}>{t("x.pickOrderHint")}</span>
          </div>
        )}
        {lastPage > 1 && (
          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}
              style={{ padding: "6px 10px", cursor: page > 1 ? "pointer" : "default" }}>{t("common.prev")}</button>
            <span style={{ fontSize: 13, color: "var(--color-muted)" }}>{page} / {lastPage}</span>
            <button type="button" disabled={page >= lastPage} onClick={() => setPage(page + 1)}
              style={{ padding: "6px 10px", cursor: page < lastPage ? "pointer" : "default" }}>{t("common.next")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatCell(v: unknown, f: AdminField): string {
  if (v === null || v === undefined || v === "") return "-";
  if (f.type === "money") return `${Number(v).toLocaleString("ko-KR")}원`;
  if (f.type === "boolean") return v ? "✓" : "—";
  if (f.type === "number") return Number(v).toLocaleString("ko-KR");
  if (f.type === "select") {
    if (v === null || v === undefined || v === "") return "";
    // 들여쓰기용 공백은 목록에서 떼고 보여준다
    return (f.options?.find((o) => o.value === String(v))?.label ?? String(v)).replace(/^\u00a0+/, "");
  }
  if (f.type === "date") return new Date(String(v)).toLocaleString("ko-KR");
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

const btn = { cursor: "pointer", padding: "9px 18px", border: "1px solid var(--color-line-strong)", borderRadius: 6, background: "var(--color-bg)" };
const btnSm = { cursor: "pointer", padding: "5px 10px", border: "1px solid var(--color-line-strong)", borderRadius: 5, background: "var(--color-bg)", fontSize: 13 };
