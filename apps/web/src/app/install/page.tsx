"use client";

import { useCallback, useEffect, useState } from "react";

type Stage = "loading" | "database" | "saved" | "site" | "done" | "error";

interface SetupStatus {
  state: string;
  configPath?: string;
  configWritable?: boolean;
  configWriteError?: string;
}

/**
 * 설치 마법사.
 *
 * 두 가지 경로를 모두 지원한다:
 *  - Docker: DATABASE_URL이 이미 있으므로 DB 단계를 건너뛰고 사이트 정보만 입력
 *  - FTP 업로드: DB 정보부터 입력받아 설정 파일을 쓴다
 */
export default function InstallPage() {
  const [stage, setStage] = useState<Stage>("loading");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [db, setDb] = useState({
    host: "localhost", port: 5432, database: "brick", user: "brick", password: "", ssl: false,
  });
  const [site, setSite] = useState({ siteName: "", adminEmail: "", adminPassword: "" });

  const probeState = useCallback(async () => {
    const res = await fetch("/api/install/status");
    if (!res.ok) {
      setStage("error");
      setError("서버에 연결할 수 없습니다.");
      return;
    }
    const data = await res.json();
    if (data.state === "needs_database") {
      const s = await fetch("/api/setup/status").then((r) => r.json()).catch(() => null);
      setSetup(s);
      setStage("database");
    } else if (data.state === "installed") {
      setStage("done");
    } else {
      setStage("site");
    }
  }, []);
  useEffect(() => { void probeState(); }, [probeState]);

  async function testDb() {
    setBusy(true);
    setError("");
    setMessage("");
    const res = await fetch("/api/setup/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(db),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) setMessage(data.message);
    else setError(data.message ?? "연결 테스트에 실패했습니다.");
    setBusy(false);
  }

  async function saveDb() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/setup/save", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...db, siteUrl: window.location.origin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setMessage(data.message ?? "");
      setStage("saved");
    } else setError(data.message ?? "저장에 실패했습니다.");
    setBusy(false);
  }

  async function installSite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/install", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(site),
    });
    if (res.ok) setStage("done");
    else setError((await res.json().catch(() => ({}))).message ?? "설치에 실패했습니다.");
    setBusy(false);
  }

  const input = { width: "100%", padding: 9, marginTop: 4, boxSizing: "border-box" as const, border: "1px solid #ddd", borderRadius: 6 };
  const card = { background: "#fff", borderRadius: 12, padding: 28, boxShadow: "0 2px 12px rgba(0,0,0,.07)" };

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 520, margin: "60px auto", padding: 24 }}>
      <h1 style={{ textAlign: "center", letterSpacing: -1 }}>BRICK</h1>
      <p style={{ textAlign: "center", color: "#888", marginTop: -8 }}>설치</p>

      <Steps stage={stage} />

      {stage === "loading" && <p style={{ textAlign: "center", color: "#666" }}>확인 중…</p>}

      {stage === "error" && (
        <div style={card}>
          <p style={{ color: "crimson" }}>{error}</p>
          <button onClick={() => void probeState()} style={{ cursor: "pointer", padding: "9px 18px" }}>다시 시도</button>
        </div>
      )}

      {/* ── 1단계: 데이터베이스 ── */}
      {stage === "database" && (
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 19 }}>데이터베이스 연결</h2>
          <p style={{ color: "#666", fontSize: 14 }}>
            호스팅에서 발급받은 PostgreSQL 정보를 입력하세요. 데이터베이스는 미리 만들어져 있어야 합니다.
          </p>

          {setup && setup.configWritable === false && (
            <div style={{ background: "#fdf2f0", border: "1px solid #f3d0ca", borderRadius: 8, padding: 14, fontSize: 13.5 }}>
              <strong>설정 파일을 쓸 수 없습니다.</strong>
              <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12.5 }}>{setup.configPath}</div>
              <div style={{ marginTop: 6, color: "#666" }}>
                해당 디렉터리에 쓰기 권한을 주세요. FTP 클라이언트에서 권한을 707 또는 755로 변경할 수 있습니다.
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginTop: 16 }}>
            <label style={{ fontSize: 14 }}>호스트
              <input style={input} value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} />
            </label>
            <label style={{ fontSize: 14 }}>포트
              <input style={input} type="number" value={db.port}
                onChange={(e) => setDb({ ...db, port: Number(e.target.value) })} />
            </label>
          </div>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>데이터베이스 이름
            <input style={input} value={db.database} onChange={(e) => setDb({ ...db, database: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>사용자
            <input style={input} value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>비밀번호
            <input style={input} type="password" value={db.password}
              onChange={(e) => setDb({ ...db, password: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>
            <input type="checkbox" checked={db.ssl} onChange={(e) => setDb({ ...db, ssl: e.target.checked })} />
            {" "}SSL 연결 사용 <span style={{ color: "#999" }}>(클라우드 DB는 대부분 필요)</span>
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <button onClick={testDb} disabled={busy} style={{ cursor: "pointer", padding: "11px 20px" }}>
              연결 테스트
            </button>
            <button onClick={saveDb} disabled={busy || setup?.configWritable === false}
              style={{ cursor: "pointer", padding: "11px 20px", fontWeight: 700, flex: 1 }}>
              {busy ? "처리 중…" : "저장하고 계속"}
            </button>
          </div>
          {message && <p style={{ color: "#0a7", fontSize: 14 }}>{message}</p>}
          {error && <p style={{ color: "crimson", fontSize: 14, whiteSpace: "pre-line" }}>{error}</p>}
        </div>
      )}

      {/* ── 저장 완료 → 재시작 안내 ── */}
      {stage === "saved" && (
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 19 }}>데이터베이스 설정 완료</h2>
          <p style={{ color: "#444" }}>{message}</p>
          <p style={{ color: "#666", fontSize: 14 }}>
            설정을 적용하려면 서버를 다시 시작해야 합니다. 호스팅 관리 화면에서 앱을 재시작하거나,
            직접 실행 중이라면 프로세스를 다시 띄우세요.
          </p>
          <ul style={{ color: "#666", fontSize: 13.5, paddingLeft: 20 }}>
            <li>cPanel / Plesk: Node.js 앱 화면에서 <strong>Restart</strong></li>
            <li>Docker: <code>docker compose restart</code></li>
            <li>직접 실행: 프로세스 종료 후 재실행</li>
          </ul>
          <button onClick={() => void probeState()} style={{ cursor: "pointer", padding: "11px 22px", fontWeight: 700 }}>
            재시작했습니다 — 계속
          </button>
        </div>
      )}

      {/* ── 2단계: 사이트 정보 ── */}
      {stage === "site" && (
        <form onSubmit={installSite} style={card}>
          <h2 style={{ marginTop: 0, fontSize: 19 }}>사이트 정보</h2>
          <label style={{ display: "block", fontSize: 14 }}>사이트 이름
            <input style={input} required value={site.siteName}
              onChange={(e) => setSite({ ...site, siteName: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>관리자 이메일
            <input style={input} type="email" required value={site.adminEmail}
              onChange={(e) => setSite({ ...site, adminEmail: e.target.value })} />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 12 }}>관리자 비밀번호 (8자 이상)
            <input style={input} type="password" required minLength={8} value={site.adminPassword}
              onChange={(e) => setSite({ ...site, adminPassword: e.target.value })} />
          </label>
          <button disabled={busy} style={{ width: "100%", padding: 13, marginTop: 22, cursor: "pointer", fontWeight: 700 }}>
            {busy ? "설치 중…" : "설치 완료"}
          </button>
          {error && <p style={{ color: "crimson", fontSize: 14 }}>{error}</p>}
        </form>
      )}

      {/* ── 완료 ── */}
      {stage === "done" && (
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 19 }}>설치가 완료되었습니다</h2>
          <p style={{ color: "#666", fontSize: 14 }}>
            관리자로 로그인해 페이지를 만들고 플러그인을 설치할 수 있습니다.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <a href="/admin" style={{ padding: "11px 22px", background: "#d0402c", color: "#fff", borderRadius: 8, textDecoration: "none", fontWeight: 700 }}>
              관리자로 이동
            </a>
            <a href="/" style={{ padding: "11px 22px", border: "1px solid #ddd", borderRadius: 8, textDecoration: "none", color: "#333" }}>
              사이트 보기
            </a>
          </div>
        </div>
      )}
    </main>
  );
}

/** 진행 표시 */
function Steps({ stage }: { stage: Stage }) {
  const steps = [
    { key: "db", label: "데이터베이스", active: stage === "database" || stage === "saved", done: stage === "site" || stage === "done" },
    { key: "site", label: "사이트 정보", active: stage === "site", done: stage === "done" },
    { key: "done", label: "완료", active: stage === "done", done: false },
  ];
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "20px 0 24px" }}>
      {steps.map((s) => (
        <div key={s.key} style={{
          fontSize: 13, padding: "5px 14px", borderRadius: 20,
          background: s.active ? "#d0402c" : s.done ? "#e8f5ec" : "#f0f0f4",
          color: s.active ? "#fff" : s.done ? "#0a7" : "#999",
          fontWeight: s.active ? 700 : 400,
        }}>
          {s.done ? "✓ " : ""}{s.label}
        </div>
      ))}
    </div>
  );
}
