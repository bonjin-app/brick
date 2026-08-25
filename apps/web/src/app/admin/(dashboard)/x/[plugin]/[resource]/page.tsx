"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

/* ── 타입 (packages/core의 AdminResource와 대응) ───────── */
interface AdminField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "boolean" | "select" | "date" | "image" | "richtext";
  options?: Array<{ value: string; label: string }>;
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
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("리소스를 찾을 수 없습니다."))))
      .then(setRes)
      .catch((e: Error) => setError(e.message));
  }, [params.plugin, params.resource]);

  const reload = useCallback(async () => {
    if (!api) return;
    const r = await fetch(`${api}?page=${page}`);
    if (!r.ok) { setError("목록을 불러오지 못했습니다."); return; }
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
      setMessage(`${res!.itemLabel}을(를) 저장했습니다.`);
      setEditing(null);
      void reload();
    } else {
      const d = await r.json().catch(() => ({}));
      setMessage(`저장 실패: ${d.message ?? r.status}`);
    }
  }

  async function remove(row: Row) {
    if (!api) return;
    if (!confirm(`이 ${res!.itemLabel}을(를) 삭제할까요?`)) return;
    const r = await fetch(`${api}/${row[idField]}`, { method: "DELETE" });
    setMessage(r.ok ? "삭제했습니다." : `삭제 실패: ${(await r.json().catch(() => ({}))).message ?? r.status}`);
    void reload();
  }

  function blank(): Row {
    const row: Row = {};
    for (const f of res!.fields) {
      if (f.type === "boolean") row[f.name] = false;
      else if (f.type === "number" || f.type === "money") row[f.name] = 0;
      else if (f.type === "select") row[f.name] = f.options?.[0]?.value ?? "";
      else row[f.name] = "";
    }
    return row;
  }

  if (error) return <div><h1>오류</h1><p style={{ color: "crimson" }}>{error}</p></div>;
  if (!res) return <p>불러오는 중…</p>;

  const listFields = res.fields.filter((f) => f.inList);
  const can = { create: true, update: true, delete: true, ...res.can };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0, flex: 1 }}>
          {res.title} <span style={{ color: "#999", fontSize: 15 }}>{total}건</span>
        </h1>
        {can.create && !editing && (
          <button onClick={() => setEditing(blank())} style={btn}>+ {res.itemLabel} 추가</button>
        )}
      </div>
      {res.description && <p style={{ color: "#666", fontSize: 14 }}>{res.description}</p>}
      {message && <p style={{ color: "#0a7" }}>{message}</p>}

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
          <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
                  {listFields.map((f) => <th key={f.name} style={{ padding: 12 }}>{f.label}</th>)}
                  <th style={{ padding: 12, width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={String(row[idField] ?? i)} style={{ borderBottom: "1px solid #f4f4f7" }}>
                    {listFields.map((f) => (
                      <td key={f.name} style={{ padding: 12 }}>{formatCell(row[f.name], f)}</td>
                    ))}
                    <td style={{ padding: 12, whiteSpace: "nowrap" }}>
                      {can.update && <button onClick={() => setEditing({ ...row })} style={btnSm}>수정</button>}
                      {can.delete && <button onClick={() => remove(row)} style={{ ...btnSm, color: "crimson", marginLeft: 6 }}>삭제</button>}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={listFields.length + 1} style={{ padding: 24, color: "#999" }}>
                    아직 등록된 {res.itemLabel}이(가) 없습니다.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <button style={btnSm} disabled={page <= 1} onClick={() => setPage(page - 1)}>← 이전</button>
              <span style={{ fontSize: 13, color: "#666" }}>{page} 페이지</span>
              <button style={btnSm} disabled={rows.length === 0} onClick={() => setPage(page + 1)}>다음 →</button>
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
  const { resource, value, onChange } = props;
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 24, maxWidth: 680 }}>
      <h2 style={{ marginTop: 0 }}>{value[resource.idField ?? "id"] ? `${resource.itemLabel} 수정` : `새 ${resource.itemLabel}`}</h2>
      {resource.fields.filter((f) => !f.readOnly).map((f) => (
        <div key={f.name} style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 14, fontWeight: 600 }}>
            {f.label}{f.required && <span style={{ color: "crimson" }}> *</span>}
          </label>
          <FieldInput field={f} value={value[f.name]} onChange={(v) => set(f.name, v)} />
          {f.help && <div style={{ fontSize: 12.5, color: "#888", marginTop: 4 }}>{f.help}</div>}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <button onClick={props.onSave} style={{ ...btn, fontWeight: 700 }}>저장</button>
        <button onClick={props.onCancel} style={btn}>취소</button>
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: AdminField; value: unknown; onChange: (v: unknown) => void }) {
  const base = { width: "100%", padding: 9, marginTop: 4, boxSizing: "border-box" as const, border: "1px solid #ddd", borderRadius: 6 };

  switch (field.type) {
    case "boolean":
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 6 }} />;
    case "number":
    case "money":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="number" style={base} value={String(value ?? "")} placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
          {field.type === "money" && <span style={{ color: "#666", whiteSpace: "nowrap" }}>원</span>}
        </div>
      );
    case "select":
      return (
        <select style={base} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "textarea":
      return <textarea style={{ ...base, height: 100 }} value={String(value ?? "")} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)} />;
    case "richtext":
      return <textarea style={{ ...base, height: 220, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}
        value={String(value ?? "")} placeholder={field.placeholder ?? "HTML을 입력할 수 있습니다"}
        onChange={(e) => onChange(e.target.value)} />;
    case "image":
      return (
        <div>
          <input style={base} value={String(value ?? "")} placeholder="/uploads/... 또는 https://..."
            onChange={(e) => onChange(e.target.value)} />
          {typeof value === "string" && value && (
            <img src={value} alt="" style={{ maxHeight: 90, marginTop: 8, borderRadius: 6 }} />
          )}
          <div style={{ fontSize: 12.5, color: "#888", marginTop: 4 }}>
            <a href="/admin/media" target="_blank">미디어</a>에서 업로드한 뒤 URL을 붙여넣으세요.
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
  if (f.type === "select") return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
  if (f.type === "date") return new Date(String(v)).toLocaleString("ko-KR");
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

const btn = { cursor: "pointer", padding: "9px 18px", border: "1px solid #ddd", borderRadius: 6, background: "#fff" };
const btnSm = { cursor: "pointer", padding: "5px 10px", border: "1px solid #ddd", borderRadius: 5, background: "#fff", fontSize: 13 };
