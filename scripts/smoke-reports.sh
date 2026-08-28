#!/usr/bin/env bash
#
# 판매 리포트 · 관련 상품 E2E 스모크.
#
# 리포트는 **조용히 틀린다.** 화면에 숫자가 나오면 운영자는 그것을 믿는다.
# 기존 /admin/stats 에 실제로 있던 두 버그를 회귀로 못박는다:
#   - 부분 환불을 빼지 않아 반품한 만큼 매출이 부풀었다
#   - 주문일·UTC 기준이라 한국에서 오전 9시 이전 결제가 전날로 밀렸다
#
# 그리고 정합성:
#   - 상품별 순매출 합 + 배송비 == 주문별 순매출 (안 맞으면 둘 다 못 믿는다)
#   - 미결제 주문은 매출이 아니다
#   - 신청만 한 반품은 차감하지 않는다 (아직 나간 돈이 아니다)
#   - CSV 가 엑셀에서 열리는가 (BOM · 콤마 escape)
#
# 관련 상품은 **추천이 틀리면 손해**라서 걸러야 하는 것을 못박는다:
#   - 반품된 상품을 "함께 구매"로 밀지 않는가
#   - 미결제 주문으로 추천을 만들지 않는가
#   - draft·hidden 상품을 노출하지 않는가 (draft 노출은 정보 유출이다)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-reports.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null; fi
  rm -rf "$TMP"
  return 0
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

echo "▶ 판매 리포트 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-reports-secret-value}"
export BRICK_CAPTCHA=off
# 시간대를 명시한다 — 이 수트의 날짜 경계 검증이 여기에 달려 있다
export BRICK_TIMEZONE="Asia/Seoul"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

CONSENT='"agreements":{"terms":true,"privacy":true},'
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"리포트","adminEmail":"admin@rep.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@rep.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

printf '{"email":"buyer@rep.test","password":"password123",%s"displayName":"구매자"}' "$CONSENT" > "$TMP/reg.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
curl -s -c "$TMP/b.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"buyer@rep.test","password":"password123"}' >/dev/null
B="$TMP/b.txt"

echo "── 안내: 무엇을 매출로 세는지 밝힌다"
META="$(curl -s -b "$CK" "$SHOP/admin/reports")"
contains "시간대를 알려준다" "$META" '"timezone":"Asia/Seoul"'
contains "결제일 기준임을 밝힌다" "$META" "결제일(paid_at) 기준"
contains "순매출 정의를 밝힌다" "$META" "받은 돈 − 완료된 반품의 환불액"
contains "미완료 반품 처리를 밝힌다" "$META" "실제로 나간 돈이 아닙니다"
# 쇼핑몰 플러그인은 비로그인에도 403 을 준다 (기존 관례 — smoke-shop.sh 와 동일)
check "비로그인 접근 불가" "$(code "$SHOP/admin/reports")" "403"
check "일반회원도 불가" "$(code -b "$B" "$SHOP/admin/reports")" "403"

echo "── 파라미터 검증"
check "잘못된 날짜 형식 거부" "$(code -b "$CK" "$SHOP/admin/reports/sales?from=2026-8-1&to=2026-08-31")" "400"
check "존재하지 않는 날짜 거부" "$(code -b "$CK" "$SHOP/admin/reports/sales?from=2026-02-30&to=2026-03-01")" "400"
check "from > to 거부" "$(code -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-31&to=2026-08-01")" "400"
check "잘못된 groupBy 거부" "$(code -b "$CK" "$SHOP/admin/reports/sales?groupBy=hour")" "400"
check "너무 긴 기간 거부" "$(code -b "$CK" "$SHOP/admin/reports/sales?from=2000-01-01&to=2026-12-31")" "400"
contains "기간을 안 주면 최근 30일" "$(curl -s -b "$CK" "$SHOP/admin/reports/sales")" '"groupBy":"day"'

echo "── 준비: 분류 · 상품"
CAT_TOP="$(curl -s -b "$CK" -X POST "$SHOP/admin/categories" -H 'content-type: application/json' \
  -d '{"slug":"clothes","name":"의류"}' | jq_get "['id']")"
printf '{"slug":"tops","name":"상의","parent_id":"%s"}' "$CAT_TOP" > "$TMP/cat.json"
CAT_SUB="$(curl -s -b "$CK" -X POST "$SHOP/admin/categories" -H 'content-type: application/json' \
  --data-binary "@$TMP/cat.json" | jq_get "['id']")"
[[ -n "$CAT_TOP" && -n "$CAT_SUB" ]] && ok "분류 2단 생성" || bad "분류 2단 생성"

# 상품 등록 화면이 분류를 고를 수 있어야 한다.
# 이 선택지 라우트가 없어서 **분류를 만들어도 상품에 지정할 방법이 없었다.**
FIELDS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products")"
contains "상품 폼에 분류 필드가 있다" "$FIELDS" '"name":"category_id"'
contains "선택지를 라우트에서 가져온다" "$FIELDS" '"optionsFrom":"/admin/options/categories"'
OPTS="$(curl -s -b "$CK" "$SHOP/admin/options/categories")"
contains "최상위 분류" "$OPTS" '"label":"의류"'
# NBSP 로 들여쓴다 — HTML <option> 안에서 보통 공백은 접혀서 사라진다
INDENTED="$(python3 -c "
import json, sys
opts = json.loads(sys.stdin.read())
print(any(o['label'].startswith('\u00a0') and '상의' in o['label'] for o in opts))" <<< "$OPTS")"
check "하위는 NBSP 로 들여쓴다 (계층을 알 수 있게)" "$INDENTED" "True"
check "선택지도 관리자만" "$(code "$SHOP/admin/options/categories")" "403"
CFIELDS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/categories")"
contains "분류 폼에 상위 분류 필드" "$CFIELDS" '"name":"parent_id"'
check "없는 상위 분류는 400 (FK 500 아니라)" \
  "$(code -b "$CK" -X POST "$SHOP/admin/categories" -H 'content-type: application/json' \
      -d '{"slug":"orphan","name":"고아","parent_id":"00000000-0000-0000-0000-000000000000"}')" "400"
check "상위 분류가 uuid 가 아니면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/categories" -H 'content-type: application/json' \
      -d '{"slug":"bad","name":"나쁨","parent_id":"not-a-uuid"}')" "400"
printf '{"slug":"clothes","name":"의류","parent_id":"%s"}' "$CAT_SUB" > "$TMP/cyc.json"
check "자기 자손을 상위로 지정하면 400 (재귀 쿼리가 멈춘다)" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/categories/$CAT_TOP" -H 'content-type: application/json' \
      --data-binary "@$TMP/cyc.json")" "400"
printf '{"slug":"clothes","name":"의류","parent_id":"%s"}' "$CAT_TOP" > "$TMP/self.json"
check "자기 자신을 상위로 지정하면 400" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/categories/$CAT_TOP" -H 'content-type: application/json' \
      --data-binary "@$TMP/self.json")" "400"

# 상품명에 콤마와 따옴표를 넣는다 — CSV escape 검증에 쓴다
printf '{"slug":"shirt","name":"셔츠, \\"기본\\" 화이트","price":10000,"stock":100,"status":"selling","category_id":"%s"}' "$CAT_SUB" > "$TMP/p1.json"
P1="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/p1.json" | jq_get "['id']")"
P2="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"cap","name":"모자","price":5000,"stock":100,"status":"selling"}' | jq_get "['id']")"
[[ -n "$P1" && -n "$P2" ]] && ok "상품 등록 (분류 있음 · 없음)" || bad "상품 등록"

mkorder() {  # mkorder <상품id> <수량> [쿠폰] → orderNo
  local extra=""
  [[ -n "${3:-}" ]] && extra=",\"couponCode\":\"$3\""
  printf '{"items":[{"productId":"%s","quantity":%s}]%s,"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' \
    "$1" "$2" "$extra" > "$TMP/mk.json"
  curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json" | jq_get "['orderNo']"
}

echo "── 미결제 주문은 매출이 아니다"
UNPAID="$(mkorder "$P1" 1)"
[[ -n "$UNPAID" ]] && ok "미결제 주문 생성 ($UNPAID)" || bad "미결제 주문 생성"
# to_char 로 뽑는다 — pg 드라이버는 date 를 **JS Date 객체로 바꾸므로**
# 그냥 SELECT 하면 "Fri Aug 28 2026 ... (Korean Standard Time)" 이 돌아온다
TODAY="$(psql_q "SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')")"
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
contains "미결제는 주문수 0" "$R" '"orders":0'
contains "미결제는 순매출 0" "$R" '"net":0'

echo "── 결제한 주문이 매출에 잡힌다"
# 10,000 + 배송비 3,000 = 13,000
PAID1="$(mkorder "$P1" 1)"
psql_q "UPDATE shop_orders SET payment_status='paid', paid_at = (('$TODAY'::date)::timestamp + interval '14 hours') AT TIME ZONE 'Asia/Seoul', status='paid' WHERE order_no='$PAID1'" >/dev/null
AMT="$(psql_q "SELECT subtotal, shipping_fee, total FROM shop_orders WHERE order_no='$PAID1'")"
check "금액 (10000+3000)" "$AMT" "10000|3000|13000"
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
contains "주문수 1" "$R" '"orders":1'
contains "순매출 13000" "$R" '"net":13000'
contains "배송비를 따로 보여준다" "$R" '"shipping":3000'
contains "평균 주문금액" "$R" '"avgOrderValue":13000'

echo "── 회귀: 부분 반품을 빼야 한다 (기존 stats 의 버그)"
# 10,000 × 2 + 배송비 3,000 = 23,000. 1개 반품 → 10,000 환불 → 13,000
PAID2="$(mkorder "$P1" 2)"
psql_q "UPDATE shop_orders SET payment_status='paid', paid_at = (('$TODAY'::date)::timestamp + interval '15 hours') AT TIME ZONE 'Asia/Seoul', status='delivered', delivered_at=now() WHERE order_no='$PAID2'" >/dev/null
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
contains "반품 전 순매출 36000 (13000+23000)" "$R" '"net":36000'

ITEM2="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$PAID2'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM2" > "$TMP/ret.json"
RID="$(curl -s -b "$B" -X POST "$SHOP/orders/$PAID2/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret.json" | jq_get "['id']")"
[[ -n "$RID" ]] && ok "반품 신청" || bad "반품 신청"

R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
contains "신청만 한 반품은 차감하지 않는다 (아직 안 나간 돈)" "$R" '"net":36000'
contains "환불액도 0" "$R" '"refunded":0'

# 승인 → 수거 → 입고 → 완료
for st in approved picked_up received completed; do
  psql_q "SELECT 1" >/dev/null
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\"}" >/dev/null
done
RSTATUS="$(psql_q "SELECT status, refund_amount FROM shop_returns WHERE id='$RID'")"
check "반품 완료 · 환불 10000" "$RSTATUS" "completed|10000"

R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
contains "완료된 반품을 차감 → 26000" "$R" '"net":26000'
contains "환불액 10000 표시" "$R" '"refunded":10000'
# 주문 상태는 delivered 그대로다 (부분 반품이므로) — 상태로 걸렀으면 36000이 나온다
OSTATUS="$(psql_q "SELECT status FROM shop_orders WHERE order_no='$PAID2'")"
check "부분 반품이므로 주문 상태는 그대로" "$OSTATUS" "delivered"
STATS="$(curl -s -b "$CK" "$SHOP/admin/stats")"
contains "/admin/stats 도 환불을 뺀다" "$STATS" '"revenue":"26000"'

echo "── 회귀: 시간대 — KST 오전 8시 결제는 그날이다 (UTC면 전날)"
# 2026-08-10 08:00 KST = 2026-08-09 23:00 UTC
EARLY="$(mkorder "$P2" 1)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at='2026-08-09 23:00:00+00' WHERE order_no='$EARLY'" >/dev/null
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-10&to=2026-08-10")"
contains "8월 10일로 잡힌다" "$R" '"bucket":"2026-08-10"'
contains "10일 주문수 1" "$R" '"orders":1'
R9="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-09&to=2026-08-09")"
check "9일에는 없다 (UTC로 잘랐으면 여기 있다)" "$(echo "$R9" | jq_get "['buckets']")" "[]"

# 자정 직전: 2026-08-10 23:30 KST = 14:30 UTC → 여전히 10일
LATE="$(mkorder "$P2" 1)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at='2026-08-10 14:30:00+00' WHERE order_no='$LATE'" >/dev/null
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-10&to=2026-08-10")"
contains "자정 직전도 같은 날 (주문 2건)" "$R" '"orders":2'
# 자정 직후: 2026-08-11 00:30 KST = 2026-08-10 15:30 UTC → 11일
NEXT="$(mkorder "$P2" 1)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at='2026-08-10 15:30:00+00' WHERE order_no='$NEXT'" >/dev/null
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-10&to=2026-08-10")"
contains "자정을 넘기면 빠진다 (여전히 2건)" "$R" '"orders":2'
R11="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-11&to=2026-08-11")"
contains "11일에 1건" "$R11" '"orders":1'

echo "── to 는 그날 끝까지 포함한다"
R="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-09&to=2026-08-11")"
check "3일 구간에 버킷 2개 (10일·11일)" "$(python3 -c "
import json,sys
print(len(json.load(sys.stdin)['buckets']))" <<< "$R")" "2"
contains "마지막 날이 빠지지 않았다" "$R" '"bucket":"2026-08-11"'

echo "── 주·월 묶음"
RW="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-01&to=2026-08-31&groupBy=week")"
contains "주 단위" "$RW" '"groupBy":"week"'
RM="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-08-01&to=2026-08-31&groupBy=month")"
contains "월 단위 버킷 하나" "$RM" '"bucket":"2026-08-01"'
# 8월엔 시간대 검증용 주문 3건 + 오늘(8월) 주문 2건 = 5건
check "8월 주문 5건이 한 버킷에" "$(echo "$RM" | jq_get "['buckets'][0]['orders']")" "5"

echo "── 상품별"
PR="$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=$TODAY&to=$TODAY")"
contains "셔츠 (콤마·따옴표 포함 이름)" "$PR" '셔츠, \"기본\" 화이트'
contains "판매수량 2 (3개 중 1개 반품)" "$PR" '"qty":2'
contains "취소수량 1" "$PR" '"cancelledQty":1'
contains "분류명 표시" "$PR" '"categoryName":"상의"'
contains "환불 반영" "$PR" '"refunded":10000'
# 셔츠: 주문1(10000) + 주문2(20000) − 환불 10000 = 20000 (할인 없음)
check "셔츠 순매출 20000" "$(echo "$PR" | jq_get "['products'][0]['net']")" "20000"
check "정렬 기준 기본은 순매출" "$(echo "$PR" | jq_get "['sort']")" "net"
PR_Q="$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=$TODAY&to=$TODAY&sort=qty")"
contains "수량 정렬" "$PR_Q" '"sort":"qty"'
check "limit 적용" "$(python3 -c "
import json,sys
print(len(json.load(sys.stdin)['products']))" <<< "$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=2026-08-01&to=2026-08-31&limit=1")")" "1"

echo "── 정합성: 상품별 합 + 배송비 == 주문별 순매출"
# 이것이 안 맞으면 운영자는 두 리포트를 다 못 믿는다
python3 - "$SHOP" "$CK" "$TODAY" <<'PY' > "$TMP/recon.txt"
import json, subprocess, sys
shop, ck, today = sys.argv[1], sys.argv[2], sys.argv[3]
def get(path):
    out = subprocess.run(["curl", "-s", "-b", ck, f"{shop}{path}"], capture_output=True, text=True).stdout
    return json.loads(out)
sales = get(f"/admin/reports/sales?from=2026-01-01&to=2026-12-31&groupBy=month")
prods = get(f"/admin/reports/products?from=2026-01-01&to=2026-12-31&limit=500")
order_net = sales["total"]["net"]
shipping = sales["total"]["shipping"]
# 배송비도 환불될 수 있다. 완료된 반품 중 전체취소가 없으므로 이 수트에서는 그대로.
product_net = sum(p["net"] for p in prods["products"])
print(f"order_net={order_net} shipping={shipping} product_net={product_net} diff={order_net - shipping - product_net}")
PY
RECON="$(cat "$TMP/recon.txt")"
echo "    $RECON"
check "차이 0 (상품별 합 + 배송비 = 주문 순매출)" \
  "$(echo "$RECON" | sed -n 's/.*diff=\(-*[0-9]*\).*/\1/p')" "0"

echo "── 할인이 있어도 정합성이 유지된다"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"rep3000","name":"3천원","discount_type":"fixed","discount_value":3000}' >/dev/null
# 10,000 × 2 = 20,000 − 3,000 = 17,000 + 3,000 배송 = 20,000
DISC="$(mkorder "$P1" 2 rep3000)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at='2026-09-15 05:00:00+00' WHERE order_no='$DISC'" >/dev/null
DAMT="$(psql_q "SELECT subtotal, discount, total FROM shop_orders WHERE order_no='$DISC'")"
check "할인 주문 금액" "$DAMT" "20000|3000|20000"
RD="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-09-15&to=2026-09-15")"
contains "할인이 집계된다" "$RD" '"discount":3000'
contains "순매출은 받은 돈 20000" "$RD" '"net":20000'
PD="$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=2026-09-15&to=2026-09-15")"
# 상품 순매출 = 20,000 − 안분할인 3,000 = 17,000 (배송비 3,000은 주문 쪽)
check "상품 순매출은 할인 뺀 17000" "$(echo "$PD" | jq_get "['products'][0]['net']")" "17000"
check "안분 할인 표시" "$(echo "$PD" | jq_get "['products'][0]['discount']")" "3000"

echo "── 분류별"
CR="$(curl -s -b "$CK" "$SHOP/admin/reports/categories?from=2026-01-01&to=2026-12-31")"
contains "말단 분류로 집계" "$CR" '"categoryName":"상의"'
contains "분류 없는 상품도 버리지 않는다" "$CR" '"categoryName":"(분류 없음)"'
CRU="$(curl -s -b "$CK" "$SHOP/admin/reports/categories?from=2026-01-01&to=2026-12-31&rollup=true")"
contains "최상위로 합침" "$CRU" '"categoryName":"의류"'
absent "롤업하면 하위 분류는 안 나온다" "$CRU" '"categoryName":"상의"'
# 롤업 전후 합계가 같아야 한다
SUM_FLAT="$(python3 -c "
import json,sys; print(sum(c['net'] for c in json.load(sys.stdin)['categories']))" <<< "$CR")"
SUM_ROLL="$(python3 -c "
import json,sys; print(sum(c['net'] for c in json.load(sys.stdin)['categories']))" <<< "$CRU")"
check "롤업해도 합계는 같다" "$SUM_FLAT" "$SUM_ROLL"

echo "── 요약 (직전 동일 기간 대비)"
SM="$(curl -s -b "$CK" "$SHOP/admin/reports/summary?from=2026-09-01&to=2026-09-30")"
contains "당월" "$SM" '"current"'
contains "직전 기간을 함께 준다" "$SM" '"previous"'
PREV_FROM="$(echo "$SM" | jq_get "['previous']['period']['from']")"
PREV_TO="$(echo "$SM" | jq_get "['previous']['period']['to']")"
check "직전 기간이 같은 길이 (8/2~8/31)" "$PREV_FROM|$PREV_TO" "2026-08-02|2026-08-31"
contains "구매자 수" "$SM" '"buyers"'
# 8월엔 매출이 있고 9월에도 있으므로 증감률이 나온다
CHG="$(echo "$SM" | jq_get "['change']['net']")"
[[ "$CHG" != "None" && -n "$CHG" ]] && ok "증감률 계산 ($CHG%)" || bad "증감률 계산"
# 직전 기간이 0이면 비율을 만들지 않는다
SM0="$(curl -s -b "$CK" "$SHOP/admin/reports/summary?from=2026-11-01&to=2026-11-30")"
check "직전이 0이면 증감률은 null (100%도 무한도 거짓)" "$(echo "$SM0" | jq_get "['change']['net']")" "None"
check "그때 당월 순매출은 0" "$(echo "$SM0" | jq_get "['current']['net']")" "0"

echo "── CSV (운영자는 결국 엑셀에서 본다)"
curl -s -b "$CK" -D "$TMP/h.txt" "$SHOP/admin/reports/products?from=2026-01-01&to=2026-12-31&format=csv" -o "$TMP/p.csv"
contains "CSV content-type" "$(cat "$TMP/h.txt")" "text/csv"
contains "첨부 파일명" "$(cat "$TMP/h.txt")" 'attachment; filename="products-2026-01-01_2026-12-31.csv"'
# BOM 없으면 엑셀이 한글을 깨뜨린다
BOM="$(head -c 3 "$TMP/p.csv" | od -An -tx1 | tr -d ' \n')"
check "BOM 으로 시작 (엑셀 한글)" "$BOM" "efbbbf"
contains "헤더 한글" "$(cat "$TMP/p.csv")" "상품명"
# 콤마·따옴표가 든 상품명이 필드를 깨지 않는다
contains "따옴표 escape (\"\" 로)" "$(cat "$TMP/p.csv")" '"셔츠, ""기본"" 화이트"'
CSV_COLS="$(python3 -c "
import csv, io
rows = list(csv.reader(io.open('$TMP/p.csv', encoding='utf-8-sig')))
print(len(set(len(r) for r in rows)), len(rows[0]))
")"
check "모든 행의 열 수가 같다 (escape 성공)" "$CSV_COLS" "1 9"
CSV_NAME="$(python3 -c "
import csv, io
rows = list(csv.reader(io.open('$TMP/p.csv', encoding='utf-8-sig')))
print(rows[1][0])
")"
check "파싱하면 원래 상품명" "$CSV_NAME" '셔츠, "기본" 화이트'
curl -s -b "$CK" "$SHOP/admin/reports/sales?from=2026-01-01&to=2026-12-31&format=csv" -o "$TMP/s.csv"
contains "기간별 CSV" "$(cat "$TMP/s.csv")" "순매출"
curl -s -b "$CK" "$SHOP/admin/reports/categories?from=2026-01-01&to=2026-12-31&format=csv" -o "$TMP/c.csv"
contains "분류별 CSV" "$(cat "$TMP/c.csv")" "분류"
check "CSV 도 관리자만" "$(code "$SHOP/admin/reports/products?format=csv")" "403"

echo "── 삭제된 상품의 판매도 남는다"
psql_q "DELETE FROM shop_products WHERE id='$P2'" >/dev/null
PRD="$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=2026-08-01&to=2026-08-31")"
contains "주문 시점 상품명이 남는다" "$PRD" '"productName":"모자"'
CAP_ID="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(p for p in d['products'] if p['productName'] == '모자')
print(row['productId'])" <<< "$PRD")"
check "상품 id 는 끊긴다 (매출은 남는다)" "$CAP_ID" "None"
CAP_QTY="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(p for p in d['products'] if p['productName'] == '모자')
print(row['qty'])" <<< "$PRD")"
check "삭제해도 판매수량은 남는다" "$CAP_QTY" "3"

echo "══ 관련 상품 · 함께 구매 ══"

echo "── 폼에서 slug 로 지정한다"
RFIELDS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products")"
contains "관련 상품 필드" "$RFIELDS" '"name":"related_text"'
contains "비우면 자동임을 알려준다" "$RFIELDS" "함께 구매한 상품이 자동으로"

# 추천용 상품을 더 만든다
P3="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling"}' | jq_get "['id']")"
P4="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"socks","name":"양말","price":3000,"stock":50,"status":"selling"}' | jq_get "['id']")"
# 아직 안 파는 상품 · 내린 상품 — 추천에 나오면 안 된다
P_DRAFT="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"secret","name":"미공개 신상품","price":99000,"stock":10,"status":"draft"}' | jq_get "['id']")"
P_HIDDEN="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"retired","name":"단종 상품","price":1000,"stock":10,"status":"hidden"}' | jq_get "['id']")"
[[ -n "$P3" && -n "$P4" && -n "$P_DRAFT" && -n "$P_HIDDEN" ]] && ok "추천용 상품 준비" || bad "추천용 상품 준비"

echo "── 수동 지정"
check "없는 slug 는 400 으로 알려준다 (조용히 버리면 오타를 못 찾는다)" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
      -d '{"slug":"belt","name":"벨트","price":8000,"status":"selling","related_text":"no-such-slug"}')" "400"
contains "어떤 slug 가 없는지 말해준다" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
      -d '{"slug":"belt","name":"벨트","price":8000,"status":"selling","related_text":"no-such-slug"}')" \
  "no-such-slug"
check "자기 자신은 400" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
      -d '{"slug":"belt","name":"벨트","price":8000,"status":"selling","related_text":"belt"}')" "400"

curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
  -d '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling","related_text":"socks\nshirt"}' >/dev/null
REL_ROWS="$(psql_q "SELECT count(*) FROM shop_related_products WHERE product_id='$P3'")"
check "2개 저장됨" "$REL_ROWS" "2"
DETAIL="$(curl -s "$SHOP/products/belt")"
contains "상세 응답에 관련 상품" "$DETAIL" '"source":"manual"'
contains "지정한 순서대로 (양말 먼저)" "$DETAIL" '"slug":"socks"'
REL_ORDER="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(','.join(r['slug'] for r in d['related']))" <<< "$DETAIL")"
check "입력한 순서 유지" "$REL_ORDER" "socks,shirt"

echo "── 상품을 수정해도 관련 상품이 날아가지 않는다"
# 폼이 기존 값을 되돌려 받지 못하면, 수정 저장 한 번에 지워진다
LIST="$(curl -s -b "$CK" "$SHOP/admin/products")"
BELT_TEXT="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(p for p in d['items'] if p['slug'] == 'belt')
print(row['related_text'].replace(chr(10), ','))" <<< "$LIST")"
check "폼에 기존 값이 채워진다" "$BELT_TEXT" "socks,shirt"

echo "── 중복 · 비우기"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
  -d '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling","related_text":"socks\nsocks\nshirt"}' >/dev/null
check "같은 slug 두 번은 한 번으로" "$(psql_q "SELECT count(*) FROM shop_related_products WHERE product_id='$P3'")" "2"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
  -d '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling","related_text":""}' >/dev/null
check "비우면 지워진다" "$(psql_q "SELECT count(*) FROM shop_related_products WHERE product_id='$P3'")" "0"

echo "── draft·hidden 은 추천하지 않는다 (미공개 노출은 정보 유출)"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
  -d '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling","related_text":"secret\nretired\nsocks"}' >/dev/null
check "지정 자체는 된다 (나중에 판매 시작할 수 있다)" "$(psql_q "SELECT count(*) FROM shop_related_products WHERE product_id='$P3'")" "3"
DETAIL="$(curl -s "$SHOP/products/belt")"
absent "미공개 상품은 화면에 안 나온다" "$DETAIL" "미공개 신상품"
absent "단종 상품도 안 나온다" "$DETAIL" "단종 상품"
contains "파는 상품만 나온다" "$DETAIL" '"slug":"socks"'

echo "── 함께 구매: 수동 지정이 없을 때 자동으로 채운다"
# 양말+벨트를 한 주문에 담아 결제한다
printf '{"items":[{"productId":"%s","quantity":1},{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P4" "$P3" > "$TMP/co.json"
CO1="$(curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/co.json" | jq_get "['orderNo']")"
[[ -n "$CO1" ]] && ok "함께 담은 주문 생성" || bad "함께 담은 주문 생성"

# 아직 미결제 — 추천이 만들어지면 안 된다
D4="$(curl -s "$SHOP/products/socks")"
check "미결제 주문으로는 추천하지 않는다" "$(python3 -c "
import json, sys; print(len(json.load(sys.stdin)['related']))" <<< "$D4")" "0"

psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at=now() WHERE order_no='$CO1'" >/dev/null
D4="$(curl -s "$SHOP/products/socks")"
contains "결제되면 함께 구매로 나온다" "$D4" '"source":"copurchase"'
contains "함께 산 상품이 벨트" "$D4" '"slug":"belt"'
check "자기 자신은 제외" "$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print('socks' in [r['slug'] for r in d['related']])" <<< "$D4")" "False"

echo "── 반품된 상품은 함께 구매로 밀지 않는다"
# 셔츠+양말 주문을 결제하고 셔츠를 반품한다
printf '{"items":[{"productId":"%s","quantity":1},{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P4" "$P1" > "$TMP/co2.json"
CO2="$(curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/co2.json" | jq_get "['orderNo']")"
psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$CO2'" >/dev/null
D4="$(curl -s "$SHOP/products/socks")"
contains "반품 전에는 셔츠가 나온다" "$D4" '"slug":"shirt"'

SHIRT_ITEM="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$CO2' AND oi.product_id='$P1'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$SHIRT_ITEM" > "$TMP/ret2.json"
RID2="$(curl -s -b "$B" -X POST "$SHOP/orders/$CO2/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret2.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID2" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\"}" >/dev/null
done
check "반품 완료" "$(psql_q "SELECT status FROM shop_returns WHERE id='$RID2'")" "completed"
D4="$(curl -s "$SHOP/products/socks")"
absent "반품된 셔츠는 더 이상 추천하지 않는다" "$D4" '"slug":"shirt"'
contains "벨트는 그대로 (반품 안 했다)" "$D4" '"slug":"belt"'

echo "── 수동 지정이 함께 구매보다 앞선다"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P4" -H 'content-type: application/json' \
  -d '{"slug":"socks","name":"양말","price":3000,"stock":50,"status":"selling","related_text":"shirt"}' >/dev/null
D4="$(curl -s "$SHOP/products/socks")"
FIRST="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['related'][0]['slug'], d['related'][0]['source'])" <<< "$D4")"
check "수동 지정이 첫 자리" "$FIRST" "shirt manual"
contains "남는 자리는 함께 구매로 채운다" "$D4" '"source":"copurchase"'
DUP="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
slugs = [r['slug'] for r in d['related']]
print(len(slugs) == len(set(slugs)))" <<< "$D4")"
check "중복 없이 채운다" "$DUP" "True"

echo "── 블록 렌더 (테마가 실제로 받는 HTML)"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "독립 블록 등록" "$BLOCKS" '"name":"brick-shop/related-products"'
contains "상세 블록도 있다" "$BLOCKS" '"name":"brick-shop/product-detail"'

# 상품 상세 블록 — 관련 상품이 함께 렌더되어야 한다
DET_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"socks"}}')"
contains "상세 블록에 관련 상품 섹션" "$DET_HTML" 'brick-related'
contains "섹션 제목" "$DET_HTML" "관련 상품"
absent "미공개 상품이 HTML 에 새지 않는다" "$DET_HTML" "미공개 신상품"
absent "단종 상품도 안 새어 나간다" "$DET_HTML" "단종 상품"

# 독립 블록
REL_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/related-products","props":{"slug":"socks","title":"이런 상품은 어떠세요"}}')"
contains "제목을 바꿀 수 있다" "$REL_HTML" "이런 상품은 어떠세요"
contains "상품 카드가 링크다" "$REL_HTML" '/shop/shirt'
check "없는 상품이면 빈 문자열" \
  "$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
      -d '{"name":"brick-shop/related-products","props":{"slug":"no-such-product"}}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('html', d) if isinstance(d, dict) else d))")" "0"

echo "── 추천이 없으면 아무것도 내지 않는다"
# 아무 관련도 없는 상품 (주문도 지정도 없다)
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"lonely","name":"외로운 상품","price":1000,"stock":5,"status":"selling"}' >/dev/null
LONELY="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"lonely"}}')"
contains "상세는 정상 렌더" "$LONELY" "외로운 상품"
has_section() {  # HTML 을 파싱해 <section class="brick-related"> 유무를 본다.
  # 클래스명 문자열만 찾으면 안 된다 — 블록이 함께 내는 CSS 에 규칙이 들어 있다.
  python3 -c "
import json, sys
d = json.load(sys.stdin)
html = d['html'] if isinstance(d, dict) and 'html' in d else str(d)
print('<section class=\"brick-related\">' in html)"
}
check "빈 섹션을 만들지 않는다" "$(has_section <<< "$LONELY")" "False"
check "추천이 있으면 섹션이 있다 (검증이 헛돌지 않는다)" "$(has_section <<< "$DET_HTML")" "True"
absent "빈 안내 문구도 없다" "$LONELY" "관련 상품이 없습니다"

echo "── 지정 개수 상한"
LONG="$(python3 -c "print('\\n'.join('x%d' % i for i in range(60)))")"
printf '{"slug":"belt","name":"벨트","price":8000,"stock":50,"status":"selling","related_text":"%s"}' "$LONG" > "$TMP/many.json"
check "50개 초과는 400" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/products/$P3" -H 'content-type: application/json' \
      --data-binary "@$TMP/many.json")" "400"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
