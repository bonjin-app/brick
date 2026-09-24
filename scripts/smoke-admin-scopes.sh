#!/usr/bin/env bash
#
# 운영자 권한 범위 — "이 운영자는 주문만".
#
# 역할이 세 단계(관리자·운영자·회원)뿐이라, 주문만 맡길 사람에게도 상품 가격·쿠폰을 바꿀 권한까지
# 줘야 했다. 운영자마다 관리 화면 범위를 두고, 플러그인 관리 경로를 여는 디스패처 한 곳에서 막는다.
#   - 범위가 없으면(null) 지금처럼 전부 — 기존 운영자는 그대로
#   - 받은 화면이 쓰는 경로(목록·수정·일괄 처리·선택지·가져오기)만 열린다
#   - 어느 화면에도 속하지 않는 관리 API(보고서·환불)는 플러그인 전체를 받아야 한다
#   - 메뉴에도 받은 화면만 — 누르면 403 인 메뉴는 없다
#   - 바꾸면 다시 로그인하지 않아도 바로 적용된다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-admin-scopes.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
BOARD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
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
scopes() {  # scopes <json|null> → 상태코드
  code -b "$CK" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d "{\"adminScopes\":$1}"
}
nav() {  # 운영자 메뉴의 리소스 이름들 (plugin/name, 쉼표로)
  curl -s -b "$MG" "$API/api/admin/nav" | python3 -c "import sys,json; print(','.join(sorted(r['plugin']+'/'+r['name'] for r in json.load(sys.stdin).get('resources',[]))))"
}

echo "▶ 운영자 권한 범위 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-scopes-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"범위","adminEmail":"admin@sc.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sc.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-board; do curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/$pl/activate"; done
curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"mgr@sc.test","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"주문담당"}'
MGR_ID="$(psql_q "SELECT id FROM users WHERE email='mgr@sc.test'")"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d '{"role":"manager"}'
curl -s -o /dev/null -c "$TMP/mg.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"mgr@sc.test","password":"password123"}'
MG="$TMP/mg.txt"

P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"sc-mug","name":"범위 머그컵","price":10000,"stock":20,"status":"selling"}' | jq_get "['id']")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"손님","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" > "$TMP/o.json"
ORDER_NO="$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json" | jq_get "['orderNo']")"
OID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$ORDER_NO'")"

echo "── 범위가 없으면 지금처럼 전부 (기존 운영자는 그대로)"
check "상품 관리" "$(code -b "$MG" "$SHOP/admin/products")" "200"
check "게시판 관리" "$(code -b "$MG" "$BOARD/admin/boards")" "200"
check "매출 보고서 (화면 없는 관리 API)" "$(code -b "$MG" "$SHOP/admin/reports/summary")" "200"
contains "메뉴에 상품이 있다" "$(nav)" "brick-shop/products"

echo "── 줄 수 있는 관리 화면"
AREAS="$(curl -s -b "$CK" "$API/api/admin/areas")"
contains "쇼핑몰 주문 화면" "$AREAS" '"key":"brick-shop/orders"'
contains "사람이 읽는 이름" "$AREAS" '"title":"주문"'
contains "게시판도" "$AREAS" '"key":"brick-board"'
check "관리자만 본다" "$(code -b "$MG" "$API/api/admin/areas")" "403"

echo "── 주문만 맡긴다"
check "범위 저장" "$(scopes '["brick-shop/orders"]')" "200"
# 다시 로그인하지 않는다 — 같은 세션에서 바로 적용된다
check "주문 목록 (다시 로그인하지 않아도)" "$(code -b "$MG" "$SHOP/admin/orders")" "200"
contains "주문 목록에 그 주문이 보인다" "$(curl -s -b "$MG" "$SHOP/admin/orders")" "$ORDER_NO"
check "주문 상태 변경" "$(code -b "$MG" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' -d '{"status":"paid"}')" "200"
R="$(code -b "$MG" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d "{\"action\":\"mark-paid\",\"ids\":[\"$OID\"]}")"
[[ "$R" != "403" && "$R" != "000" ]] && ok "주문 일괄 처리 (화면이 부르는 경로 — $R)" || bad "주문 일괄 처리가 막혔다 ($R)"
check "상품 목록은 닫힌다" "$(code -b "$MG" "$SHOP/admin/products")" "403"
check "상품 가격 변경도" "$(code -b "$MG" -X PUT "$SHOP/admin/products/$P" -H 'content-type: application/json' -d '{"slug":"sc-mug","name":"범위 머그컵","price":1,"stock":20,"status":"selling"}')" "403"
check "가격은 그대로" "$(psql_q "SELECT price FROM shop_products WHERE id='$P'")" "10000"
check "쿠폰 만들기" "$(code -b "$MG" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' -d '{"code":"FREE","type":"fixed","value":10000}')" "403"
check "화면 없는 관리 API(보고서)는 플러그인 전체가 있어야 한다" "$(code -b "$MG" "$SHOP/admin/reports/summary")" "403"
REFUND_BODY="$(printf '{"orderNo":"%s","amount":1000}' "$ORDER_NO")"
check "환불 API 도" "$(code -b "$MG" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$REFUND_BODY")" "403"
check "다른 플러그인(게시판)도" "$(code -b "$MG" "$BOARD/admin/boards")" "403"
check "상품 화면 선언도 열리지 않는다" "$(code -b "$MG" "$API/api/admin/resources/brick-shop/products")" "403"
check "주문 화면 선언은 열린다" "$(code -b "$MG" "$API/api/admin/resources/brick-shop/orders")" "200"
check "메뉴에는 주문만" "$(nav)" "brick-shop/orders"
contains "거절 이유" "$(curl -s -b "$MG" "$SHOP/admin/products")" "이 관리 화면을 다룰 권한이 없습니다"
check "손님 화면은 그대로 (범위는 관리 경로만)" "$(code -b "$MG" "$SHOP/products")" "200"

echo "── 상품 화면을 주면 그 화면이 부르는 선택지·가져오기도 열린다"
check "범위 바꾸기" "$(scopes '["brick-shop/products"]')" "200"
check "상품 목록" "$(code -b "$MG" "$SHOP/admin/products")" "200"
check "분류 선택지 (상품 폼의 optionsFrom)" "$(code -b "$MG" "$SHOP/admin/options/categories")" "200"
check "붙여넣기 등록 (가져오기 — 빈 표는 거절될 뿐 403 이 아니다)" "$(code -b "$MG" -X POST "$SHOP/admin/products/import" -H 'content-type: application/json' -d '{"text":""}' | sed 's/^200$/ok/;s/^400$/ok/')" "ok"
check "주문은 이제 닫힌다" "$(code -b "$MG" "$SHOP/admin/orders")" "403"
check "회원 등급 선택지(쿠폰 폼의 것)는 상품 화면이 쓰지 않는다" "$(code -b "$MG" "$SHOP/admin/options/grades")" "403"

echo "── 플러그인 전체"
check "게시판 전체" "$(scopes '["brick-board"]')" "200"
check "게시판 관리" "$(code -b "$MG" "$BOARD/admin/boards")" "200"
check "쇼핑몰은 닫힌다" "$(code -b "$MG" "$SHOP/admin/products")" "403"
check "쇼핑몰 전체를 주면 화면 없는 보고서도" "$(scopes '["brick-shop"]'; code -b "$MG" "$SHOP/admin/reports/summary")" "200200"

echo "── 아무 화면도 없음 / 다시 전부"
check "빈 범위" "$(scopes '[]')" "200"
check "메뉴가 빈다" "$(nav)" ""
check "주문도 닫힌다" "$(code -b "$MG" "$SHOP/admin/orders")" "403"
check "전부로 되돌리기" "$(scopes 'null')" "200"
check "다시 상품 관리" "$(code -b "$MG" "$SHOP/admin/products")" "200"

echo "── 누가 바꿀 수 있나"
check "형식이 틀리면 거절" "$(scopes '["../etc"]')" "400"
check "문자열이 아니면 거절" "$(scopes '"brick-shop"')" "400"
check "운영자는 자기 범위를 넓힐 수 없다" "$(code -b "$MG" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d '{"adminScopes":null}')" "403"
contains "바꾼 기록이 감사 로그에" "$(psql_q "SELECT summary FROM audit_logs WHERE action='user.scope_change' ORDER BY created_at DESC LIMIT 5")" "관리 화면 없음 → 전체"

echo "── 관리자에게는 범위가 뜻이 없다"
scopes '[]' >/dev/null
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d '{"role":"admin"}'
check "범위가 남아 있어도 관리자는 전부" "$(code -b "$MG" "$SHOP/admin/products")" "200"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d '{"role":"member"}'
check "회원으로 내리면 관리 경로는 닫힌다" "$(code -b "$MG" "$SHOP/admin/products")" "403"

echo "── 영어 사이트"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.locale":"en"}'
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/users/$MGR_ID" -H 'content-type: application/json' -d '{"role":"manager","adminScopes":["brick-shop/orders"]}'
sleep 2
contains "거절 이유가 번역된다" "$(curl -s -b "$MG" "$SHOP/admin/products")" "You do not have permission for this admin screen"
contains "화면 이름도" "$(curl -s -b "$CK" "$API/api/admin/areas")" '"title":"Orders"'

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
