"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useAdminT } from "../../../../../../lib/i18n-admin";

/* ── 타입 (packages/core의 AdminResource와 대응) ───────── */
interface AdminField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "boolean" | "select" | "date" | "image" | "richtext";
  options?: Array<{ value: string; label: string }>;
  /** 선택지를 이 경로(플러그인 기준)에서 가져온다 */
  optionsFrom?: string;
  required?: boolean;
  help?: string;
  inList?: boolean;
  readOnly?: boolean;
  placeholder?: string;
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
          <div style={{ overflowX: "auto", background: "var(--color-bg)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-line)" }}>
                  {listFields.map((f) => <th key={f.name} style={{ padding: 12 }}>{f.label}</th>)}
                  <th style={{ padding: 12, width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={String(row[idField] ?? i)} style={{ borderBottom: "1px solid var(--color-line)" }}>
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
                  <tr><td colSpan={listFields.length + 1} style={{ padding: 24, color: "var(--color-muted)" }}>
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

function FieldInput({ field, value, onChange }: { field: AdminField; value: unknown; onChange: (v: unknown) => void }) {
  const t = useAdminT();
  const base = { width: "100%", padding: 9, marginTop: 4, boxSizing: "border-box" as const, border: "1px solid var(--color-line-strong)", borderRadius: 6 };

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
      return (
        <div>
          <input style={base} value={String(value ?? "")} placeholder="/uploads/... 또는 https://..."
            onChange={(e) => onChange(e.target.value)} />
          {typeof value === "string" && value && (
            <img src={value} alt="" style={{ maxHeight: 90, marginTop: 8, borderRadius: 6 }} />
          )}
          <div style={{ fontSize: 12.5, color: "var(--color-muted)", marginTop: 4 }}>
            <a href="/admin/media" target="_blank">{t("x.mediaLink")}</a> — {t("x.imageHint")}
          </div>
        </div>
      );
    case "date":
      return <input type="date" style={base} value={String(value ?? "").slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input style={base} value={String(value ?? "")} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)} />;
  }
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
