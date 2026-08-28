#!/usr/bin/env bash
#
# 기획전 E2E 스모크.
#
# 못박는 것:
#   - 없는 상품 slug 는 저장할 때 오류로 알려주는가 (조용히 버리면 오타를 못 찾는다)
#   - 기간이 지나면 목록에서 빠지되 **직접 열면 "종료" 안내**인가 (404 는
#     공유 링크로 온 손님에게 사이트가 고장난 것으로 보인다)
#   - 숨김은 404 인가 (운영자가 감춘 것)
#   - draft·hidden 상품이 기획전에서 노출되지 않는가
#   - 진열 순서가 유지되는가
#   - 메뉴의 연결 대상 선택에 기획전이 나오는가
#   - 수정 저장이 상품 목록을 지우지 않는가 (products_text 왕복)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-collections.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
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

echo "▶ 기획전 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-collections-secre}"
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
    -d '{"siteName":"기획전","adminEmail":"admin@col.test","adminPassword":"adminpass123","starter":"shop"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@col.test","password":"adminpass123"}' >/dev/null

mkp() {  # mkp <slug> <이름> <status>
  printf '{"slug":"%s","name":"%s","price":10000,"stock":9,"status":"%s"}' "$1" "$2" "$3" > "$TMP/p.json"
  curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/p.json" >/dev/null
}
mkp "sun" "선풍기" "selling"
mkp "umb" "우산" "selling"
mkp "hid" "숨긴 상품" "hidden"
ok "상품 3개 (판매 2 · 숨김 1)"

echo "── 검증"
check "제목 없으면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
      -d '{"slug":"x","products_text":"sun"}')" "400"
check "잘못된 slug 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
      -d '{"slug":"한글","title":"x","products_text":"sun"}')" "400"
contains "없는 상품 slug 는 알려준다 (조용히 버리면 오타를 못 찾는다)" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
      -d '{"slug":"summer","title":"여름","products_text":"sun\nno-such"}')" "no-such"
check "종료가 시작보다 빠르면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
      -d '{"slug":"bad","title":"x","products_text":"sun","starts_at":"2026-09-01","ends_at":"2026-08-01"}')" "400"
check "비관리자는 생성 불가" \
  "$(code -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
      -d '{"slug":"x","title":"x","products_text":"sun"}')" "403"

echo "── 생성 · 진열 순서"
COL="$(curl -s -b "$CK" -X POST "$SHOP/admin/collections" -H 'content-type: application/json' \
  -d '{"slug":"summer","title":"여름 특가","description":"더위를 이기는 준비물","products_text":"umb\nsun\nhid"}')"
CID="$(echo "$COL" | jq_get "['id']")"
[[ -n "$CID" ]] && ok "기획전 생성" || bad "기획전 생성 ($COL)"

VIEW="$(curl -s "$SHOP/collections/summer")"
contains "제목" "$VIEW" "여름 특가"
contains "진행 중" "$VIEW" '"state":"active"'
ORDER="$(echo "$VIEW" | python3 -c "
import sys,json; print(','.join(p['slug'] for p in json.load(sys.stdin)['products']))")"
check "진열 순서 유지 + 숨김 상품 제외" "$ORDER" "umb,sun"
contains "공개 목록에 노출" "$(curl -s "$SHOP/collections")" '"slug":"summer"'

echo "── 수정 저장이 상품 목록을 지우지 않는다"
ADMIN_LIST="$(curl -s -b "$CK" "$SHOP/admin/collections")"
RETURNED_TEXT="$(echo "$ADMIN_LIST" | python3 -c "
import sys,json
row = next(i for i in json.load(sys.stdin)['items'] if i['slug']=='summer')
print(row['products_text'].replace(chr(10), ','))")"
check "폼에 기존 상품이 채워진다" "$RETURNED_TEXT" "umb,sun,hid"

echo "── 화면 렌더 (storefront 라우팅)"
EV="$(curl -s "$API/api/render/page?path=shop/event")"
contains "기획전 목록 페이지" "$EV" "여름 특가"
DETAIL="$(curl -s "$API/api/render/page?path=shop/event/summer")"
contains "기획전 상세" "$DETAIL" "더위를 이기는 준비물"
contains "상품 카드" "$DETAIL" "선풍기"
absent "숨긴 상품은 화면에도 없다" "$DETAIL" "숨긴 상품"

echo "── 메뉴 연결 대상에 나온다"
LT="$(curl -s -b "$CK" "$API/api/admin/link-targets")"
contains "기획전 고정 화면" "$LT" '"path":"/shop/event"'
contains "진행 중 기획전" "$LT" "여름 특가"

# 상태 변경은 psql 이 아니라 관리 API 로 한다 — 운영자가 실제로 하는 방식이고,
# 화면 캐시 무효화(invalidateTag)까지 함께 검증된다. DB 를 직접 고치면
# 캐시가 남아 이 스모크는 "고쳐도 통과"하는 거짓말을 하게 된다.
set_period() {  # set_period <starts_at|""> <ends_at|""> <is_visible>
  printf '{"slug":"summer","title":"여름 특가","description":"더위를 이기는 준비물","products_text":"umb\\nsun\\nhid","starts_at":"%s","ends_at":"%s","is_visible":%s}' \
    "$1" "$2" "$3" > "$TMP/upd.json"
  curl -s -b "$CK" -X PUT "$SHOP/admin/collections/$CID" \
    -H 'content-type: application/json' --data-binary "@$TMP/upd.json"
}
iso() { python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=$1)).isoformat())"; }

echo "── 기간: 끝나면 목록에서 빠지되 직접 열면 종료 안내"
contains "종료일을 어제로 수정" "$(set_period "" "$(iso -1)" true)" '"ok":true'
absent "목록에서 빠진다" "$(curl -s "$SHOP/collections")" '"slug":"summer"'
ENDED="$(curl -s "$SHOP/collections/summer")"
contains "직접 열면 찾아진다 (404 가 아니다)" "$ENDED" '"state":"ended"'
contains "화면에 종료 안내" "$(curl -s "$API/api/render/page?path=shop/event/summer")" "종료된 기획전"
EV2="$(curl -s "$API/api/render/page?path=shop/event")"
contains "목록 화면에서도 빠진다" "$EV2" "진행 중인 기획전이 없습니다"

echo "── 예정: 아직 시작 안 함"
set_period "$(iso 1)" "$(iso 30)" true >/dev/null
contains "예정 상태" "$(curl -s "$SHOP/collections/summer")" '"state":"upcoming"'
contains "화면에 예정 안내" "$(curl -s "$API/api/render/page?path=shop/event/summer")" "아직 시작하지 않은"

echo "── 숨김은 404 (운영자가 감춘 것)"
set_period "" "" false >/dev/null
check "API 404" "$(code "$SHOP/collections/summer")" "404"
contains "화면도 찾을 수 없음" "$(curl -s "$API/api/render/page?path=shop/event/summer")" "찾을 수 없습니다"
set_period "" "" true >/dev/null

echo "── 상품 삭제 시 기획전에서 조용히 빠진다 (CASCADE)"
SUN_ID="$(psql_q "SELECT id FROM shop_products WHERE slug='sun'")"
curl -s -b "$CK" -X DELETE "$SHOP/admin/products/$SUN_ID" >/dev/null
V2="$(curl -s "$SHOP/collections/summer")"
ORDER2="$(echo "$V2" | python3 -c "
import sys,json; print(','.join(p['slug'] for p in json.load(sys.stdin)['products']))")"
check "남은 상품만" "$ORDER2" "umb"

echo "── 삭제"
contains "기획전 삭제" "$(curl -s -b "$CK" -X DELETE "$SHOP/admin/collections/$CID")" '"ok":true'
check "항목도 함께 삭제" "$(psql_q "SELECT count(*) FROM shop_collection_items")" "0"
check "관리 화면 등록" "$(curl -s -b "$CK" "$API/api/admin/nav" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(any(r['name']=='collections' for r in d['resources']))")" "True"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
