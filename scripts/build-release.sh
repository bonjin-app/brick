#!/usr/bin/env bash
#
# 배포본 생성 — FTP로 올려서 바로 실행할 수 있는 tarball.
#
# 왜 필요한가:
#   FTP 호스팅에서는 `pnpm build` 나 `npm install` 을 돌릴 수 없다.
#   그래서 **빌드도 의존성 설치도 필요 없는** 자기완결적 배포본을 미리 만든다.
#
# 사용법: bash scripts/build-release.sh [버전]
#   결과:  dist-release/brick-<버전>.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
OUT="$ROOT/dist-release"
STAGE="$OUT/brick"

echo "▶ Brick $VERSION 배포본 생성"

command -v pnpm >/dev/null || { echo "pnpm이 필요합니다."; exit 1; }

rm -rf "$OUT"
mkdir -p "$STAGE"

echo "── 1/5 빌드"
(cd "$ROOT" && pnpm build >/dev/null)

echo "── 2/5 API 번들 (pnpm deploy — 심볼릭 링크 없는 자기완결 node_modules)"
pnpm --dir "$ROOT" deploy --filter=@brick/api --prod "$STAGE/api" >/dev/null 2>&1
# 소스는 배포본에 넣지 않는다 (용량 + 불필요)
rm -rf "$STAGE/api/src" "$STAGE/api/tsconfig.json" "$STAGE/api/nest-cli.json"
cp -R "$ROOT/packages/database/migrations" "$STAGE/api/migrations"

# node_modules를 배포본 **루트**로 올린다.
#
# 이유: 플러그인 dist/index.js 는 "drizzle-orm", "@brick/plugin-sdk" 등을 bare import 한다.
# Node는 상위로 올라가며 node_modules를 찾으므로, 루트에 두면 api와 플러그인이
# **같은 사본**을 쓴다. 사본이 둘이면 drizzle의 sql 객체 identity가 어긋나
# 쿼리가 인식되지 않는다 (실제로 발생했던 문제).
mv "$STAGE/api/node_modules" "$STAGE/node_modules"

# 플러그인이 쓰는 SDK는 api 의존성이 아니므로 따로 넣어준다
mkdir -p "$STAGE/node_modules/@brick/plugin-sdk"
cp "$ROOT/packages/plugin-sdk/package.json" "$STAGE/node_modules/@brick/plugin-sdk/"
cp -R "$ROOT/packages/plugin-sdk/dist" "$STAGE/node_modules/@brick/plugin-sdk/dist"
# workspace:* 참조는 배포본에서 해석할 수 없으므로 제거한다 (실제 모듈은 형제 경로에 있다)
node -e "
const fs = require('fs');
const p = '$STAGE/node_modules/@brick/plugin-sdk/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
  if (!pkg[field]) continue;
  for (const [name, ver] of Object.entries(pkg[field])) {
    if (String(ver).startsWith('workspace:')) delete pkg[field][name];
  }
  if (!Object.keys(pkg[field]).length) delete pkg[field];
}
fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
"

echo "── 3/5 Web 번들 (Next.js standalone)"
mkdir -p "$STAGE/web"
cp -R "$ROOT/apps/web/.next/standalone/." "$STAGE/web/"
mkdir -p "$STAGE/web/apps/web/.next"
cp -R "$ROOT/apps/web/.next/static" "$STAGE/web/apps/web/.next/static"
[[ -d "$ROOT/apps/web/public" ]] && cp -R "$ROOT/apps/web/public" "$STAGE/web/apps/web/public"

echo "── 4/5 확장 · 런처"
mkdir -p "$STAGE/plugins" "$STAGE/themes" "$STAGE/uploads" "$STAGE/data"
# 목록을 여기 적지 않는다 — 빌드된 플러그인을 전부 동봉한다 (collect-plugins.sh)
bash "$ROOT/scripts/collect-plugins.sh" "$STAGE/plugins"
# 동봉 테마도 목록을 적지 않는다 — themes/ 아래 매니페스트가 있는 디렉터리 전부
for THEME_DIR in "$ROOT"/themes/*/; do
  [[ -f "$THEME_DIR/brick.theme.json" ]] && cp -R "$THEME_DIR" "$STAGE/themes/$(basename "$THEME_DIR")"
done
cp "$ROOT/LICENSE" "$STAGE/LICENSE"

# 단일 진입점: 이것만 실행하면 API와 Web이 함께 뜬다
cat > "$STAGE/server.js" <<'LAUNCHER'
#!/usr/bin/env node
/**
 * Brick 실행 진입점.
 *
 * 이 파일 하나만 실행하면 내부 API와 공개 웹이 함께 뜬다.
 * cPanel/Plesk의 "Node.js App"에서 시작 파일로 이것을 지정하면 된다.
 *
 * 빌드도 의존성 설치도 필요 없다 — 배포본에 모두 포함되어 있다.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
// 내부 API 포트. 외부에 노출되지 않는다.
const API_PORT = Number(process.env.BRICK_API_PORT || PORT + 1);

let VERSION = "0.0.0-dev";
try { VERSION = String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || VERSION); } catch {}

const env = {
  ...process.env,
  BRICK_VERSION: process.env.BRICK_VERSION || VERSION,
  PORT: String(PORT),
  /*
   * Next standalone 은 `process.env.HOSTNAME || "0.0.0.0"` 를 **바인딩 주소**로 쓴다.
   * 리눅스 로그인 셸과 컨테이너에는 HOSTNAME 이 설정되어 있어, 그대로 두면 서버가 그 이름이
   * 가리키는 주소에만 리스닝한다 — 127.0.0.1 로 오는 요청(프록시·헬스체크)이 닿지 않는다.
   * 특정 인터페이스에만 열려면 BRICK_WEB_HOST 로 지정한다.
   */
  HOSTNAME: process.env.BRICK_WEB_HOST || "0.0.0.0",
  BRICK_API_PORT: String(API_PORT),
  BRICK_API_URL: process.env.BRICK_API_URL || `http://127.0.0.1:${API_PORT}`,
  BRICK_CONFIG_PATH: process.env.BRICK_CONFIG_PATH || path.join(ROOT, "data", "brick.config.json"),
  BRICK_PLUGINS_DIR: process.env.BRICK_PLUGINS_DIR || path.join(ROOT, "plugins"),
  BRICK_THEMES_DIR: process.env.BRICK_THEMES_DIR || path.join(ROOT, "themes"),
  BRICK_UPLOADS_DIR: process.env.BRICK_UPLOADS_DIR || path.join(ROOT, "uploads"),
  BRICK_MIGRATIONS_DIR: process.env.BRICK_MIGRATIONS_DIR || path.join(ROOT, "api", "migrations"),
};

for (const dir of ["data", "uploads", "plugins", "themes"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}

// ── 고아 프로세스 정리 ────────────────────────────
// 런처가 SIGKILL로 죽으면 자식(api/web)이 살아남아 포트를 계속 점유한다.
// 호스팅 패널의 강제 재시작에서 실제로 일어나므로, 시작할 때 이전 자식을 정리한다.
const PID_FILE = path.join(ROOT, "data", "brick.pid");

function killStaleChildren() {
  if (!fs.existsSync(PID_FILE)) return;
  let pids = [];
  try {
    pids = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    pids = [];
  }
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[brick] 이전 프로세스 정리 (pid ${pid})`);
    } catch {
      // 이미 종료됨 — 정상
    }
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 무시 */
  }
  // 포트가 풀릴 시간을 준다.
  // 동기 busy-wait은 CPU를 태우므로 execSync("sleep")으로 블로킹한다
  // (이 시점에는 이벤트 루프를 쓸 수 없다 — 아직 아무것도 시작하지 않았다).
  const stillAlive = () =>
    (Array.isArray(pids) ? pids : []).some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  for (let i = 0; i < 15 && stillAlive(); i++) {
    try {
      require("node:child_process").execFileSync("sleep", ["0.2"]);
    } catch {
      break;
    }
  }
}
killStaleChildren();

const children = [];
function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(children.map((c) => c.pid).filter(Boolean)));
  } catch {
    /* 쓰기 실패는 치명적이지 않다 */
  }
}

function start(name, cwd, script) {
  const child = spawn(process.execPath, [script], { cwd, env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[brick] ${name} 종료 (code=${code} signal=${signal}) — 전체를 중단합니다`);
    shutdown(code === 0 ? 1 : code || 1);
  });
  children.push(child);
  writePidFile();
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 무시 */
  }
  // 자식이 정리할 시간을 준 뒤 종료
  setTimeout(() => process.exit(code ?? 0), 3000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

console.log(`[brick] 시작 — 공개 포트 ${PORT}, 내부 API ${API_PORT}`);
start("api", path.join(ROOT, "api"), path.join("dist", "main.js"));

// API가 준비되면 웹을 띄운다 (설치 모드에서도 API는 응답한다)
const deadline = Date.now() + 60_000;
(function waitForApi() {
  const req = require("node:http").get(
    { host: "127.0.0.1", port: API_PORT, path: "/healthz", timeout: 2000 },
    (res) => {
      res.resume();
      console.log("[brick] api 준비 완료 — web 시작");
      start("web", path.join(ROOT, "web"), path.join("apps", "web", "server.js"));
    },
  );
  req.on("error", retry);
  req.on("timeout", () => { req.destroy(); retry(); });
  function retry() {
    if (Date.now() > deadline) {
      console.error("[brick] api가 60초 안에 시작되지 않았습니다. 위 로그를 확인하세요.");
      return shutdown(1);
    }
    setTimeout(waitForApi, 1000);
  }
})();
LAUNCHER
chmod +x "$STAGE/server.js"

# 운영자가 프로세스 밖에서 실행하는 업데이트·롤백 도구 (docs/upgrade.md)
cat > "$STAGE/update.mjs" <<'UPDATER'
#!/usr/bin/env node
/**
 * Brick 업데이트 도구 — 서버를 멈춘 뒤 실행한다.
 *
 *   node update.mjs                         최신 릴리스로
 *   node update.mjs 0.3.0                   특정 버전으로
 *   node update.mjs --from brick-0.3.0.tar.gz   내려받아 둔 파일로 (폐쇄망)
 *   node update.mjs --check                 새 버전이 있는지만 본다
 *   node update.mjs --rollback              직전 백업으로 되돌린다
 *   옵션: --yes(질문 생략) --force(같거나 낮은 버전도 허용)
 *
 * 하는 일: 내려받기 → SHA256 검증 → 풀기 → 앱 파일(server.js·api·web·node_modules 등)을
 * backup/ 으로 옮기고 새 파일을 제자리에 → 동봉 플러그인·테마는 같은 이름만 갱신.
 * data · uploads · 운영자가 설치한 플러그인/테마는 건드리지 않는다. DB 마이그레이션은
 * 다음 부팅에서 자동 적용된다. 앱 안에서 자기 자신을 바꾸지 않는 이유는 docs/architecture.md 참고.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = "bonjin-app/brick";
const APP_FILES = ["server.js", "update.mjs", "package.json", "README.txt", "LICENSE", "api", "web", "node_modules"];
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const wanted = args.find((a) => /^v?\d+\.\d+\.\d+/.test(a));

const current = readVersion(ROOT);
const log = (m) => console.log(m);
const die = (m) => { console.error("✖ " + m); process.exit(1); };

function readVersion(dir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "0.0.0"); } catch { return "0.0.0"; }
}
function cmp(a, b) {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map(Number), pb = b.replace(/^v/, "").split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function running() {
  const pidFile = path.join(ROOT, "data", "brick.pid");
  if (!fs.existsSync(pidFile)) return false;
  let pids = []; try { pids = JSON.parse(fs.readFileSync(pidFile, "utf8")); } catch { return false; }
  return (Array.isArray(pids) ? pids : []).some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
}
async function ask(q) {
  if (flag("--yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(q + " [y/N] ", r)); rl.close();
  return /^y(es)?$/i.test(String(a).trim());
}
async function gh(url) {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": `brick-updater/${current}` } });
  if (!res.ok) die(`GitHub 응답 ${res.status} (${url})`);
  return res.json();
}
// /releases/latest 는 프리릴리스를 제외한다(알파·베타만 있으면 404) — 목록에서 첫 릴리스를 고른다
async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `brick-updater/${current}` } });
  if (res.ok) return res.json();
  if (res.status !== 404) die(`GitHub 응답 ${res.status}`);
  const list = await gh(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
  const rel = (Array.isArray(list) ? list : []).find((r) => !r.draft);
  if (!rel) die("공개된 릴리스가 없습니다.");
  return rel;
}
async function download(url, to) {
  const res = await fetch(url, { headers: { "user-agent": `brick-updater/${current}` } });
  if (!res.ok) die(`내려받기 실패 ${res.status}: ${url}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function move(from, to) {
  try { fs.renameSync(from, to); }
  catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}

async function main() {
  if (flag("--rollback")) return rollback();
  log(`현재 버전: v${current}`);
  let tarball = opt("--from"), target = wanted?.replace(/^v/, ""), sums = null;
  if (!tarball) {
    const rel = target ? await gh(`https://api.github.com/repos/${REPO}/releases/tags/v${target}`) : await latestRelease();
    target = String(rel.tag_name).replace(/^v/, "");
    const c = cmp(target, current);
    log(`최신 릴리스: v${target}${c > 0 ? " — 새 버전" : c === 0 ? " — 이미 최신" : " — 현재보다 낮음"}`);
    if (flag("--check")) return;
    if (c <= 0 && !flag("--force")) { log("바꿀 것이 없습니다. (강제로 다시 설치하려면 --force)"); return; }
    const asset = (rel.assets || []).find((a) => /^brick-.*\.tar\.gz$/.test(a.name));
    const sumsAsset = (rel.assets || []).find((a) => a.name === "SHA256SUMS.txt");
    if (!asset || !sumsAsset) die("릴리스에 배포본(tar.gz)과 SHA256SUMS.txt 가 없습니다.");
    if (!(await ask(`v${current} → v${target} 으로 업데이트할까요?`))) return;
    const dl = path.join(ROOT, ".update"); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
    tarball = path.join(dl, asset.name); sums = path.join(dl, "SHA256SUMS.txt");
    log("내려받는 중…"); await download(asset.browser_download_url, tarball); await download(sumsAsset.browser_download_url, sums);
    const expected = fs.readFileSync(sums, "utf8").split("\n").find((l) => l.trim().endsWith(asset.name))?.split(/\s+/)[0];
    if (!expected) die("SHA256SUMS.txt 에 배포본 항목이 없습니다.");
    if (sha256(tarball) !== expected) die("체크섬이 다릅니다 — 내려받은 파일이 손상되었거나 바뀌었습니다. 중단합니다.");
    log("체크섬 확인 ✓");
  } else {
    if (!fs.existsSync(tarball)) die(`파일이 없습니다: ${tarball}`);
    if (flag("--check")) { log(`파일에서 설치: ${tarball}`); return; }
  }
  if (running()) die("서버가 아직 실행 중입니다. 먼저 멈추세요 (pm2 stop brick / 호스팅 패널의 Stop).");

  const extract = path.join(ROOT, ".update", "extract"); fs.rmSync(extract, { recursive: true, force: true }); fs.mkdirSync(extract, { recursive: true });
  execFileSync("tar", ["xzf", path.resolve(tarball), "-C", extract], { stdio: "inherit" });
  const src = fs.existsSync(path.join(extract, "brick", "server.js")) ? path.join(extract, "brick") : extract;
  if (!fs.existsSync(path.join(src, "server.js")) || !fs.existsSync(path.join(src, "api"))) die("배포본 구조가 아닙니다 (server.js·api 없음).");
  const next = readVersion(src);
  if (cmp(next, current) <= 0 && !flag("--force")) die(`배포본 v${next} 은 현재 v${current} 보다 낮거나 같습니다. (--force 로 강제)`);
  if (!tarball.includes(path.join(ROOT, ".update")) && !(await ask(`v${current} → v${next} 으로 업데이트할까요?`))) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(ROOT, "backup", `v${current}-${stamp}`); fs.mkdirSync(backup, { recursive: true });
  for (const f of APP_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) move(p, path.join(backup, f)); }
  for (const f of APP_FILES) { const p = path.join(src, f); if (fs.existsSync(p)) move(p, path.join(ROOT, f)); }
  // 동봉 플러그인·테마: 같은 이름만 갱신 (운영자가 설치한 것은 그대로)
  for (const kind of ["plugins", "themes"]) {
    const from = path.join(src, kind); if (!fs.existsSync(from)) continue;
    for (const name of fs.readdirSync(from)) {
      const dest = path.join(ROOT, kind, name);
      if (fs.existsSync(dest)) { fs.mkdirSync(path.join(backup, kind), { recursive: true }); move(dest, path.join(backup, kind, name)); }
      move(path.join(from, name), dest);
    }
  }
  fs.writeFileSync(path.join(ROOT, "backup", "LATEST"), path.basename(backup));
  fs.rmSync(path.join(ROOT, ".update"), { recursive: true, force: true });
  log(`✓ v${current} → v${next}. 백업: backup/${path.basename(backup)}`);
  log("이제 서버를 다시 시작하세요 — DB 마이그레이션은 부팅 때 자동 적용됩니다. 문제가 있으면 `node update.mjs --rollback`.");
}

async function rollback() {
  const latestFile = path.join(ROOT, "backup", "LATEST");
  if (!fs.existsSync(latestFile)) die("되돌릴 백업이 없습니다.");
  const backup = path.join(ROOT, "backup", fs.readFileSync(latestFile, "utf8").trim());
  if (!fs.existsSync(backup)) die(`백업 디렉터리가 없습니다: ${backup}`);
  if (running()) die("서버가 아직 실행 중입니다. 먼저 멈추세요.");
  const prev = readVersion(backup);
  if (!(await ask(`v${current} 을(를) 백업 v${prev} 으로 되돌릴까요? (DB 마이그레이션은 되돌리지 않습니다)`))) return;
  for (const f of APP_FILES) { const cur = path.join(ROOT, f); if (fs.existsSync(cur)) fs.rmSync(cur, { recursive: true, force: true }); const b = path.join(backup, f); if (fs.existsSync(b)) move(b, cur); }
  for (const kind of ["plugins", "themes"]) {
    const from = path.join(backup, kind); if (!fs.existsSync(from)) continue;
    for (const name of fs.readdirSync(from)) { const dest = path.join(ROOT, kind, name); fs.rmSync(dest, { recursive: true, force: true }); move(path.join(from, name), dest); }
  }
  fs.rmSync(backup, { recursive: true, force: true }); fs.rmSync(latestFile, { force: true });
  log(`✓ v${prev} 으로 되돌렸습니다. 서버를 다시 시작하세요.`);
}

main().catch((e) => die(e?.message || String(e)));
UPDATER

cat > "$STAGE/package.json" <<PKG
{
  "name": "brick-release",
  "version": "$VERSION",
  "private": true,
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=20.11" }
}
PKG

cat > "$STAGE/README.txt" <<'TXT'
Brick — 설치 안내
=================

요구사항: Node.js 20.11 이상, PostgreSQL 14 이상

1. 이 폴더의 모든 파일을 서버에 업로드합니다 (FTP/SFTP).
2. data, uploads, plugins, themes 디렉터리에 쓰기 권한을 줍니다.
3. server.js 를 실행합니다.
     - cPanel/Plesk: Node.js 앱 만들기 → 시작 파일 server.js → 실행
     - 직접 실행:    node server.js
     - 상시 실행:    pm2 start server.js --name brick
4. 브라우저로 사이트에 접속하면 설치 화면이 나옵니다.
   데이터베이스 정보를 입력하고 안내에 따라 진행하세요.
5. 데이터베이스 저장 후 한 번 재시작하면 설치가 이어집니다.

포트 변경:  PORT=8080 node server.js

업데이트 (권장 — 도구 사용):
  1. 서버를 멈춥니다 (pm2 stop brick / 호스팅 패널의 Stop).
  2. node update.mjs            ← 최신 릴리스를 내려받아 검증(SHA256)하고 교체합니다.
     node update.mjs --check    ← 새 버전이 있는지만 봅니다.
     node update.mjs --from brick-X.Y.Z.tar.gz  ← 미리 내려받은 파일로 (외부 접속이 안 될 때)
  3. 서버를 다시 시작합니다. 데이터베이스 마이그레이션은 자동 적용됩니다.
  문제가 있으면:  node update.mjs --rollback   (직전 백업으로 되돌립니다)
  이미지 썸네일 채우기(한 번만):  node api/dist/backfill-thumbs.js   (--dry 로 먼저 확인)
  data / uploads / 직접 설치한 플러그인·테마는 건드리지 않습니다. 이전 파일은 backup/ 에 남습니다.

업데이트 (수동):
  1. data / uploads / plugins / themes 를 백업합니다.
  2. 새 배포본의 api, web, node_modules, server.js, update.mjs 를 덮어씁니다.
     (data, uploads, plugins, themes 는 그대로 두세요)
  3. 재시작합니다.

문서: https://github.com/bonjin-app/brick
TXT

echo "── 5/5 압축"
mkdir -p "$OUT"
(cd "$OUT" && tar czf "brick-$VERSION.tar.gz" brick)
SIZE="$(du -h "$OUT/brick-$VERSION.tar.gz" | cut -f1)"

echo
echo "완료: dist-release/brick-$VERSION.tar.gz ($SIZE)"
echo "  전개 후 \`node server.js\` 만 실행하면 됩니다 (빌드·설치 불필요)."
