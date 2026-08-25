"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface MediaRow {
  id: string; url: string; fileName: string; contentType: string; size: string; createdAt: string;
}

export default function AdminMediaPage() {
  const [data, setData] = useState<{ items: MediaRow[]; total: number }>({ items: [], total: 0 });
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch("/api/media").then((r) => r.json()).then(setData);
  }, []);
  useEffect(reload, [reload]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/media/upload", { method: "POST", body: fd });
    setMessage(res.ok ? "업로드 완료" : `실패: ${(await res.json()).message}`);
    if (fileRef.current) fileRef.current.value = "";
    reload();
  }

  async function remove(id: string) {
    if (!confirm("이 파일을 삭제할까요? 되돌릴 수 없습니다.")) return;
    await fetch(`/api/media/${id}`, { method: "DELETE" });
    reload();
  }

  const isImage = (t: string) => t.startsWith("image/");
  return (
    <div>
      <h1>미디어 <span style={{ color: "#999", fontSize: 16 }}>{data.total}개</span></h1>
      <form onSubmit={upload} style={{ background: "#fff", padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <strong>파일 업로드</strong>{" "}
        <input ref={fileRef} type="file" required />{" "}
        <button style={{ cursor: "pointer" }}>업로드</button>
        <span style={{ marginLeft: 8, color: "#888", fontSize: 13 }}>
          이미지 / PDF / 동영상 / ZIP — 실행 가능한 형식은 차단됩니다
        </span>
      </form>
      {message && <p style={{ color: "#0a7" }}>{message}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 16 }}>
        {data.items.map((f) => (
          <div key={f.id} style={{ background: "#fff", borderRadius: 8, padding: 12, fontSize: 13 }}>
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "#f6f6f9", borderRadius: 4, overflow: "hidden" }}>
              {isImage(f.contentType)
                ? <img src={f.url} alt={f.fileName} style={{ maxWidth: "100%", maxHeight: 100 }} />
                : <span style={{ fontSize: 32 }}>📄</span>}
            </div>
            <div style={{ marginTop: 8, wordBreak: "break-all" }}>{f.fileName}</div>
            <div style={{ color: "#999" }}>{Math.round(Number(f.size) / 1024)} KB</div>
            <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(f.url)} style={{ cursor: "pointer" }}>URL 복사</button>
              <button onClick={() => remove(f.id)} style={{ cursor: "pointer", color: "crimson" }}>삭제</button>
            </div>
          </div>
        ))}
        {!data.items.length && <p style={{ color: "#999" }}>아직 업로드된 파일이 없습니다.</p>}
      </div>
    </div>
  );
}
