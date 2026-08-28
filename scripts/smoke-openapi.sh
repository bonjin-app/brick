#!/usr/bin/env bash
#
# OpenAPI 문서 E2E 스모크.
#
# 못박는 것:
#   - 스펙이 손으로 쓴 파일이 아니라 **실제 라우트**에서 생성되는가 —
#     플러그인을 켜면 그 라우트가 나타나고, 끄면 사라지는가
#   - 경로 파라미터가 OpenAPI 규격({param})으로 선언되는가
#   - 관리자 경로에 인증 요구가 표시되는가
#   - registerRoute 의 docs.summary 가 실리는가
#   - /api/docs 사람용 페이지가 자체 완결인가 (외부 CDN 없음 — CSP·오프라인)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-openapi.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:220})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
spec() { curl -s "$API/api/openapi.json"; }
q() {  # q <스펙 JSON> <python 식>
  echo "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print($2)"
}

echo "▶ OpenAPI 문서 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-openapi-secret1}"
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
    -d '{"siteName":"문서","adminEmail":"admin@oa.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@oa.test","password":"adminpass123"}' >/dev/null

echo "── 기본 형태"
S="$(spec)"
contains "OpenAPI 3.1" "$S" '"openapi":"3.1.0"'
check "유효한 JSON · paths 존재" "$(q "$S" "type(d['paths']).__name__")" "dict"
N_CORE="$(q "$S" "len(d['paths'])")"
[[ "$N_CORE" -gt 50 ]] && ok "코어 라우트가 실려 있다 (${N_CORE}개 경로)" || bad "코어 라우트가 너무 적다 ($N_CORE)"

echo "── 코어 라우트 계약"
contains "로그인" "$S" '"/api/auth/login"'
contains "페이지" "$S" '"/api/pages"'
check "경로 파라미터가 {param} 규격" "$(q "$S" "'get' in d['paths'].get('/api/pages/{id}', {})")" "True"
check "파라미터 선언" "$(q "$S" "d['paths']['/api/pages/{id}']['get']['parameters'][0]['name']")" "id"
absent "Nest 의 :param 표기가 남지 않는다" "$S" '"/api/pages/:id"'
absent "와일드카드 경로는 API 가 아니다" "$S" '*'

echo "── 인증 표시"
check "관리자 경로에 cookieAuth" \
  "$(q "$S" "'cookieAuth' in json.dumps(d['paths']['/api/admin/nav']['get'].get('security', []))")" "True"
check "공개 경로에는 없다" \
  "$(q "$S" "d['paths']['/api/auth/login']['post'].get('security') is None")" "True"
contains "세션 쿠키 스킴 선언" "$S" '"brick_session"'

echo "── 플러그인 라우트: 켜면 나타나고 끄면 사라진다"
absent "활성화 전에는 없다" "$S" '/api/plugins/brick-shop/products'
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate" >/dev/null
S2="$(spec)"
contains "활성화하면 나타난다" "$S2" '"/api/plugins/brick-shop/products"'
check "플러그인 태그" "$(q "$S2" "'plugin:brick-shop' in [t['name'] for t in d['tags']]")" "True"
check "플러그인 경로 파라미터도 {} 규격" \
  "$(q "$S2" "'get' in d['paths'].get('/api/plugins/brick-shop/products/{slug}', {})")" "True"
contains "registerRoute 의 summary 가 실린다" \
  "$(q "$S2" "d['paths']['/api/plugins/brick-shop/collections']['get']['summary']")" "진행 중 기획전 목록"
check "플러그인 관리자 경로도 잠금 표시" \
  "$(q "$S2" "'cookieAuth' in json.dumps(d['paths']['/api/plugins/brick-shop/admin/products']['get'].get('security', []))")" "True"
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/deactivate" >/dev/null
absent "비활성화하면 사라진다 (문서가 현재를 말한다)" "$(spec)" '/api/plugins/brick-shop/products'
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate" >/dev/null

echo "── 사람용 문서 (/api/docs)"
DOCS="$(curl -s "$API/api/docs")"
contains "HTML 페이지" "$DOCS" "<title>Brick API 문서</title>"
contains "스펙 링크" "$DOCS" "/api/openapi.json"
absent "외부 CDN 없음 (자체 완결 — CSP·오프라인)" "$DOCS" "https://cdn"
absent "외부 스크립트 없음" "$DOCS" 'src="http'
check "누구나 볼 수 있다 (문서는 공개다)" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/docs")" "200"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -30 "$TMP/api.log"; exit 1; }
