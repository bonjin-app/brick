#!/usr/bin/env bash
#
# 플러그인 레지스트리 E2E 스모크 — 레지스트리는 목록일 뿐, 신뢰는 서명이 결정한다.
#
# 못박는 것:
#   - 레지스트리에서 설치할 때 **서명 검증을 통과해야만** 설치되는가
#     (레지스트리가 가리키는 ZIP 이 변조되면 거부되는가)
#   - sha256 불일치가 거부되는가
#   - 설치 때 키·업데이트 주소가 **고정**되어, 이후 레지스트리가 키를
#     바꿔치기해도 업데이트가 고정 키로 검증되는가 (TOFU)
#   - ZIP 매니페스트에 updates 가 없어도 레지스트리 설치본이 원클릭
#     업데이트를 받는가 (주소를 설치 기록에 고정했으므로)
#   - 이미 설치된 확장을 레지스트리 설치로 덮을 수 없는가
#   - 형식이 깨진 항목이 전체 목록을 죽이지 않는가
#   - 비관리자가 접근할 수 없는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-registry.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
REG_PORT=42731
REG="http://127.0.0.1:${REG_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${SRV_PID:-}" ]]; then kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$TMP" "$ROOT/plugins/reg-test"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:220})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }

make_zip() {  # make_zip <버전> <출력파일> [본문표식]
  local ver="$1" out="$2" marker="${3:-normal}"
  local dir="$TMP/build-$ver-$marker"
  rm -rf "$dir"; mkdir -p "$dir/dist"
  python3 - "$dir" "$ver" "$marker" <<'PY'
import json, sys
d, ver, marker = sys.argv[1], sys.argv[2], sys.argv[3]
# 일부러 updates 를 넣지 않는다 — 레지스트리 설치가 주소를 고정해 주는지 검증한다
manifest = {
  "name": "reg-test",
  "version": ver,
  "displayName": "레지스트리 테스트",
  "brickVersion": ">=0.0.1",
  "entry": "dist/index.js",
}
open(f"{d}/brick.plugin.json", "w").write(json.dumps(manifest))
open(f"{d}/dist/index.js", "w").write(
  f'export default (ctx) => {{ ctx.registerRoute("GET", "/ping", async () => ({{ pong: "{ver}" }})); return {{}}; }}; // {marker}\n')
PY
  (cd "$dir" && zip -qr "$out" .)
}

sign_manifest() {  # sign_manifest <zip> <개인키파일> <zip URL> <버전> <출력>
  node "$ROOT/scripts/sign-extension.mjs" sign \
    --zip "$1" --key "$2" --url "$3" --name reg-test --version "$4" --out "$5" >/dev/null
}

write_registry() {  # write_registry <publisherKey> — 정상 1 + 깨진 항목 1
  python3 - "$1" > "$TMP/serve/registry.json" <<'PY'
import json, sys
print(json.dumps({
  "name": "테스트 레지스트리",
  "items": [
    {
      "kind": "plugin", "name": "reg-test", "displayName": "레지스트리 테스트",
      "description": "스모크용", "version": "1.0.0",
      "updates": "http://127.0.0.1:42731/reg-test.update.json",
      "publisherKey": sys.argv[1],
    },
    { "kind": "plugin", "name": "BROKEN 항목" },
  ],
}, ensure_ascii=False))
PY
}

echo "▶ 플러그인 레지스트리 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi
rm -rf "$ROOT/plugins/reg-test"

echo "── 배포자 · 공격자 키"
node "$ROOT/scripts/sign-extension.mjs" keygen --out "$TMP/publisher" >/dev/null
node "$ROOT/scripts/sign-extension.mjs" keygen --out "$TMP/attacker" >/dev/null
PUBKEY="$(tr -d '\n' < "$TMP/publisher.public.txt")"
ATTKEY="$(tr -d '\n' < "$TMP/attacker.public.txt")"
[[ -n "$PUBKEY" && -n "$ATTKEY" ]] && ok "키 두 벌" || bad "키 생성"

echo "── 레지스트리 서버 스텁"
mkdir -p "$TMP/serve"
for p in $(lsof -nP -iTCP:"$REG_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u); do
  kill -9 "$p" 2>/dev/null || true
done
sleep 0.5
python3 -m http.server "$REG_PORT" --bind 127.0.0.1 -d "$TMP/serve" > /dev/null 2>&1 &
SRV_PID=$!
for i in $(seq 1 20); do nc -z 127.0.0.1 "$REG_PORT" 2>/dev/null && break; sleep 0.3; done
if kill -0 "$SRV_PID" 2>/dev/null && [[ "$(lsof -nP -iTCP:"$REG_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | head -1)" == "$SRV_PID" ]]; then
  ok "서버 시작 (우리 프로세스)"
else
  bad "서버 시작"
fi

make_zip "1.0.0" "$TMP/serve/reg-test-1.0.0.zip"
sign_manifest "$TMP/serve/reg-test-1.0.0.zip" "$TMP/publisher.private.pem" \
  "$REG/reg-test-1.0.0.zip" "1.0.0" "$TMP/serve/reg-test.update.json"
write_registry "$PUBKEY"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-registry-secret}"
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
    -d '{"siteName":"레지스트리","adminEmail":"admin@reg.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@reg.test","password":"adminpass123"}' >/dev/null

echo "── 접근 제어와 주소 설정"
check "비로그인 목록 불가" "$(code "$API/api/admin/registry")" "401"
check "비로그인 설치 불가" "$(code -X POST "$API/api/admin/registry/plugin/reg-test/install")" "401"
contains "레지스트리 주소 설정 (관리자 설정)" \
  "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
      -d "{\"extensions.registry_url\":\"$REG/registry.json\"}")" '"ok":true'

echo "── 목록"
LIST="$(curl -s -b "$CK" "$API/api/admin/registry")"
contains "레지스트리 이름" "$LIST" "테스트 레지스트리"
contains "항목이 보인다" "$LIST" '"name":"reg-test"'
contains "설치 전 상태" "$LIST" '"state":"not_installed"'
contains "깨진 항목은 건너뛰고 알린다 (전체를 죽이지 않는다)" "$LIST" '"skipped":["BROKEN 항목"]'

echo "── 변조된 ZIP 은 설치되지 않는다"
# 매니페스트는 정상 zip 을 가리키지만 서버의 zip 을 다른 내용으로 바꿔치기한다
make_zip "1.0.0" "$TMP/serve/reg-test-1.0.0.zip" "EVIL-tampered"
TAMPER="$(curl -s -b "$CK" -X POST "$API/api/admin/registry/plugin/reg-test/install" \
  -H 'content-type: application/json' -d '{}')"
contains "sha256 불일치 거부" "$TAMPER" "sha256"
check "설치되지 않았다" "$([[ -d "$ROOT/plugins/reg-test" ]] && echo yes || echo no)" "no"

echo "── 서명이 다르면 설치되지 않는다 (공격자가 서명까지 다시 만든 경우)"
make_zip "1.0.0" "$TMP/serve/reg-test-1.0.0.zip" "EVIL-resigned"
sign_manifest "$TMP/serve/reg-test-1.0.0.zip" "$TMP/attacker.private.pem" \
  "$REG/reg-test-1.0.0.zip" "1.0.0" "$TMP/serve/reg-test.update.json"
BADSIG="$(curl -s -b "$CK" -X POST "$API/api/admin/registry/plugin/reg-test/install" \
  -H 'content-type: application/json' -d '{}')"
contains "서명 검증 실패로 거부" "$BADSIG" "서명 검증"
check "설치되지 않았다" "$([[ -d "$ROOT/plugins/reg-test" ]] && echo yes || echo no)" "no"

echo "── 정상 설치 (+ 즉시 활성화)"
make_zip "1.0.0" "$TMP/serve/reg-test-1.0.0.zip"
sign_manifest "$TMP/serve/reg-test-1.0.0.zip" "$TMP/publisher.private.pem" \
  "$REG/reg-test-1.0.0.zip" "1.0.0" "$TMP/serve/reg-test.update.json"
INSTALL="$(curl -s -b "$CK" -X POST "$API/api/admin/registry/plugin/reg-test/install" \
  -H 'content-type: application/json' -d '{"activate":true}')"
contains "설치 성공" "$INSTALL" '"version":"1.0.0"'
contains "요청대로 활성화됨" "$INSTALL" '"activated":true'
contains "플러그인 라우트가 산다" "$(curl -s "$API/api/plugins/reg-test/ping")" '"pong":"1.0.0"'
contains "목록 상태가 설치됨으로" "$(curl -s -b "$CK" "$API/api/admin/registry")" '"state":"installed"'
contains "재설치 시도는 안내와 함께 거부" \
  "$(curl -s -b "$CK" -X POST "$API/api/admin/registry/plugin/reg-test/install" -H 'content-type: application/json' -d '{}')" \
  "이미 설치"

echo "── 업데이트: ZIP 매니페스트에 updates 가 없어도 주소가 고정되어 동작한다"
make_zip "1.1.0" "$TMP/serve/reg-test-1.1.0.zip"
sign_manifest "$TMP/serve/reg-test-1.1.0.zip" "$TMP/publisher.private.pem" \
  "$REG/reg-test-1.1.0.zip" "1.1.0" "$TMP/serve/reg-test.update.json"
UP_CHECK="$(curl -s -b "$CK" "$API/api/admin/updates")"
contains "업데이트가 보인다" "$UP_CHECK" '"nextVersion":"1.1.0"'
contains "적용" "$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/reg-test/apply")" '"to":"1.1.0"'
contains "새 코드가 돈다" "$(curl -s "$API/api/plugins/reg-test/ping")" '"pong":"1.1.0"'

echo "── 레지스트리가 키를 바꿔치기해도 업데이트는 고정 키로 검증한다 (TOFU)"
write_registry "$ATTKEY"   # 레지스트리 항목의 키를 공격자 키로 교체
make_zip "1.2.0" "$TMP/serve/reg-test-1.2.0.zip" "EVIL-takeover"
sign_manifest "$TMP/serve/reg-test-1.2.0.zip" "$TMP/attacker.private.pem" \
  "$REG/reg-test-1.2.0.zip" "1.2.0" "$TMP/serve/reg-test.update.json"
TAKEOVER="$(curl -s -b "$CK" -X POST "$API/api/admin/updates/plugin/reg-test/apply")"
contains "고정 키와 다른 서명은 거부" "$TAKEOVER" "서명 검증"
contains "기존 버전이 그대로 돈다" "$(curl -s "$API/api/plugins/reg-test/ping")" '"pong":"1.1.0"'

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -30 "$TMP/api.log"; exit 1; }
