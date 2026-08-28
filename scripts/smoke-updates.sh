#!/usr/bin/env bash
#
# 원클릭 업데이트 E2E 스모크 — 서명 검증이 뿌리다.
#
# 원격에서 코드를 받아 설치하는 기능은 서명 검증 없이 만들면 **원격 코드
# 실행의 문**이 된다. 업데이트 서버가 뚫리거나 DNS 가 조작되면 임의 코드가
# 들어온다 — 오래된 CMS 들이 실제로 겪은 사고 유형이다.
#
# 못박는 것:
#   - 올바른 서명의 새 버전이 **원클릭으로 설치**되는가
#   - 변조된 ZIP 이 거부되는가 (sha256 + 서명)
#   - **다른 키로 서명한 ZIP 이 거부되는가** (키 고정 — 이것이 핵심이다)
#   - 다운그레이드가 거부되는가 (취약한 옛 버전을 되살리는 공격)
#   - 새 매니페스트가 고정된 키를 바꿔치기하지 못하는가
#   - http(비 localhost) 주소가 거부되는가
#   - 다른 확장의 매니페스트를 물려받으면 거부되는가
#   - 배포자 키가 없는 확장(동봉 플러그인)은 원격 업데이트를 제공하지 않는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-updates.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
UPD_PORT=42825
UPD="http://127.0.0.1:${UPD_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${UPD_PID:-}" ]]; then kill "$UPD_PID" 2>/dev/null || true; wait "$UPD_PID" 2>/dev/null || true; fi
  # 테스트 플러그인이 실제 plugins/ 에 설치된다 — 반드시 지운다
  rm -rf "$ROOT/plugins/upd-test" "$ROOT/plugins/upd-noremote" "$ROOT/plugins/upd-nokey" 2>/dev/null || true
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:220})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

psql_q() {
  node -e '
    const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
    (async () => {
      const c = new Client(process.env.DATABASE_URL); await c.connect();
      const r = await c.query(process.argv[1]);
      console.log(r.rows.map((x) => Object.values(x).join("|")).join("\n"));
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$1"
}

# ── 테스트 플러그인 ZIP 만들기 ──
# 실제 zip 형식이어야 한다 (설치기가 yauzl 로 푼다)
make_zip() {  # make_zip <버전> <출력파일> [updates_url] [publisher_key]
  local ver="$1" out="$2" upd_url="${3:-}" pubkey="${4:-}"
  local dir="$TMP/build-$ver"
  rm -rf "$dir"; mkdir -p "$dir/dist"
  python3 - "$dir" "$ver" "$upd_url" "$pubkey" <<'PY'
import json, sys
d, ver, upd, key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
manifest = {
  "name": "upd-test",
  "version": ver,
  "displayName": "업데이트 테스트",
  "brickVersion": ">=0.0.1",
  "entry": "dist/index.js",
}
if upd: manifest["updates"] = upd
if key: manifest["publisherKey"] = key
open(f"{d}/brick.plugin.json", "w").write(json.dumps(manifest))
open(f"{d}/dist/index.js", "w").write(f'export default () => {{}}; // v{ver}\n')
PY
  (cd "$dir" && zip -qr "$out" .)
}

sign_zip() {  # sign_zip <zip> <개인키> <url> <버전> [out]
  node "$ROOT/scripts/sign-extension.mjs" sign \
    --zip "$1" --key "$2" --url "$3" --name upd-test --version "$4" \
    --out "${5:-$TMP/serve/upd-test.update.json}" >/dev/null
}

echo "▶ 원클릭 업데이트 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

echo "── 배포자 키 두 벌 (정상 배포자 · 공격자)"
node "$ROOT/scripts/sign-extension.mjs" keygen --out "$TMP/publisher" >/dev/null
node "$ROOT/scripts/sign-extension.mjs" keygen --out "$TMP/attacker" >/dev/null
PUBKEY="$(cat "$TMP/publisher.public.txt" | tr -d '\n')"
[[ -n "$PUBKEY" ]] && ok "키 생성" || bad "키 생성"

echo "── 업데이트 서버 스텁 (정적 파일)"
mkdir -p "$TMP/serve"
# 이전 실행이 남긴 서버를 정리한다 — 서브셸을 kill 해도 파이썬 자식은 살아남고,
# 그 서버는 지워진 옛 디렉터리를 서빙해 모든 요청이 404 가 된다 (고아 함정)
for p in $(lsof -nP -iTCP:"$UPD_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u); do
  kill -9 "$p" 2>/dev/null || true
done
sleep 0.5
# 서브셸 없이 직접 실행한다 — UPD_PID 가 실제 서버 프로세스여야 kill 이 듣는다
python3 -m http.server "$UPD_PORT" --bind 127.0.0.1 -d "$TMP/serve" > /dev/null 2>&1 &
UPD_PID=$!
for i in $(seq 1 20); do nc -z 127.0.0.1 "$UPD_PORT" 2>/dev/null && break; sleep 0.3; done
if kill -0 "$UPD_PID" 2>/dev/null && [[ "$(lsof -nP -iTCP:"$UPD_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | head -1)" == "$UPD_PID" ]]; then
  ok "업데이트 서버 시작 (우리 프로세스)"
else
  bad "업데이트 서버 시작"
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-updates-secret-val}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"업데이트","adminEmail":"admin@up.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@up.test","password":"adminpass123"}' >/dev/null

echo "── v1.0.0 설치 (운영자의 명시적 신뢰 — 여기서 키가 고정된다)"
make_zip "1.0.0" "$TMP/upd-test-1.0.0.zip" "$UPD/upd-test.update.json" "$PUBKEY"
UPLOAD="$(curl -s -b "$CK" -X POST "$API/api/plugins/upload" -F "file=@$TMP/upd-test-1.0.0.zip")"
contains "설치됨" "$UPLOAD" '"version":"1.0.0"'
check "레지스트리에 기록" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.0.0"

echo "── 아직 새 버전이 없다"
CHK="$(curl -s -b "$CK" "$API/api/admin/updates")"
# 매니페스트 파일이 아직 없으므로 확인 오류가 나되, 다른 확장을 막지 않는다
contains "오류를 모아서 알려준다" "$CHK" '"errors"'
check "업데이트 목록은 비어 있다" "$(echo "$CHK" | python3 -c "
import sys,json; print(len(json.load(sys.stdin)['items']))")" "0"
check "비관리자는 확인 불가" "$(code "$API/api/admin/updates")" "401"

echo "══ 정상 업데이트: v1.1.0 ══"
make_zip "1.1.0" "$TMP/serve/upd-test-1.1.0.zip" "$UPD/upd-test.update.json" "$PUBKEY"
sign_zip "$TMP/serve/upd-test-1.1.0.zip" "$TMP/publisher.private.pem" "$UPD/upd-test-1.1.0.zip" "1.1.0"
CHK="$(curl -s -b "$CK" "$API/api/admin/updates")"
contains "새 버전을 찾았다" "$CHK" '"nextVersion":"1.1.0"'
contains "현재 버전도 보여준다" "$CHK" '"currentVersion":"1.0.0"'

APPLY="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "원클릭 적용" "$APPLY" '"to":"1.1.0"'
check "레지스트리 갱신" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.1.0"
contains "파일도 새 버전" "$(cat "$ROOT/plugins/upd-test/dist/index.js")" "v1.1.0"
contains "감사 로그에 남는다" "$(psql_q "SELECT summary FROM audit_logs WHERE action='extension.update' ORDER BY created_at DESC LIMIT 1")" "1.0.0 → 1.1.0"
check "비관리자는 적용 불가" \
  "$(code -X POST "$API/api/admin/updates/plugin/upd-test/apply")" "401"

echo "══ 변조된 ZIP: 서명이 막는다 ══"
make_zip "1.2.0" "$TMP/serve/upd-test-1.2.0.zip" "$UPD/upd-test.update.json" "$PUBKEY"
sign_zip "$TMP/serve/upd-test-1.2.0.zip" "$TMP/publisher.private.pem" "$UPD/upd-test-1.2.0.zip" "1.2.0"
# 서명 후 ZIP 을 바꿔치기한다 (매니페스트의 sha256·서명은 원본 것).
#
# 주의: make_zip 을 같은 인자로 다시 부르면 **바이트까지 같은 ZIP** 이 나와서
# (파일 mtime 은 2초 단위라 연속 생성이면 동일) 원본 서명이 그대로 통과한다 —
# 그러면 이 검증이 아무것도 검증하지 않는다. 내용을 실제로 바꿔야 한다.
make_zip "1.2.0" "$TMP/evil-src.zip" "$UPD/upd-test.update.json" "$PUBKEY"
python3 -c "
import zipfile
src = zipfile.ZipFile('$TMP/evil-src.zip')
out = zipfile.ZipFile('$TMP/evil.zip', 'w')
for item in src.namelist():
    data = src.read(item)
    if item.endswith('index.js'):
        data = b'export default () => { /* MALICIOUS PAYLOAD */ };'
    out.writestr(item, data)
out.close()
"
python3 -c "
data = open('$TMP/evil.zip','rb').read()
open('$TMP/serve/upd-test-1.2.0.zip','wb').write(data + b'#tampered')"
TAMPER="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "sha256 불일치로 거부" "$TAMPER" "sha256"
check "버전이 그대로다" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.1.0"

echo "── sha256 은 맞췄지만 서명이 다른 경우 (진짜 공격 형태)"
# 공격자가 ZIP 을 바꾸고 sha256 도 제 것으로 맞춘다 — 서명만이 막는다
python3 - <<PY
import json, hashlib
zip_bytes = open("$TMP/evil.zip", "rb").read()
open("$TMP/serve/upd-test-1.2.0.zip", "wb").write(zip_bytes)
m = json.load(open("$TMP/serve/upd-test.update.json"))
m["sha256"] = hashlib.sha256(zip_bytes).hexdigest()
# 서명은 원본 것 그대로 (공격자는 배포자 개인키가 없다)
json.dump(m, open("$TMP/serve/upd-test.update.json", "w"))
PY
FORGE="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "서명 검증 실패로 거부" "$FORGE" "서명 검증에 실패"
check "버전이 그대로다" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.1.0"

echo "══ 다른 키로 서명: 키 고정이 막는다 ══"
# 공격자가 업데이트 서버를 통째로 장악해 자기 키로 서명한 ZIP 을 건다.
# 매니페스트·ZIP·서명이 전부 자기 것으로 일관돼도, 고정된 키와 다르면 거부.
sign_zip "$TMP/serve/upd-test-1.2.0.zip" "$TMP/attacker.private.pem" "$UPD/upd-test-1.2.0.zip" "1.2.0"
PIN="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "고정된 키와 달라 거부" "$PIN" "서명 검증에 실패"
contains "키가 바뀌었을 때의 안내" "$PIN" "직접 업로드"
check "버전이 그대로다" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.1.0"

echo "── ZIP 안의 새 매니페스트가 키를 바꿔치기하지 못한다"
# 정상 키로 서명하되 ZIP 안 매니페스트에 공격자 키를 넣는다.
# 설치는 되지만 고정 키는 유지되어야 한다 — 다음 업데이트부터 공격자 키가
# 기준이 되면 한 번의 침투가 영구 장악이 된다.
ATTACKER_PUB="$(cat "$TMP/attacker.public.txt" | tr -d '\n')"
make_zip "1.2.0" "$TMP/serve/upd-test-1.2.0.zip" "$UPD/upd-test.update.json" "$ATTACKER_PUB"
sign_zip "$TMP/serve/upd-test-1.2.0.zip" "$TMP/publisher.private.pem" "$UPD/upd-test-1.2.0.zip" "1.2.0"
SWAP="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "설치는 된다 (서명은 정상 키다)" "$SWAP" '"to":"1.2.0"'
PINNED="$(psql_q "SELECT manifest->>'publisherKey' FROM installed_plugins WHERE name='upd-test'")"
check "고정 키는 원래 배포자 키 그대로 (바꿔치기 무효)" "$PINNED" "$PUBKEY"

echo "══ 다운그레이드 거부 ══"
make_zip "1.0.5" "$TMP/serve/upd-test-1.0.5.zip" "$UPD/upd-test.update.json" "$PUBKEY"
sign_zip "$TMP/serve/upd-test-1.0.5.zip" "$TMP/publisher.private.pem" "$UPD/upd-test-1.0.5.zip" "1.0.5"
CHK="$(curl -s -b "$CK" "$API/api/admin/updates")"
check "낮은 버전은 목록에 안 뜬다" "$(echo "$CHK" | python3 -c "
import sys,json; print(len(json.load(sys.stdin)['items']))")" "0"
DOWN="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "강제로 적용해도 거부" "$DOWN" "새 버전이 아닙니다"
check "버전 유지" "$(psql_q "SELECT version FROM installed_plugins WHERE name='upd-test'")" "1.2.0"

echo "══ 그 밖의 방어 ══"
echo "── 다른 확장의 매니페스트"
python3 - <<PY
import json
m = json.load(open("$TMP/serve/upd-test.update.json"))
m["name"] = "other-plugin"
m["version"] = "9.9.9"
json.dump(m, open("$TMP/serve/upd-test.update.json", "w"))
PY
WRONG="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-test/apply")"
contains "이름 불일치로 거부" "$WRONG" "다릅니다"

echo "── updates 주소가 없는 확장 → 원격 업데이트 자체가 없다"
# 이름·updates·키를 바꾼 변형 ZIP 을 파이썬으로 만든다
variant_zip() {  # variant_zip <원본zip> <출력zip> <이름> [updates_url]
  python3 -c "
import json, zipfile, sys
src = zipfile.ZipFile(sys.argv[1])
out = zipfile.ZipFile(sys.argv[2], 'w')
for item in src.namelist():
    data = src.read(item)
    if item.endswith('brick.plugin.json'):
        m = json.loads(data)
        m['name'] = sys.argv[3]
        m.pop('updates', None); m.pop('publisherKey', None)
        if len(sys.argv) > 4 and sys.argv[4]:
            m['updates'] = sys.argv[4]
        data = json.dumps(m).encode()
    out.writestr(item, data)
out.close()
" "$@"
}
make_zip "1.0.0" "$TMP/base.zip" "" ""
variant_zip "$TMP/base.zip" "$TMP/no-updates.zip" "upd-noremote"
curl -s -b "$CK" -X POST "$API/api/plugins/upload" -F "file=@$TMP/no-updates.zip" >/dev/null
NOURL="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-noremote/apply")"
contains "원격 업데이트를 제공하지 않는다" "$NOURL" "제공하지 않습니다"
CHK_NOURL="$(curl -s -b "$CK" "$API/api/admin/updates")"
absent "확인 대상에도 없다 (매니페스트 주소가 없다)" "$CHK_NOURL" "upd-noremote"

echo "── updates 주소는 있는데 키가 없는 확장 → 직접 업로드 안내"
variant_zip "$TMP/base.zip" "$TMP/no-key.zip" "upd-nokey" "$UPD/whatever.json"
curl -s -b "$CK" -X POST "$API/api/plugins/upload" -F "file=@$TMP/no-key.zip" >/dev/null
NOKEY="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/upd-nokey/apply")"
contains "키가 없으면 원격 업데이트 거부 + 안내" "$NOKEY" "직접 업로드"

echo "── kind 검증"
check "이상한 kind 는 400" \
  "$(code -b "$CK" -X POST "$API/api/admin/updates/banana/upd-test/apply")" "400"

echo "── https 강제 (서비스 코드 단위 검증)"
HTTPS_TEST="$(node -e '
const path = "'"$ROOT"'/apps/api/dist/modules/extensions/extension-updater.service.js";
import(path).then((m) => {
  const cases = [
    ["http://evil.example.com/u.json", false],
    ["https://good.example.com/u.json", true],
    ["http://127.0.0.1:9999/u.json", true],
    ["http://localhost:9999/u.json", true],
    ["ftp://x/u.json", false],
    ["not a url", false],
  ];
  const bad = cases.filter(([u, allowed]) => {
    try { m.assertSafeUrl(u); return !allowed; } catch { return allowed; }
  });
  console.log(bad.length === 0 ? "모두 통과" : `실패: ${JSON.stringify(bad)}`);
})')"
check "http 는 localhost 만 허용" "$HTTPS_TEST" "모두 통과"

echo "── 버전 비교 (다운그레이드 방어의 근거)"
VER_TEST="$(node -e '
const path = "'"$ROOT"'/apps/api/dist/modules/extensions/extension-updater.service.js";
import(path).then((m) => {
  const cases = [
    ["1.1.0", "1.0.0", true], ["1.0.0", "1.1.0", false],
    ["2.0.0", "1.9.9", true], ["1.0.0", "1.0.0", false],
    ["1.10.0", "1.9.0", true], ["1.0.10", "1.0.9", true],
    ["1.2.0-beta", "1.1.0", true],
  ];
  const bad = cases.filter(([a, b, want]) => m.isNewerVersion(a, b) !== want);
  console.log(bad.length === 0 ? "모두 통과" : `실패: ${JSON.stringify(bad)}`);
})')"
check "버전 비교 7케이스" "$VER_TEST" "모두 통과"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
