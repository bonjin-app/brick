#!/usr/bin/env bash
#
# brick-shop 커머스 E2E 스모크 테스트.
#
# 커머스는 틀리면 돈이 새는 영역이므로 다음을 반드시 검증한다:
#   - 가격 조작 방어 (클라이언트 금액을 신뢰하지 않는가)
#   - 재고 동시성 (초과판매가 없는가)
#   - 취소/환불 시 재고 복원
#   - 주문 상태 전이 규칙
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-shop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/cookies.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
# DB 를 직접 보거나 고칠 때 쓴다 (읽는 쪽을 보는 시험에서 설정을 짧게 하기 위해)
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
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

echo "▶ brick-shop 커머스 스모크 테스트"

# 매번 빈 DB에서 시작한다 — 스모크 테스트는 "설치 전" 상태를 전제로 한다.
# (로컬 반복 실행 시 이전 데이터가 남아 실패하는 것을 막는다)
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi


export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-shop-secret-value}"
# 후기 작성자를 회원으로 등록해야 하므로 캡차는 끈다 (캡차 자체는 보안 스모크가 검증)
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비: 설치 · 로그인 · 플러그인 활성화 ──────────────
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Shop","adminEmail":"admin@shop.test","adminPassword":"shoppass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@shop.test","password":"shoppass123"}' >/dev/null
contains "쇼핑몰 플러그인 활성화" \
  "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

echo "── 관리자 리소스 자동 등록"
NAV="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "주문 리소스" "$NAV" '"name":"orders"'
contains "상품 리소스" "$NAV" '"name":"products"'
contains "쿠폰 리소스" "$NAV" '"name":"coupons"'
contains "리소스 스키마 조회" \
  "$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products")" '"basePath":"/admin/products"'

echo "── 상품"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"smoke-item","name":"스모크 상품","price":20000,"list_price":25000,"stock":3,"status":"selling"}' \
  | jq_get "['id']")"
[[ -n "$PID" ]] && ok "상품 등록" || bad "상품 등록"
check "slug 중복 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"smoke-item","name":"중복","price":100,"status":"selling"}')" "409"
check "음수 가격 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"neg","name":"음수","price":-1,"status":"selling"}')" "400"
check "비관리자 상품 등록 차단" \
  "$(code -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"x","name":"x","price":100}')" "403"
contains "공개 상품 목록" "$(curl -s "$SHOP/products")" "스모크 상품"
contains "상품 상세(조회수 증가)" "$(curl -s "$SHOP/products/smoke-item")" '"view_count"'

echo "── 금액 계산 (서버 재계산)"
printf '{"items":[{"productId":"%s","quantity":2}]}' "$PID" > "$TMP/q2.json"
Q="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q2.json")"
contains "상품금액 40000" "$Q" '"subtotal":40000'
contains "배송비 3000" "$Q" '"shippingFee":3000'
# 무료배송 기준(50000) 초과
printf '{"items":[{"productId":"%s","quantity":3}]}' "$PID" > "$TMP/q3.json"
Q3="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q3.json")"
contains "기준 초과 시 무료배송" "$Q3" '"shippingFee":0'

echo "── 쿠폰"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"smoke10","name":"10%","discount_type":"percent","discount_value":10,"max_discount":3000}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":2}],"couponCode":"smoke10"}' "$PID" > "$TMP/qc.json"
contains "정률 할인 상한 적용(4000→3000)" \
  "$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/qc.json")" '"discount":3000'
printf '{"items":[{"productId":"%s","quantity":1}],"couponCode":"NOPE"}' "$PID" > "$TMP/qn.json"
check "없는 쿠폰 차단" \
  "$(code -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/qn.json")" "400"
check "100% 초과 정률 쿠폰 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
      -d '{"code":"bad999","name":"x","discount_type":"percent","discount_value":999}')" "400"

echo "── 장바구니 (비회원)"
printf '{"productId":"%s","quantity":1}' "$PID" > "$TMP/c1.json"
CART="$(curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/c1.json")"
GT="$(echo "$CART" | jq_get "['guestToken']")"
[[ -n "$GT" ]] && ok "비회원 토큰 발급" || bad "비회원 토큰 발급"
printf '{"productId":"%s","quantity":1,"guestToken":"%s"}' "$PID" "$GT" > "$TMP/c2.json"
curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/c2.json" >/dev/null
contains "같은 상품 수량 합산" "$(curl -s "$SHOP/cart?guest=$GT")" '"quantity":2'

echo "── 재고 동시성 (핵심)"
# 재고 3개에 동시 주문 6건 → 정확히 3건만 성공해야 한다
ORDER_BODY_FILE="$TMP/order-body.json"
PIDS=()
for i in $(seq 1 6); do
  printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"손님%s","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울시"}}' "$PID" "$i" > "$ORDER_BODY_FILE.$i"
  curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' \
    --data-binary "@$ORDER_BODY_FILE.$i" -o "$TMP/o$i.json" &
  PIDS+=($!)
done
# API 서버도 백그라운드 작업이므로 bare `wait` 는 영원히 멈춘다 — curl PID만 기다린다
for pid in "${PIDS[@]}"; do wait "$pid" || true; done
# grep 은 매칭이 없으면 1을 반환한다 — pipefail 아래에서 스크립트가 죽어
# "0건 성공"이라는 회귀를 보고하지 못하고 조용히 중단된다
SUCCESS="$( { grep -l orderNo "$TMP"/o*.json 2>/dev/null | wc -l | tr -d ' '; } || true )"
check "동시 주문 6건 중 3건만 성공 (초과판매 없음)" "$SUCCESS" "3"
# 문구는 **경쟁 결과에 따라 갈린다**: 재고가 남은 것을 보고 밀린 주문은 "재고가 N개만
# 남았습니다", 이미 0이 된 뒤에 도착한 주문은 "품절되었습니다". 둘 다 맞는 말이므로 어느
# 쪽이든 통과시킨다 — 하나만 못박으면 타이밍에 따라 CI 가 붉어진다(실제로 그랬다).
FAILMSG="$(cat "$TMP"/o*.json)"
{ [[ "$FAILMSG" == *"재고가"* || "$FAILMSG" == *"품절"* ]]; } \
  && ok "실패는 명확한 재고 메시지" || bad "실패는 명확한 재고 메시지 (${FAILMSG:0:160})"
contains "주문번호 중복 없음(시퀀스)" "$(curl -s -b "$CK" "$SHOP/admin/orders")" '"total":3'

echo "── 관리자 대시보드 — 오늘의 사이트 (registerDashboardCard)"
DASH="$(curl -s -b "$CK" "$API/api/admin/dashboard")"
contains "오늘 주문 카드" "$DASH" '"title":"오늘 주문"'
contains "오늘 주문 3건" "$DASH" '"value":3'
# 오늘 숫자는 어제와 나란히 놓을 때만 뜻이 생긴다. 입금대기는 "처리 대기" 카드가 말한다 —
# 두 카드가 같은 숫자를 말하면 하나는 자리만 차지한다
contains "어제와 견주는 부가문구 (ctx.t)" "$DASH" "어제 0건"
absent "입금대기를 두 카드가 말하지 않는다" "$DASH" "입금대기"
contains "코어 회원 통계" "$DASH" '"members":'
contains "카드는 관리 화면으로 연결" "$DASH" '"link":"/admin/x/brick-shop/orders"'
check "비로그인은 대시보드 불가" "$(code "$API/api/admin/dashboard")" "401"

# 정보가 아니라 **할 일**이 보여야 한다 — 운영자는 밀린 일을 처리하러 관리자를 연다
contains "처리 대기 카드" "$DASH" '"title":"처리 대기"'
contains "입금 확인이 할 일에 잡힌다" "$DASH" "입금 확인 3"
# 이 시점에는 결제된 주문이 없다 — 없는 항목은 문구에 넣지 않는다(0을 늘어놓으면 소음이다)
absent "0 인 항목은 문구에 없다" "$DASH" "발송 0"

echo "── 주문 일괄 처리 (열두 건이면 열두 번 폼을 열어야 했다)"
# 이 절은 주문 상태를 바꾼다 — **자기 상품과 자기 주문**을 만들어 쓴다. 앞 절이 만든
# 주문을 빌려 쓰면 뒷 절("잘못된 전이 차단" 등)이 이미 배송중인 주문을 보게 되어 깨진다
# (실제로 그랬다). 스모크는 순서 의존적이므로 상태를 바꾸는 검사는 자기 것만 만진다.
printf '{"slug":"bulk-item","name":"일괄 상품","price":5000,"stock":50,"status":"selling"}' > "$TMP/bp.json"
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/bp.json" -o /dev/null
BULK_PID="$(psql_q "SELECT id FROM shop_products WHERE slug = 'bulk-item'")"
BULK_IDS="$(/usr/bin/python3 -c "
import json, subprocess, sys
ids = []
for i in range(3):
    body = json.dumps({
        'items': [{'productId': sys.argv[1], 'quantity': 1}],
        'orderer': {'ordererName': f'일괄손님{i}', 'ordererPhone': '010-9999-8888',
                    'postcode': '06236', 'address1': '서울'},
    })
    out = subprocess.run(['curl', '-s', '-X', 'POST', sys.argv[2] + '/orders',
                          '-H', 'content-type: application/json', '-d', body],
                         capture_output=True, text=True).stdout
    ids.append(json.loads(out)['id'])
print(json.dumps(ids))
" "$BULK_PID" "$SHOP")"
BULK_N="$(echo "$BULK_IDS" | /usr/bin/python3 -c "import sys,json;print(len(json.load(sys.stdin)))")"
check "일괄 시험용 주문 3건" "$BULK_N" "3"
printf '{"action":"mark-paid","ids":%s}' "$BULK_IDS" > "$TMP/bulk.json"
BULK_RES="$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' --data-binary "@$TMP/bulk.json")"
contains "일괄 입금 확인이 처리 건수를 알려준다" "$BULK_RES" "\"affected\":${BULK_N}"
check "실제로 결제완료가 되었다" "$(psql_q "SELECT count(*) FROM shop_orders o JOIN shop_order_items i ON i.order_id = o.id WHERE i.product_id = '$BULK_PID'::uuid AND o.status = 'paid'")" "$BULK_N"
# 멱등 — 두 번 눌러도 "0건"이라고 하지 않는다
contains "다시 눌러도 같은 건수" "$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' --data-binary "@$TMP/bulk.json")" "\"affected\":${BULK_N}"
# 발송 처리 — 결제완료 → 배송중은 준비중을 거쳐야 하는데, 운영자에게 두 번 누르게 하지 않는다
BULK_RES2="$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d "$(printf '{"action":"mark-shipped","ids":%s}' "$BULK_IDS")")"
contains "일괄 발송 처리 (준비중을 거쳐 간다)" "$BULK_RES2" "\"affected\":${BULK_N}"
check "배송중이 되었다" "$(psql_q "SELECT count(*) FROM shop_orders o JOIN shop_order_items i ON i.order_id = o.id WHERE i.product_id = '$BULK_PID'::uuid AND o.status = 'shipped'")" "$BULK_N"
# 이력에는 거쳐 간 단계가 사실대로 남는다 (준비중 + 배송중)
FIRST_BULK_ID="$(echo "$BULK_IDS" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)[0])")"
check "이력에 준비중도 남는다" "$(psql_q "SELECT count(*) FROM shop_order_events WHERE order_id = '$FIRST_BULK_ID' AND to_status = 'preparing'")" "1"
# 전이할 수 없는 건은 건너뛰고 나머지를 막지 않는다 (배송중 → 결제완료는 불가)
SKIP_RES="$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d "$(printf '{"action":"mark-paid","ids":%s}' "$BULK_IDS")")"
contains "전이 불가는 건너뛴다" "$SKIP_RES" "\"skipped\":${BULK_N}"
contains "건너뛰어도 오류가 아니다" "$SKIP_RES" '"ok":true'
# 위험한 것은 일괄로 주지 않는다 — 취소·환불은 재고·포인트를 되돌리고 복구할 수 없다
# 위험한 것은 일괄로 주지 않는다 — 취소·환불은 재고·포인트를 되돌리고 복구할 수 없다
ORDER_BULK="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/orders" | /usr/bin/python3 -c "
import sys, json
print(json.dumps(json.load(sys.stdin).get('bulkActions', []), ensure_ascii=False))
")"
contains "발송 처리가 일괄 작업에 있다" "$ORDER_BULK" '"mark-shipped"'
absent "취소는 일괄 작업에 없다" "$ORDER_BULK" "cancel"
absent "환불도 일괄 작업에 없다" "$ORDER_BULK" "refund"
check "선택이 없으면 거부" "$(code -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d '{"action":"mark-paid","ids":[]}')" "400"
check "모르는 작업은 거부" "$(code -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d "$(printf '{"action":"drop-all","ids":%s}' "$BULK_IDS")")" "400"
check "비관리자는 일괄 처리 불가" "$(code -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d '{"action":"mark-paid","ids":["00000000-0000-0000-0000-000000000000"]}')" "403"

echo "── 송장번호 일괄 입력 (택배사 목록을 그대로 붙여넣는다)"
# 새 주문 두 건을 만들어 입금 확인까지 해 둔다 (발송 직전 상태)
TRK_IDS="$(/usr/bin/python3 -c "
import json, subprocess, sys
ids = []
for i in range(2):
    body = json.dumps({
        'items': [{'productId': sys.argv[1], 'quantity': 1}],
        'orderer': {'ordererName': f'송장손님{i}', 'ordererPhone': '010-7777-6666',
                    'postcode': '06236', 'address1': '서울'},
    })
    out = subprocess.run(['curl', '-s', '-X', 'POST', sys.argv[2] + '/orders',
                          '-H', 'content-type: application/json', '-d', body],
                         capture_output=True, text=True).stdout
    ids.append(json.loads(out)['id'])
print(json.dumps(ids))
" "$BULK_PID" "$SHOP")"
curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' \
  -d "$(printf '{"action":"mark-paid","ids":%s}' "$TRK_IDS")" -o /dev/null
# 주문번호를 읽어 택배사 파일 흉내를 만든다 — 쉼표·탭·공백을 섞어 넣는다
TRK_TEXT="$(/usr/bin/python3 -c "
import json, subprocess, sys
ids = json.loads(sys.argv[1])
out = subprocess.run(['curl', '-s', '-b', sys.argv[3], sys.argv[2] + '/admin/orders'],
                     capture_output=True, text=True).stdout
byid = {o['id']: o['order_no'] for o in json.loads(out)['items']}
seps = [', ', '\t']
lines = [byid[i] + seps[n % 2] + f'99900{n}' for n, i in enumerate(ids)]
lines.append('20000101-999999, 없는주문송장')   # 선택 밖의 주문번호가 섞여 있어도 무해해야 한다
print('\n'.join(lines))
" "$TRK_IDS" "$SHOP" "$CK")"
printf '{"action":"set-tracking","ids":%s,"params":{"tracking":%s}}' \
  "$TRK_IDS" "$(/usr/bin/python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$TRK_TEXT")" > "$TMP/trk.json"
TRK_RES="$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' --data-binary "@$TMP/trk.json")"
contains "두 건에 송장이 들어갔다" "$TRK_RES" '"affected":2'
TRK_FIRST="$(echo "$TRK_IDS" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)[0])")"
check "송장번호가 저장됐다" "$(psql_q "SELECT tracking_no FROM shop_orders WHERE id = '$TRK_FIRST'::uuid")" "999000"
check "발송까지 함께 넘어갔다" "$(psql_q "SELECT status FROM shop_orders WHERE id = '$TRK_FIRST'::uuid")" "shipped"
# 탭으로 구분한 줄도 받는다 (택배사마다 파일 모양이 다르다)
TRK_SECOND="$(echo "$TRK_IDS" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)[1])")"
check "탭 구분도 읽는다" "$(psql_q "SELECT tracking_no FROM shop_orders WHERE id = '$TRK_SECOND'::uuid")" "999001"
# 선택 밖의 주문번호가 섞여 있어도 다른 주문을 건드리지 않는다
check "선택 밖 주문번호는 무시" "$(psql_q "SELECT count(*) FROM shop_orders WHERE tracking_no = '없는주문송장'")" "0"
# 목록에 없는 선택은 건너뛴다 (송장을 못 받은 주문)
SKIP_TRK="$(curl -s -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' \
  -d "$(printf '{"action":"set-tracking","ids":%s,"params":{"tracking":"20000101-000001, 111"}}' "$TRK_IDS")")"
contains "송장을 못 받은 주문은 건너뛴다" "$SKIP_TRK" '"skipped":2'
check "빈 입력은 거부" "$(code -b "$CK" -X POST "$SHOP/admin/orders/bulk" -H 'content-type: application/json' -d "$(printf '{"action":"set-tracking","ids":%s,"params":{"tracking":"   "}}' "$TRK_IDS")")" "400"
# 화면이 붙여넣는 칸을 그릴 수 있어야 한다 (선택지가 아니라 자유 입력).
# 문자열로 찾지 않는다 — json.dumps 의 공백 유무에 검사가 걸린다(실제로 걸렸다)
TRK_INPUT_TYPE="$(echo "$ORDER_BULK" | /usr/bin/python3 -c "
import sys, json
for a in json.load(sys.stdin):
    if a.get('code') == 'set-tracking': print((a.get('input') or {}).get('type', ''))
")"
check "송장 작업은 붙여넣는 입력" "$TRK_INPUT_TYPE" "textarea"

echo "── 목록 좁히기 (대시보드가 보낸 그 건들만 보여야 한다)"
ALL_N="$(curl -s -b "$CK" "$SHOP/admin/orders" | jq_get "['total']")"
SHIPPED_N="$(curl -s -b "$CK" "$SHOP/admin/orders?status=shipped" | jq_get "['total']")"
PENDING_N="$(curl -s -b "$CK" "$SHOP/admin/orders?status=pending" | jq_get "['total']")"
[[ "$SHIPPED_N" -gt 0 && "$SHIPPED_N" -lt "$ALL_N" ]] \
  && ok "상태로 좁힌다 (전체 ${ALL_N} → 배송중 ${SHIPPED_N})" || bad "상태로 좁힌다 (전체 ${ALL_N}, 배송중 ${SHIPPED_N})"
# total 과 items 가 같은 조건을 써야 한다 — 다르면 "37건"이라 표시하고 20건만 보여준다
ITEMS_N="$(curl -s -b "$CK" "$SHOP/admin/orders?status=shipped" | /usr/bin/python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")"
check "총 개수와 목록이 같은 조건" "$ITEMS_N" "$SHIPPED_N"
ONLY_SHIPPED="$(curl -s -b "$CK" "$SHOP/admin/orders?status=shipped" | /usr/bin/python3 -c "
import sys, json
print('yes' if all(o['status'] == 'shipped' for o in json.load(sys.stdin)['items']) else 'no')")"
check "걸러진 것만 나온다" "$ONLY_SHIPPED" "yes"
# 모르는 값은 전체 (쿼리스트링을 그대로 믿지 않는다)
check "모르는 상태는 전체" "$(curl -s -b "$CK" "$SHOP/admin/orders?status=../etc" | jq_get "['total']")" "$ALL_N"
# 상품 목록도 좁힌다
PROD_ALL="$(curl -s -b "$CK" "$SHOP/admin/products" | jq_get "['total']")"
PROD_SELL="$(curl -s -b "$CK" "$SHOP/admin/products?status=selling" | jq_get "['total']")"
[[ "$PROD_SELL" -le "$PROD_ALL" && "$PROD_SELL" -gt 0 ]] && ok "상품도 상태로 좁힌다" || bad "상품도 상태로 좁힌다 ($PROD_SELL / $PROD_ALL)"
check "분류 값이 uuid 가 아니면 무시" "$(curl -s -b "$CK" "$SHOP/admin/products?category=notauuid" | jq_get "['total']")" "$PROD_ALL"
# 화면이 드롭다운을 그릴 수 있어야 한다
ORDER_FILTERS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/orders" | /usr/bin/python3 -c "
import sys, json
print(json.dumps([f['name'] for f in json.load(sys.stdin).get('filters', [])]))")"
contains "주문 목록에 상태 필터 선언" "$ORDER_FILTERS" '"status"'
# 대시보드 카드가 그 목록으로 곧바로 보낸다
DASH3="$(curl -s -b "$CK" "$API/api/admin/dashboard")"
QUEUE_LINK="$(echo "$DASH3" | /usr/bin/python3 -c "
import sys, json
for c in json.load(sys.stdin).get('cards', []):
    if c['title'] == '처리 대기': print(c.get('link') or '')")"
contains "처리 대기 카드가 급한 목록으로 보낸다" "$QUEUE_LINK" "status="

echo "── 상품 붙여넣기 등록 (엑셀에서 옮겨 오는 길)"
imp() {  # imp <붙여넣을 텍스트>
  /usr/bin/python3 -c "
import json, subprocess, sys
body = json.dumps({'text': sys.argv[1]})
print(subprocess.run(['curl', '-s', '-b', sys.argv[3], '-X', 'POST', sys.argv[2] + '/admin/products/import',
                      '-H', 'content-type: application/json', '-d', body],
                     capture_output=True, text=True).stdout)
" "$1" "$SHOP" "$CK"
}
# 엑셀에서 복사하면 탭으로 구분된다
IMP1="$(imp "$(printf '주소\t상품명\t판매가\t재고\t상태\nimp-a\t가져온 상품 A\t11000\t5\t판매중\nimp-b\t가져온 상품 B\t22000\t0\t품절')")"
contains "탭 구분 표를 등록한다" "$IMP1" '"created":2'
check "실제로 들어갔다" "$(psql_q "SELECT count(*) FROM shop_products WHERE slug LIKE 'imp-%'")" "2"
check "한글 상태 표기도 읽는다" "$(psql_q "SELECT status FROM shop_products WHERE slug = 'imp-b'")" "soldout"
# 같은 표를 다시 붙여도 두 벌이 되지 않는다 (주소가 있으면 수정)
IMP2="$(imp "$(printf '주소\t상품명\t판매가\t재고\nimp-a\t가져온 상품 A (수정)\t13000\t7')")"
contains "이미 있는 주소는 수정" "$IMP2" '"updated":1'
check "상품이 늘지 않았다" "$(psql_q "SELECT count(*) FROM shop_products WHERE slug LIKE 'imp-%'")" "2"
check "값이 바뀌었다" "$(psql_q "SELECT price FROM shop_products WHERE slug = 'imp-a'")" "13000"
# 쉼표 구분과 따옴표 (상품명에 쉼표가 들어간다)
IMP3="$(imp "$(printf '주소,상품명,판매가\nimp-c,\"머그컵, 화이트\",9000')")"
contains "쉼표 구분도 읽는다" "$IMP3" '"created":1'
check "따옴표 안의 쉼표를 지킨다" "$(psql_q "SELECT name FROM shop_products WHERE slug = 'imp-c'")" "머그컵, 화이트"
# 실패한 줄만 건너뛰고 나머지는 넣는다 — 오타 하나로 이백 줄을 막지 않는다
IMP4="$(imp "$(printf '주소\t상품명\t판매가\nimp-d\t정상 상품\t5000\n\t이름만 있음\t5000\nimp-e\t가격이 글자\t오천원\nUPPER\t대문자 주소\t5000')")"
contains "정상인 줄은 들어간다" "$IMP4" '"created":1'
contains "실패한 줄을 알려준다" "$IMP4" '"line":3'
contains "실패 이유도 알려준다" "$IMP4" "숫자가 아닙니다"
contains "주소 규칙 위반도 잡는다" "$IMP4" "영문 소문자"
check "정상인 줄만 저장됐다" "$(psql_q "SELECT count(*) FROM shop_products WHERE slug IN ('imp-d','imp-e')")" "1"
# 없는 분류는 조용히 넘어가지 않는다 (오타를 삼키면 분류 없는 상품이 쌓인다)
contains "없는 분류는 실패로" "$(imp "$(printf '주소\t상품명\t판매가\t분류\nimp-f\t분류 오타\t5000\t없는분류')")" "없는 분류입니다"
# 머리글이 없으면 무엇이 무엇인지 알 수 없다
contains "머리글이 없으면 거부" "$(imp "$(printf 'imp-g\t머리글 없음\t5000')")" "머리글"
check "한 줄만 있으면 거부" "$(code -b "$CK" -X POST "$SHOP/admin/products/import" -H 'content-type: application/json' -d '{"text":"주소\t상품명"}')" "400"
check "비관리자는 가져올 수 없다" "$(code -X POST "$SHOP/admin/products/import" -H 'content-type: application/json' -d '{"text":"x"}')" "403"
# 화면이 붙여넣기 버튼을 그릴 수 있어야 한다
IMPORT_SPEC="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products" | /usr/bin/python3 -c "
import sys, json
print(json.dumps(json.load(sys.stdin).get('importFrom') or {}, ensure_ascii=False))")"
contains "상품 리소스가 가져오기를 선언" "$IMPORT_SPEC" '"/import"'
contains "예시도 함께 준다" "$IMPORT_SPEC" "mug-white"

echo "── 답변 대기만 보기 (대시보드가 보낸 그 후기·문의)"
REV_ALL="$(curl -s -b "$CK" "$SHOP/admin/reviews" | jq_get "['total']")"
REV_WAIT="$(curl -s -b "$CK" "$SHOP/admin/reviews?reply=waiting" | jq_get "['total']")"
REV_DONE="$(curl -s -b "$CK" "$SHOP/admin/reviews?reply=done" | jq_get "['total']")"
[[ $((REV_WAIT + REV_DONE)) -eq "$REV_ALL" ]] \
  && ok "답변 대기 + 완료 = 전체 (${REV_WAIT} + ${REV_DONE} = ${REV_ALL})" || bad "답변 대기 + 완료 = 전체 (${REV_WAIT}+${REV_DONE} vs ${REV_ALL})"
ONLY_WAIT="$(curl -s -b "$CK" "$SHOP/admin/reviews?reply=waiting" | /usr/bin/python3 -c "
import sys, json
print('yes' if all(not r['admin_reply'] for r in json.load(sys.stdin)['items']) else 'no')")"
check "답변 대기만 나온다" "$ONLY_WAIT" "yes"
# 좁히지 않아도 할 일이 위로 온다
FIRST_UNANSWERED="$(curl -s -b "$CK" "$SHOP/admin/reviews" | /usr/bin/python3 -c "
import sys, json
items = json.load(sys.stdin)['items']
print('yes' if not items or not items[0]['admin_reply'] else 'no')")"
check "답변 대기가 먼저 온다" "$FIRST_UNANSWERED" "yes"
check "표시 여부로도 좁힌다" "$(curl -s -b "$CK" "$SHOP/admin/reviews?visible=off" | /usr/bin/python3 -c "
import sys, json
print('yes' if all(r['is_visible'] is False for r in json.load(sys.stdin)['items']) else 'no')")" "yes"
INQ_WAIT="$(curl -s -b "$CK" "$SHOP/admin/inquiries?reply=waiting" | /usr/bin/python3 -c "
import sys, json
print('yes' if all(not q['admin_reply'] for q in json.load(sys.stdin)['items']) else 'no')")"
check "문의도 답변 대기만" "$INQ_WAIT" "yes"

echo "── 자주 여는 목록이 인덱스를 타는가 (규모에서 무너지지 않게)"
# 계획을 직접 본다. 개수가 적은 시험 DB 에서는 순차 스캔이 더 빠를 수 있으므로
# enable_seqscan 을 끄고 **인덱스가 존재해 쓸 수 있는지**를 확인한다.
plan_of() {
  node -e '
    const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
    (async () => {
      const c = new Client(process.env.DATABASE_URL); await c.connect();
      await c.query("SET enable_seqscan = off");
      const r = await c.query("EXPLAIN (FORMAT JSON) " + process.argv[1]);
      console.log(JSON.stringify(r.rows[0]["QUERY PLAN"][0].Plan));
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$1"
}
contains "관리 주문 첫 화면이 인덱스를 쓴다" \
  "$(plan_of "SELECT o.id FROM shop_orders o ORDER BY o.created_at DESC LIMIT 30")" "shop_orders_recent_idx"
contains "후기 관리 정렬이 인덱스를 쓴다" \
  "$(plan_of "SELECT r.id FROM shop_reviews r ORDER BY (r.admin_reply IS NULL) DESC, r.created_at DESC LIMIT 30")" "shop_reviews_admin_idx"
contains "손님 상품 목록이 인덱스를 쓴다" \
  "$(plan_of "SELECT p.slug FROM shop_products p WHERE p.status IN ('selling','soldout') ORDER BY p.sort_order, p.created_at DESC LIMIT 24")" "shop_products_public_idx"
# 가격대 눈금도 같은 인덱스를 쓴다(price 를 INCLUDE 했다). **계획 종류는 못박지 않는다** —
# 행이 적은 시험 DB 에서는 옵티마이저가 Bitmap 을 고르는 것이 맞고, 규모가 커지면
# Index Only Scan 이 된다. 우리가 보장할 것은 인덱스가 쓸 수 있는 모양이라는 것뿐이다
contains "가격 눈금도 같은 인덱스를 쓴다" \
  "$(plan_of "SELECT min(p.price), max(p.price) FROM shop_products p WHERE p.status IN ('selling','soldout')")" "shop_products_public_idx"

echo "── 목록은 목록에 필요한 것만 (폼에 필요한 것은 단건에서)"
# 상세 HTML 을 목록에 실으면 응답의 대부분이 그것이 된다 — 사진·표가 든 실제 상품이면
# 한 화면이 수 MB 다. 수정은 한 번에 하나이므로 그때 받아 오면 된다
psql_q "UPDATE shop_products SET description = repeat('가나다라마바사아자차카타파하', 400) WHERE slug LIKE 'imp-%' OR slug LIKE 'sample-%'" >/dev/null
LIST_SIZE="$(curl -s -b "$CK" -o /dev/null -w '%{size_download}' "$SHOP/admin/products")"
LIST_HAS_DESC="$(curl -s -b "$CK" "$SHOP/admin/products" | /usr/bin/python3 -c "
import sys, json
print('yes' if any('description' in it for it in json.load(sys.stdin)['items']) else 'no')")"
check "목록에 상세 HTML 을 싣지 않는다" "$LIST_HAS_DESC" "no"
[[ "$LIST_SIZE" -lt 20000 ]] && ok "목록 응답이 가볍다 (${LIST_SIZE} bytes)" || bad "목록 응답이 무겁다 (${LIST_SIZE} bytes)"
# 단건에는 폼에 필요한 것이 다 있어야 한다 — 없으면 수정할 때 값이 날아간다
# 특정 slug 에 기대지 않는다 — 이 수트가 만드는 상품은 앞 절에 따라 달라진다
ONE_ID="$(curl -s -b "$CK" "$SHOP/admin/products" | /usr/bin/python3 -c "
import sys, json
print(json.load(sys.stdin)['items'][0]['id'])")"
ONE="$(curl -s -b "$CK" "$SHOP/admin/products/$ONE_ID")"
for f in description images_text options_text related_text slug name price; do
  contains "단건에 $f" "$ONE" "\"$f\""
done
check "없는 상품은 404" "$(code -b "$CK" "$SHOP/admin/products/00000000-0000-0000-0000-000000000000")" "404"
check "비관리자는 단건도 못 본다" "$(code "$SHOP/admin/products/$ONE_ID")" "403"

echo "── 주문서 오류는 어느 칸인지 알려준다 (결제 직전에 막히면 판매가 끝난다)"
# 손님이 여덟 칸 중 어디를 고쳐야 하는지 메시지만으로는 알 수 없다
BADCART="$(curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' -d "{\"productId\":\"$BULK_PID\",\"quantity\":1}")"
BADGT="$(echo "$BADCART" | jq_get "['guestToken']")"
err_field() {  # err_field <주문자 JSON 조각>
  printf '{"guestToken":"%s","orderer":%s}' "$BADGT" "$1" > "$TMP/badorder.json"
  curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/badorder.json"
}
PHONE_ERR="$(err_field '{"ordererName":"홍길동","ordererPhone":"전화가아님","postcode":"06236","address1":"서울"}')"
contains "형식 오류에 칸 이름" "$PHONE_ERR" '"field":"ordererPhone"'
contains "사람이 읽는 문구도 그대로" "$PHONE_ERR" "연락처 형식"
NAME_ERR="$(err_field '{"ordererName":"","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}')"
contains "빈 칸도 어느 칸인지" "$NAME_ERR" '"field":"ordererName"'
MAIL_ERR="$(err_field '{"ordererName":"홍길동","ordererPhone":"010-1111-2222","ordererEmail":"골뱅이없음","postcode":"06236","address1":"서울"}')"
contains "이메일도" "$MAIL_ERR" '"field":"ordererEmail"'
# 칸을 특정할 수 없는 오류는 field 없이 온다 (화면이 메시지로 안내한다)
absent "칸을 모르는 오류에는 field 가 없다" "$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' -d '{"orderer":{"ordererName":"홍","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}')" '"field"'
# 화면이 그 칸으로 데려갈 준비가 되어 있는가
CO_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/checkout"}' | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))")"
contains "오류 칸에 표시를 건다" "$CO_HTML" "aria-invalid"
contains "그 칸으로 포커스를 옮긴다" "$CO_HTML" "bad.focus()"
contains "오류는 즉시 읽힌다 (status 가 아니라 alert)" "$CO_HTML" 'class="brick-buy-msg" role="alert"'
contains "눈으로도 보이게" "$CO_HTML" '[aria-invalid="true"]'

echo "── 재고 소진 후"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"늦은손님","ordererPhone":"010-0000-0000","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/late.json"
check "품절 상품 주문 차단" \
  "$(code -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/late.json")" "409"
# 장바구니는 여전히 조회 가능해야 한다 (재고 부족을 표시만)
LENIENT="$(curl -s "$SHOP/cart?guest=$GT")"
contains "품절이어도 장바구니 조회 가능" "$LENIENT" '"available":false'
contains "품절 사유 표시" "$LENIENT" '"issue"'

echo "── 주문 상태 전이"
# "목록 첫 항목"으로 집으면 앞 절이 주문을 하나 더 만들 때마다 깨진다(실제로 그랬다) —
# 이 검사가 필요한 것은 **입금대기 주문**이므로 그것을 명시적으로 고른다
OID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['status'] == 'pending': print(o['id']); break")"
[[ -n "$OID" ]] && ok "전이 시험용 입금대기 주문" || bad "전이 시험용 입금대기 주문이 없다"
check "잘못된 전이 차단(pending→delivered)" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' \
      -d '{"status":"delivered"}')" "400"
contains "정상 전이(pending→paid)" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' \
      -d '{"status":"paid"}')" '"ok":true'

echo "── 취소 시 재고 복원"
OID2="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['status'] == 'pending': print(o['id']); break")"
if [[ -n "$OID2" ]]; then
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID2" -H 'content-type: application/json' \
    -d '{"status":"cancelled","note":"스모크 취소"}' >/dev/null
  contains "취소 후 재고 복원(1개)" "$(curl -s "$SHOP/products/smoke-item")" '"stock":1'
  check "취소된 주문은 전이 불가" \
    "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$OID2" -H 'content-type: application/json' \
        -d '{"status":"paid"}')" "400"
else
  bad "취소 대상 주문 없음"
fi

echo "── 옵션·다중 이미지 (관리 텍스트 편집)"
cat > "$TMP/optprod.json" <<'JSON'
{"slug":"opt-item","name":"옵션 상품","price":10000,"status":"selling","stock":100,
 "images_text":"/uploads/a.jpg\n/uploads/b.jpg",
 "options_text":"색상: 빨강|1000|5\n색상: 파랑||3\n무광"}
JSON
OPID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  --data-binary "@$TMP/optprod.json" | jq_get "['id']")"
[[ -n "$OPID" ]] && ok "옵션·이미지 포함 상품 등록" || bad "옵션·이미지 포함 상품 등록"
OPDETAIL="$(curl -s "$SHOP/products/opt-item")"
contains "옵션 3개 생성" "$OPDETAIL" '"무광"'
contains "옵션 추가금 반영" "$OPDETAIL" '"extra_price":1000'
contains "다중 이미지 저장" "$OPDETAIL" '/uploads/b.jpg'
contains "대표 이미지 자동 지정(첫 줄)" "$OPDETAIL" '"image_url":"/uploads/a.jpg"'

# 폼이 편집할 수 있는 형태(배열 → 텍스트)로 되돌려 주는 것은 **단건**의 일이다.
# 목록은 목록에 필요한 것만 싣는다(상세 HTML 을 30건 실으면 한 화면이 수 MB 다)
OPID_ADMIN="$(psql_q "SELECT id FROM shop_products WHERE slug = 'opt-item'")"
ADMIN_ONE="$(curl -s -b "$CK" "$SHOP/admin/products/$OPID_ADMIN")"
contains "옵션 텍스트 역변환" "$ADMIN_ONE" '색상: 빨강|1000|5'
contains "이미지 텍스트 역변환" "$ADMIN_ONE" '/uploads/a.jpg'

check "옵션 이름 중복 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"dup-opt","name":"x","price":100,"status":"selling","options_text":"빨강|0|1\n빨강|0|2"}')" "400"
check "옵션 재고 음수 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"neg-opt","name":"x","price":100,"status":"selling","options_text":"빨강|0|-5"}')" "400"
check "javascript: 이미지 주소 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"js-img","name":"x","price":100,"status":"selling","images_text":"javascript:alert(1)"}')" "400"

# 옵션 id 유지: 장바구니가 조용히 망가지지 않아야 한다
RED_ID="$(echo "$OPDETAIL" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['options']:
    if '빨강' in o['name']: print(o['id']); break")"
printf '{"productId":"%s","optionId":"%s","quantity":1}' "$OPID" "$RED_ID" > "$TMP/optcart.json"
OGT="$(curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/optcart.json" | jq_get "['guestToken']")"
contains "옵션 담기(추가금 11000원)" "$(curl -s "$SHOP/cart?guest=$OGT")" '"unitPrice":11000'
# 이름을 그대로 두고 하나만 지운 뒤에도 빨강의 id는 살아 있어야 한다
cat > "$TMP/optprod2.json" <<'JSON'
{"slug":"opt-item","name":"옵션 상품","price":10000,"status":"selling","stock":100,
 "images_text":"/uploads/a.jpg",
 "options_text":"색상: 빨강|2000|5\n색상: 파랑||3"}
JSON
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$OPID" -H 'content-type: application/json' \
  --data-binary "@$TMP/optprod2.json" >/dev/null
NEW_RED="$(curl -s "$SHOP/products/opt-item" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['options']:
    if '빨강' in o['name']: print(o['id']); break")"
check "옵션 수정 후 id 유지(장바구니 보존)" "$NEW_RED" "$RED_ID"
OPT_NAMES="$(curl -s "$SHOP/products/opt-item")"
[[ "$OPT_NAMES" != *"무광"* ]] && ok "목록에서 뺀 옵션 삭제" || bad "목록에서 뺀 옵션 삭제"
contains "수정된 추가금 반영" "$(curl -s "$SHOP/cart?guest=$OGT")" '"unitPrice":12000'

echo "── 상품 후기 (구매 검증)"
BCK="$TMP/buyer.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"buyer@shop.test","password":"buyerpass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"구매자"}' >/dev/null
curl -s -c "$BCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"buyer@shop.test","password":"buyerpass123"}' >/dev/null

check "비로그인 후기 작성 차단" \
  "$(code -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"좋아요 정말 좋아요"}')" "401"
contains "미구매 회원은 자격 없음" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"not_purchased"'
check "미구매 회원 후기 작성 차단(핵심)" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"안 사고 쓰는 후기"}')" "403"

# 회원 주문 → 결제 확인까지
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-2222-3333","postcode":"06236","address1":"서울"}}' "$OPID" > "$TMP/border.json"
BORDER="$(curl -s -b "$BCK" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/border.json")"
BORDER_NO="$(echo "$BORDER" | jq_get "['orderNo']")"
[[ -n "$BORDER_NO" ]] && ok "회원 주문 생성" || bad "회원 주문 생성"
BOID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['order_no'] == '$BORDER_NO': print(o['id']); break")"
contains "입금대기 상태에서는 자격 없음" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"not_purchased"'
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$BOID" -H 'content-type: application/json' \
  -d '{"status":"paid"}' >/dev/null
contains "결제 확인 후 자격 획득" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"canWrite":true'

echo "── 사진 후기 (카페24 후기의 핵심)"
# 사진을 만든다 — sharp 는 API 에 들어 있으므로 그것으로
node -e '
const sharp = require("'"$ROOT"'/apps/api/node_modules/sharp");
const w=1800,h=1200, buf=Buffer.alloc(w*h*3);
for (let y=0;y<h;y++) for (let x=0;x<w;x++){const i=(y*w+x)*3;buf[i]=(x*255/w)|0;buf[i+1]=140;buf[i+2]=(y*255/h)|0;}
sharp(buf,{raw:{width:w,height:h,channels:3}}).withExif({IFD0:{Make:"Brick"},GPS:{GPSLatitudeRef:"N"}}).jpeg({quality:95}).toFile(process.argv[1]);
' "$TMP/review.jpg" 2>/dev/null || echo "(sharp 없음 — 이 절은 건너뜁니다)"
if [[ -f "$TMP/review.jpg" ]]; then
  # 비구매자는 업로드조차 못 한다 — 그러지 않으면 아무 회원이나 스토리지에 파일을 쌓는다
  NCK="$TMP/nonbuyer.txt"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
    -d '{"email":"nonbuyer@shop.test","password":"nonbuyer123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"비구매자"}' >/dev/null
  curl -s -c "$NCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d '{"email":"nonbuyer@shop.test","password":"nonbuyer123"}' >/dev/null
  check "비구매자는 사진을 올릴 수 없다" \
    "$(code -b "$NCK" -X POST "$SHOP/products/$OPID/reviews/images" -F "files=@$TMP/review.jpg;type=image/jpeg")" "403"
  check "비로그인도 막는다" \
    "$(code -X POST "$SHOP/products/$OPID/reviews/images" -F "files=@$TMP/review.jpg;type=image/jpeg")" "401"
  # 구매자는 올릴 수 있다
  UP="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/reviews/images" -F "files=@$TMP/review.jpg;type=image/jpeg")"
  contains "구매자는 사진을 올린다" "$UP" '"urls":["/uploads/shop/reviews/'
  RURL="$(echo "$UP" | jq_get "['urls'][0]")"
  check "올린 사진이 서빙된다" "$(code "$API$RURL")" "200"
  # 코어 이미지 파이프라인을 거친다 — 1600px 로 줄고 EXIF(촬영 위치)가 지워진다
  curl -s "$API$RURL" -o "$TMP/review-saved.jpg"
  META="$(node -e '
const sharp = require("'"$ROOT"'/apps/api/node_modules/sharp");
sharp(process.argv[1]).metadata().then(m => console.log(m.width + " " + (m.exif ? "exif" : "clean")));
' "$TMP/review-saved.jpg" 2>/dev/null)"
  check "1600px 로 줄인다" "${META%% *}" "1600"
  check "EXIF(촬영 위치)를 지운다" "${META##* }" "clean"
  # 이미지가 아닌 파일과 장수 제한
  check "이미지가 아니면 거부" "$(printf 'x' > "$TMP/r.txt"; code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews/images" -F "files=@$TMP/r.txt;type=text/plain")" "400"
  check "네 장 이상은 거부" "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews/images" \
    -F "files=@$TMP/review.jpg;type=image/jpeg" -F "files=@$TMP/review.jpg;type=image/jpeg" \
    -F "files=@$TMP/review.jpg;type=image/jpeg" -F "files=@$TMP/review.jpg;type=image/jpeg")" "400"
  # 후기에 붙여 저장하면 목록에 사진이 나온다
  printf '{"rating":5,"content":"사진과 함께 남기는 후기입니다.","images":["%s"]}' "$RURL" > "$TMP/rphoto.json"
  RPOST="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' --data-binary "@$TMP/rphoto.json")"
  contains "사진 후기 등록" "$RPOST" '"id"'
  contains "목록 응답에 사진이 담긴다" "$(curl -s "$SHOP/products/$OPID/reviews")" "$RURL"
  # 같은 사람은 한 번만 쓴다(기존 규칙) — 아래 검사들이 이 후기를 쓰지 않게 지운다
  RID="$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility" | jq_get "['reviewId']")"
  [[ -n "$RID" ]] && curl -s -b "$BCK" -X DELETE "$SHOP/reviews/$RID" -o /dev/null
fi

check "짧은 후기 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"굿"}')" "400"
check "범위 밖 별점 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":9,"content":"별점 조작 시도입니다"}')" "400"
RID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
  -d '{"rating":4,"content":"배송이 빠르고 품질이 좋았습니다."}' | jq_get "['id']")"
[[ -n "$RID" ]] && ok "구매자 후기 작성" || bad "구매자 후기 작성"
check "같은 상품 재작성 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":1,"content":"두 번째 후기 시도입니다"}')" "409"
contains "이미 작성 상태 안내" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"already_written"'

REVIEWS="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "후기 목록 공개" "$REVIEWS" "배송이 빠르고"
contains "구매확인 배지" "$REVIEWS" '"verified":true'
[[ "$REVIEWS" != *'"order_no"'* ]] && ok "주문번호 비노출" || bad "주문번호가 노출됨"
contains "평균 별점 집계" "$REVIEWS" '"average":4'
contains "별점 분포" "$REVIEWS" '"distribution"'
contains "상품에 후기 수 반영" "$(curl -s "$SHOP/products/opt-item")" '"review_count":1'
contains "상품 평점 반영" "$(curl -s "$SHOP/products/opt-item")" '"rating_avg":4'

echo "── 후기 관리 (판매자)"
contains "관리 목록에 후기" "$(curl -s -b "$CK" "$SHOP/admin/reviews")" '"verified":true'
contains "판매자 답변 저장" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
      -d '{"admin_reply":"이용해 주셔서 감사합니다.","is_visible":true}')" '"ok":true'
contains "답변이 고객에게 보임" "$(curl -s "$SHOP/products/$OPID/reviews")" "감사합니다"
curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
  -d '{"admin_reply":"이용해 주셔서 감사합니다.","is_visible":false}' >/dev/null
HIDDEN="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "숨긴 후기는 목록에서 제외" "$HIDDEN" '"total":0'
contains "숨김 시 평점에서 제외" "$(curl -s "$SHOP/products/opt-item")" '"review_count":0'
contains "관리자는 숨긴 후기도 조회" \
  "$(curl -s -b "$CK" "$SHOP/products/$OPID/reviews")" '"is_visible":false'
curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
  -d '{"admin_reply":"","is_visible":true}' >/dev/null
contains "표시 복구 후 평점 재계산" "$(curl -s "$SHOP/products/opt-item")" '"review_count":1'

echo "── 상품 문의"
check "비로그인 문의 차단" \
  "$(code -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
      -d '{"title":"질문","content":"내용"}')" "401"
check "제목 없는 문의 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
      -d '{"title":"","content":"내용만 있음"}')" "400"
QID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
  -d '{"title":"배송 기간 문의","content":"언제 도착하나요?"}' | jq_get "['id']")"
[[ -n "$QID" ]] && ok "공개 문의 작성" || bad "공개 문의 작성"
SQID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
  -d '{"title":"주소 변경","content":"연락처 010-9999-8888로 변경해주세요","isSecret":true}' | jq_get "['id']")"
[[ -n "$SQID" ]] && ok "비밀 문의 작성" || bad "비밀 문의 작성"

PUBQ="$(curl -s "$SHOP/products/$OPID/inquiries")"
contains "공개 문의는 누구나 봄" "$PUBQ" "언제 도착하나요"
contains "비밀 문의 제목 가림" "$PUBQ" "비밀 문의입니다"
[[ "$PUBQ" != *"010-9999-8888"* ]] && ok "비밀 문의 내용 비노출(개인정보)" || bad "비밀 문의 내용 노출"
contains "작성자는 자기 비밀 문의 열람" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/inquiries")" "010-9999-8888"
contains "관리자는 비밀 문의 열람" \
  "$(curl -s -b "$CK" "$SHOP/products/$OPID/inquiries")" "010-9999-8888"
contains "상품에 문의 수 반영" "$(curl -s "$SHOP/products/opt-item")" '"inquiry_count":2'

contains "관리 목록에 미답변 표시" "$(curl -s -b "$CK" "$SHOP/admin/inquiries")" '"status_label":"미답변"'
contains "문의 답변 저장" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/inquiries/$QID" -H 'content-type: application/json' \
      -d '{"admin_reply":"주문 후 2~3일 내 도착합니다."}')" '"ok":true'
contains "답변 후 상태 변경" "$(curl -s "$SHOP/products/$OPID/inquiries")" '"status":"answered"'
contains "답변 내용 공개" "$(curl -s "$SHOP/products/$OPID/inquiries")" "2~3일"

echo "── 후기·문의 권한"
CCK="$TMP/other.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"other@shop.test","password":"otherpass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"제3자"}' >/dev/null
curl -s -c "$CCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"other@shop.test","password":"otherpass123"}' >/dev/null
check "남의 후기 수정 차단" \
  "$(code -b "$CCK" -X PUT "$SHOP/reviews/$RID" -H 'content-type: application/json' \
      -d '{"rating":1,"content":"남의 후기를 조작합니다"}')" "403"
check "남의 후기 삭제 차단" "$(code -b "$CCK" -X DELETE "$SHOP/reviews/$RID")" "403"
check "남의 문의 삭제 차단" "$(code -b "$CCK" -X DELETE "$SHOP/inquiries/$QID")" "403"
contains "본인 후기 수정" \
  "$(curl -s -b "$BCK" -X PUT "$SHOP/reviews/$RID" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"다시 써보니 더 좋습니다."}')" '"ok":true'
contains "수정 후 평점 재계산" "$(curl -s "$SHOP/products/opt-item")" '"rating_avg":5'

echo "── 후기 XSS (저장형)"
XCK="$TMP/xss.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"xss@shop.test","password":"xsspass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"<img src=x onerror=alert(1)>"}' >/dev/null
curl -s -c "$XCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"xss@shop.test","password":"xsspass123"}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"엑","ordererPhone":"010-3333-4444","postcode":"06236","address1":"서울"}}' "$OPID" > "$TMP/xorder.json"
XNO="$(curl -s -b "$XCK" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/xorder.json" | jq_get "['orderNo']")"
XOID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['order_no'] == '$XNO': print(o['id']); break")"
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$XOID" -H 'content-type: application/json' -d '{"status":"paid"}' >/dev/null
curl -s -b "$XCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
  -d '{"rating":3,"content":"<script>alert(1)</script>","images":["javascript:alert(1)","/uploads/ok.jpg"]}' >/dev/null
XREV="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "후기 이미지 스킴 필터" "$XREV" '/uploads/ok.jpg'
[[ "$XREV" != *"javascript:alert"* ]] && ok "javascript: 이미지 제거" || bad "javascript: 이미지 통과"
# 렌더 시점 이스케이프 — 상세 블록 안의 클라이언트 스크립트가 esc()를 통과시킨다
contains "후기 영역 서버 렌더 포함" \
  "$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
      -d '{"name":"brick-shop/product-detail","props":{"slug":"opt-item"}}')" "brick-pd-tabs"

echo "── 후기 정렬 · 사진 후기만 보기"
psql_q "INSERT INTO shop_reviews (id, product_id, author_name, rating, content, images, created_at)
        VALUES (gen_random_uuid(), '$OPID', '사진고객', 5, '실물 사진 올립니다', '[\"/uploads/a.jpg\",\"/uploads/b.jpg\"]', now() - interval '3 days'),
               (gen_random_uuid(), '$OPID', '불만고객', 1, '기대와 달랐습니다', '[]', now() + interval '1 minute')" >/dev/null
rating_first() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d['items'][0]['rating'] if d['items'] else '')"; }
ratings_of()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(','.join(str(i['rating']) for i in d['items']))"; }
photos_all()   { python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if d['items'] and all(i['images'] for i in d['items']) else 'no')"; }

RL_DEFAULT="$(curl -s "$SHOP/products/$OPID/reviews")"
check "기본은 최신순 (방금 넣은 1점이 먼저)" "$(echo "$RL_DEFAULT" | rating_first)" "1"
contains "사진 후기 수를 알려준다" "$RL_DEFAULT" '"photoCount":2'
check "별점 높은순" "$(curl -s "$SHOP/products/$OPID/reviews?sort=high" | rating_first)" "5"
check "별점 낮은순" "$(curl -s "$SHOP/products/$OPID/reviews?sort=low" | rating_first)" "1"
# 첫 항목만 보면 나머지가 뒤섞여도 통과한다 — 전체가 정렬되어 있는지 본다
# (구체적인 별점을 박지 않는다: 위의 "본인 후기 수정" 시험이 별점을 바꾼다)
sorted_check() { python3 -c "
import sys, json
r = [i['rating'] for i in json.load(sys.stdin)['items']]
print('desc' if r == sorted(r, reverse=True) else 'asc' if r == sorted(r) else 'mixed', len(r))
"; }
check "별점 높은순은 전체가 내림차순" "$(curl -s "$SHOP/products/$OPID/reviews?sort=high" | sorted_check)" "desc 4"
check "별점 낮은순은 전체가 오름차순" "$(curl -s "$SHOP/products/$OPID/reviews?sort=low" | sorted_check)" "asc 4"
check "모르는 정렬 값은 기본으로" "$(curl -s "$SHOP/products/$OPID/reviews?sort=../etc" | rating_first)" "1"
RL_PHOTO="$(curl -s "$SHOP/products/$OPID/reviews?photo=1")"
check "사진 후기만 — 전부 사진이 있다" "$(echo "$RL_PHOTO" | photos_all)" "yes"
contains "사진 후기만 — 총 개수가 2" "$RL_PHOTO" '"total":2'
# 필터를 켠 응답에도 photoCount 가 남아야 스위치를 다시 끌 수 있다
contains "사진 필터를 켜도 스위치가 남는다" "$RL_PHOTO" '"photoCount":2'
check "사진 필터와 정렬을 함께" "$(curl -s "$SHOP/products/$OPID/reviews?photo=1&sort=high" | ratings_of)" "5,3"
# 별점이 같으면 최신순 — 정해지지 않으면 "더 보기"에서 같은 후기가 두 번 보인다
psql_q "INSERT INTO shop_reviews (id, product_id, author_name, rating, content, created_at)
        VALUES (gen_random_uuid(), '$OPID', '동점고객', 5, '같은 별점 최신', now() + interval '2 minutes')" >/dev/null
contains "같은 별점 안에서는 최신 먼저" \
  "$(curl -s "$SHOP/products/$OPID/reviews?sort=high" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['content'])")" "같은 별점 최신"
# 화면에 도구 자리가 있는가 (목록은 스크립트가 채우므로 자리와 문구를 본다)
# 블록 렌더는 JSON 을 돌려준다 — 따옴표가 이스케이프된 채로 찾으면 늘 어긋난다
render_block() { curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' -d "$1" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))"; }
DETAIL_HTML="$(render_block '{"name":"brick-shop/product-detail","props":{"slug":"opt-item"}}')"
contains "후기 도구 자리" "$DETAIL_HTML" 'data-review-tools'
contains "정렬 문구가 실려 있다" "$DETAIL_HTML" '별점 높은순'
contains "사진 후기만 문구" "$DETAIL_HTML" '사진 후기만'

# 후기·문의도 할 일이다 — 답변을 기다리는 것이 대시보드에 잡혀야 한다
DASH2="$(curl -s -b "$CK" "$API/api/admin/dashboard")"
contains "답변 안 한 후기가 할 일에 잡힌다" "$DASH2" "답변 "

echo "── 모바일 하단 구매 바 (내려 읽는 동안 살 수 있어야 한다)"
contains "하단 바가 있다" "$DETAIL_HTML" 'class="brick-buybar"'
contains "하단 바에 가격이 있다" "$DETAIL_HTML" 'class="brick-buybar-info"'
contains "하단 바에도 두 버튼" "$DETAIL_HTML" 'class="brick-buybar-msg"'
# 폼 **안**에 있어야 구매 스크립트가 묶는다 — 밖으로 나가면 눌러도 아무 일이 없다
inside_form() { /usr/bin/python3 -c "
import sys, re
h = sys.stdin.read()
m = re.search(r'<form class=\"brick-buy-form\".*?</form>', h, re.S)
print('yes' if m and 'brick-buybar' in m.group(0) else 'no')
"; }
check "하단 바가 구매 폼 안에 있다" "$(echo "$DETAIL_HTML" | inside_form)" "yes"
inside_form_acts() { /usr/bin/python3 -c "
import sys, re
m = re.search(r'<form class=.brick-buy-form.*?</form>', sys.stdin.read(), re.S)
print(m.group(0).count('data-act=') if m else 0)
"; }
# 버튼 수: 폼 안의 data-act 가 네 개(원래 둘 + 하단 둘)여야 스크립트가 넷 다 묶는다
# 재입고 알림 버튼(폼 밖)도 같은 속성을 쓰므로 전체를 세면 안 된다 — 폼 안만 센다
check "폼 안의 data-act 버튼이 네 개" "$(echo "$DETAIL_HTML" | inside_form_acts)" "4"
contains "좁은 화면에서만 나온다" "$DETAIL_HTML" '@media(max-width:640px)'
contains "테마가 비켜설 훅" "$DETAIL_HTML" '.brick-buybar-on .brick-quick'
# 품절 상품에는 구매 폼이 없으므로 바도 없다
psql_q "UPDATE shop_products SET status = 'soldout' WHERE slug = 'smoke-item'" >/dev/null
SOLDOUT_HTML="$(render_block '{"name":"brick-shop/product-detail","props":{"slug":"smoke-item"}}')"
contains "품절이면 재입고 알림 화면" "$SOLDOUT_HTML" 'brick-soldout-notice'
absent "품절 상품에는 하단 바가 없다" "$SOLDOUT_HTML" 'class="brick-buybar"'
psql_q "UPDATE shop_products SET status = 'selling' WHERE slug = 'smoke-item'" >/dev/null

echo "── 목록은 썸네일을, 상세는 원본을 (64px 칸에 2400px 사진을 내려보내지 않는다)"
# 관리자가 미디어에서 고른 것은 **원본** 주소다. 저장할 때 대응하는 썸네일을 함께 적어 둔다.
# 실제 업로드 경로로 사진을 하나 넣는다 — 미디어가 썸네일을 만드는 그 경로여야 의미가 있다
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII="
/usr/bin/python3 -c "
import base64, sys
open(sys.argv[1], 'wb').write(base64.b64decode(sys.argv[2]))
" "$TMP/pic.png" "$PNG_B64"
MEDIA="$(curl -s -b "$CK" -X POST "$API/api/media/upload" -F "file=@$TMP/pic.png;type=image/png")"
MEDIA_URL="$(echo "$MEDIA" | jq_get "['url']")"
MEDIA_THUMB="$(echo "$MEDIA" | jq_get "['thumbUrl']")"
[[ -n "$MEDIA_URL" ]] && ok "미디어 업로드" || bad "미디어 업로드 ($MEDIA)"
[[ "$MEDIA_THUMB" != "$MEDIA_URL" ]] && ok "미디어가 썸네일을 만든다" || bad "미디어가 썸네일을 만든다 ($MEDIA_THUMB)"
# 그 원본 주소로 상품을 만든다 — 상품은 목록용 주소를 스스로 찾아 적어야 한다
printf '{"slug":"thumb-item","name":"썸네일 상품","price":9000,"stock":5,"status":"selling","image_url":"%s"}' "$MEDIA_URL" > "$TMP/tp.json"
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/tp.json" -o /dev/null
check "저장할 때 썸네일 주소를 찾아 적는다" "$(psql_q "SELECT thumb_url FROM shop_products WHERE slug = 'thumb-item'")" "$MEDIA_THUMB"
# 목록 API 는 썸네일을, 상세 API 는 원본을 준다
contains "목록은 썸네일" "$(curl -s "$SHOP/products?limit=50")" "$MEDIA_THUMB"
contains "상세는 원본" "$(curl -s "$SHOP/products/thumb-item")" "$MEDIA_URL"
# 검색 결과도 목록이다
contains "검색 결과도 썸네일" "$(curl -s -G "$API/api/search" --data-urlencode "q=썸네일")" "$MEDIA_THUMB"
# 외부 URL 을 직접 붙인 상품은 썸네일이 없다 — 그때는 원본을 쓰므로 화면은 깨지지 않는다
printf '{"slug":"ext-item","name":"외부사진 상품","price":9000,"stock":5,"status":"selling","image_url":"https://example.test/a.jpg"}' > "$TMP/ep.json"
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/ep.json" -o /dev/null
check "외부 URL 은 썸네일이 없다" "$(psql_q "SELECT coalesce(thumb_url, 'NULL') FROM shop_products WHERE slug = 'ext-item'")" "NULL"
contains "그때는 목록도 원본을 쓴다" "$(curl -s "$SHOP/products?limit=50")" "https://example.test/a.jpg"
# 대표 사진을 바꾸면 목록용 주소도 따라 바뀐다 (안 하면 옛 썸네일이 남는다)
printf '{"slug":"thumb-item","name":"썸네일 상품","price":9000,"stock":5,"status":"selling","image_url":"https://example.test/b.jpg"}' > "$TMP/tp2.json"
TID="$(psql_q "SELECT id FROM shop_products WHERE slug = 'thumb-item'")"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$TID" -H 'content-type: application/json' --data-binary "@$TMP/tp2.json" -o /dev/null
check "사진을 바꾸면 썸네일도 갱신" "$(psql_q "SELECT coalesce(thumb_url, 'NULL') FROM shop_products WHERE slug = 'thumb-item'")" "NULL"

# 관리 화면은 **편집 원본**을 받아야 한다. 여기서 썸네일을 내려주면 운영자가 저장하는
# 순간 원본 자리에 썸네일이 박히고, 상세의 큰 사진이 400px 로 흐려진다(실제로 그랬다).
printf '{"slug":"trip-item","name":"왕복 상품","price":9000,"stock":5,"status":"selling","image_url":"%s"}' "$MEDIA_URL" > "$TMP/rt.json"
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/rt.json" -o /dev/null
ADMIN_IMG="$(curl -s -b "$CK" "$SHOP/admin/products" | /usr/bin/python3 -c "
import sys, json
for it in json.load(sys.stdin)['items']:
    if it['slug'] == 'trip-item': print(it.get('image_url') or ''); break")"
check "관리 목록은 편집 원본을 준다" "$ADMIN_IMG" "$MEDIA_URL"
# 그 값을 그대로 되돌려 저장한다 — 화면이 하는 일과 같다
RTID="$(psql_q "SELECT id FROM shop_products WHERE slug = 'trip-item'")"
printf '{"slug":"trip-item","name":"왕복 상품","price":9000,"stock":5,"status":"selling","image_url":"%s"}' "$ADMIN_IMG" > "$TMP/rt2.json"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$RTID" -H 'content-type: application/json' --data-binary "@$TMP/rt2.json" -o /dev/null
check "관리 왕복이 대표 사진을 바꾸지 않는다" "$(psql_q "SELECT image_url FROM shop_products WHERE slug = 'trip-item'")" "$MEDIA_URL"
check "왕복 뒤에도 목록용 주소가 남는다" "$(psql_q "SELECT thumb_url FROM shop_products WHERE slug = 'trip-item'")" "$MEDIA_THUMB"

echo "── 스토어프론트 블록"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "상품목록 블록" "$BLOCKS" "brick-shop/product-list"
contains "장바구니 블록" "$BLOCKS" "brick-shop/cart"
# 화면이 없으면 손님이 못 쓰는 기능이다 — 담아둔 상품을 다시 볼 화면
contains "위시리스트 블록" "$BLOCKS" "brick-shop/wishlist"
contains "최근 본 상품 블록" "$BLOCKS" "brick-shop/recent-views"
DETAIL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"smoke-item"}}')"
contains "상품 상세 서버 렌더" "$DETAIL" "스모크 상품"
contains "JSON-LD 구조화 데이터(SEO)" "$DETAIL" "schema.org"
contains "상품명 XSS 이스케이프 준비" "$DETAIL" "brick-product-detail"
contains "후기·문의 탭 렌더" "$DETAIL" "상품후기"
GAL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"opt-item"}}')"
contains "평점 별 표시" "$GAL" "brick-detail-rating"
contains "aggregateRating(SEO)" "$GAL" "AggregateRating"

echo "── 통계"
contains "매출 통계" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "revenue"
contains "재고 부족 알림" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "lowStock"

echo
echo "── 할 일이 답변만 남았을 때 (주문 상태를 통째로 바꾸므로 **맨 끝**에 둔다)"
# 앞 절의 주문을 빌려 쓰지 않고 상태를 바꾸는 검사는 뒷 절을 깨뜨린다 — 두 번 겪었다
psql_q "UPDATE shop_orders SET status = 'delivered' WHERE status IN ('pending','paid','preparing','shipped')" >/dev/null
psql_q "UPDATE shop_reviews SET admin_reply = NULL" >/dev/null
QUEUE_LINK2="$(curl -s -b "$CK" "$API/api/admin/dashboard" | /usr/bin/python3 -c "
import sys, json
for c in json.load(sys.stdin).get('cards', []):
    if c['title'] == '처리 대기': print(c.get('link') or '')")"
contains "주문이 없으면 답변 대기로 보낸다" "$QUEUE_LINK2" "reply=waiting"

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
