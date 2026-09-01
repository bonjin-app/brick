#!/usr/bin/env bash
#
# 취소 · 반품 · 교환 E2E 스모크.
#
# 이 영역은 틀리면 **돈이 새거나 법을 위반한다.** 못박는 것:
#   - 부분 반품에서 할인이 안분되는가 (10,000×2에 2,000쿠폰 → 하나 반품 시 9,000)
#   - 재고가 정확히 그만큼만 복원되는가 (이중 복원이 없는가)
#   - 물건을 받기 전에 환불되지 않는가 (입고 전 완료 차단)
#   - 청약철회 7일이 지난 뒤 단순변심이 막히고 불량은 열려 있는가
#   - 불량·오배송의 반송비를 고객에게 청구하지 않는가 (위법)
#   - 남의 주문을 반품 신청할 수 없는가
#   - 동시 신청에서 주문 수량을 넘기지 못하는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-returns.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
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

echo "▶ 취소·반품·교환 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-returns-secret-value}"
export BRICK_CAPTCHA=off

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
    -d '{"siteName":"반품","adminEmail":"admin@ret.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@ret.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-point; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done

# 구매자 둘 — 남의 주문을 건드릴 수 없어야 한다
for n in 1 2; do
  printf '{"email":"b%s@ret.test","password":"password123",%s"displayName":"구매자%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"b%s@ret.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/b$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
B1="$TMP/b1.txt"; B2="$TMP/b2.txt"

echo "── 관리자 리소스 · 사유 목록"
contains "반품 리소스 등록" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"name":"returns"'
REASONS="$(curl -s "$SHOP/returns/reasons")"
contains "단순변심은 고객 부담" "$REASONS" '"code":"change_of_mind","label":"단순 변심","shippingPayer":"customer"'
contains "불량은 사업자 부담" "$REASONS" '"code":"defect","label":"상품 불량","shippingPayer":"seller"'
contains "오배송은 사업자 부담" "$REASONS" '"code":"wrong_item","label":"오배송","shippingPayer":"seller"'
contains "종류 목록" "$REASONS" '"code":"exchange","label":"교환"'

echo "── 준비: 상품과 주문"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"ret-item","name":"반품테스트 상품","price":10000,"stock":100,"status":"selling"}' | jq_get "['id']")"
PID2="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"ret-item2","name":"두번째 상품","price":5000,"stock":100,"status":"selling","options_text":"빨강|0|50\n파랑|0|50"}' | jq_get "['id']")"
[[ -n "$PID" && -n "$PID2" ]] && ok "상품 등록" || bad "상품 등록"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"ret2000","name":"2천원","discount_type":"fixed","discount_value":2000}' >/dev/null

# 10,000 × 2 = 20,000 − 쿠폰 2,000 = 18,000 + 배송비 0(5만 미만이지만 3,000) = 21,000
printf '{"items":[{"productId":"%s","quantity":2}],"couponCode":"ret2000","orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o1.json"
ORDER1="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o1.json")"
NO1="$(echo "$ORDER1" | jq_get "['orderNo']")"
[[ -n "$NO1" ]] && ok "주문 생성 ($NO1)" || bad "주문 생성"
AMT="$(psql_q "SELECT subtotal, discount, shipping_fee, total FROM shop_orders WHERE order_no='$NO1'")"
check "금액 확인 (20000-2000+3000=21000)" "$AMT" "20000|2000|3000|21000"
STOCK_BEFORE="$(psql_q "SELECT stock, sold_count FROM shop_products WHERE id='$PID'")"
check "주문 후 재고 98, 판매 2" "$STOCK_BEFORE" "98|2"

echo "── 신청 자격 (주문 상태에 따라 달라진다)"
RA="$(curl -s -b "$B1" "$SHOP/orders/$NO1/returnable")"
contains "입금대기에는 취소만" "$RA" '"allowedKinds":[{"code":"cancel","label":"취소"}]'
contains "신청 가능 수량 2" "$RA" '"availableQty":2'
contains "배송 전이므로 기한 없음" "$RA" '"withdrawalDeadline":null'
contains "반품 배송비 안내" "$RA" '"returnShippingFee":3000'
check "남의 주문은 404 (403이면 존재가 새어 나간다)" "$(code -b "$B2" "$SHOP/orders/$NO1/returnable")" "404"
check "비로그인도 404" "$(code "$SHOP/orders/$NO1/returnable")" "404"

echo "── 비회원도 청약철회할 수 있다 (회원 여부와 무관한 법적 권리)"
# 전자상거래법 제17조의 청약철회권은 비회원 구매자에게도 있다. 주문했던
# 기기의 guestToken 으로만 열린다 — 주문번호는 순차적이라 번호만으로
# 열리면 남의 주문을 철회할 수 있다.
# 재고 검증이 추적하는 상품과 섞이지 않게 **전용 상품**을 쓴다 —
# 같은 상품을 쓰면 이 주문이 뒤따르는 재고 기대치를 어긋나게 한다
PID_G="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"ret-guest","name":"비회원 청약철회 상품","price":10000,"stock":50,"status":"selling"}' | jq_get "['id']")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"비회원","ordererPhone":"010-0000-1111","postcode":"06236","address1":"서울"}}' "$PID_G" > "$TMP/gorder.json"
GORDER="$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/gorder.json")"
GNO="$(echo "$GORDER" | jq_get "['orderNo']")"
GTOKEN="$(echo "$GORDER" | jq_get "['guestToken']")"
[[ -n "$GNO" && -n "$GTOKEN" ]] && ok "비회원 주문 생성" || bad "비회원 주문 생성"
contains "토큰으로 신청 자격 조회" \
  "$(curl -s "$SHOP/orders/$GNO/returnable?token=$GTOKEN")" '"allowedKinds"'
check "토큰 없으면 404" "$(code "$SHOP/orders/$GNO/returnable")" "404"
check "틀린 토큰도 404" "$(code "$SHOP/orders/$GNO/returnable?token=nope")" "404"
GITEM="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$GNO'")"
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$GITEM" > "$TMP/greq.json"
contains "비회원이 실제로 신청한다" \
  "$(curl -s -X POST "$SHOP/orders/$GNO/returns?token=$GTOKEN" -H 'content-type: application/json' --data-binary "@$TMP/greq.json")" '"returnNo"'
check "토큰 없는 신청은 404" \
  "$(code -X POST "$SHOP/orders/$GNO/returns" -H 'content-type: application/json' --data-binary "@$TMP/greq.json")" "404"

echo "── 부분 취소: 할인 안분 (돈이 걸린 계산)"
ITEM1="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$NO1'")"
# 2개 중 1개만 취소 → 실제로 받은 돈 18,000 중 절반 = 9,000 (10,000이 아니다)
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM1" > "$TMP/req1.json"
REQ1="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO1/returns" -H 'content-type: application/json' --data-binary "@$TMP/req1.json")"
RID1="$(echo "$REQ1" | jq_get "['id']")"
RNO1="$(echo "$REQ1" | jq_get "['returnNo']")"
[[ -n "$RID1" ]] && ok "부분 취소 신청 ($RNO1)" || bad "부분 취소 신청"
contains "할인 안분: 10000이 아니라 9000" "$REQ1" '"refundAmount":9000'
contains "취소는 배송비 부담 없음" "$REQ1" '"shippingPayer":"customer"'

echo "── 물건을 받기 전에 환불되지 않는다"
check "requested → received 는 불가" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
      -d '{"status":"received"}')" "400"
contains "왜 안 되는지 알려준다" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
      -d '{"status":"received"}')" "바꿀 수 없습니다"
check "거부는 사유 없이 불가" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
      -d '{"status":"rejected"}')" "400"
check "비관리자는 상태 변경 불가" \
  "$(code -b "$B1" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
      -d '{"status":"approved"}')" "403"

echo "── 부분 취소 완료: 재고가 정확히 1개만 복원"
contains "승인" "$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
  -d '{"status":"approved"}')" '"status":"approved"'
DONE1="$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID1" -H 'content-type: application/json' \
  -d '{"status":"completed"}')"
contains "완료" "$DONE1" '"status":"completed"'
contains "재고 1개 복원" "$DONE1" '"stockRestored":1'
STOCK_AFTER="$(psql_q "SELECT stock, sold_count FROM shop_products WHERE id='$PID'")"
check "재고 99, 판매 1 (2개 전부가 아니라 1개만)" "$STOCK_AFTER" "99|1"
CQ="$(psql_q "SELECT cancelled_qty, refunded_amount FROM shop_order_items WHERE id='$ITEM1'")"
check "취소 수량·환불액 누적" "$CQ" "1|9000"
ORDER_STATUS="$(psql_q "SELECT status, has_returns FROM shop_orders WHERE order_no='$NO1'")"
check "부분이므로 주문 상태는 그대로 (남은 상품이 배송된다)" "$ORDER_STATUS" "pending|true"

echo "── 남은 수량만 다시 신청할 수 있다"
RA2="$(curl -s -b "$B1" "$SHOP/orders/$NO1/returnable")"
contains "남은 수량 1" "$RA2" '"availableQty":1'
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":2}]}' "$ITEM1" > "$TMP/over.json"
check "남은 수량 초과 신청 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO1/returns" -H 'content-type: application/json' --data-binary "@$TMP/over.json")" "400"
contains "몇 개까지 되는지 알려준다" \
  "$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO1/returns" -H 'content-type: application/json' --data-binary "@$TMP/over.json")" "1개까지만"

echo "── 전체 취소: 배송비까지 환불 + 주문 상태 전환"
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM1" > "$TMP/rest.json"
REQ2="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO1/returns" -H 'content-type: application/json' --data-binary "@$TMP/rest.json")"
RID2="$(echo "$REQ2" | jq_get "['id']")"
contains "남은 전량 취소 = 배송비 포함 (9000+3000)" "$REQ2" '"refundAmount":12000'
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID2" -H 'content-type: application/json' -d '{"status":"approved"}' >/dev/null
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID2" -H 'content-type: application/json' -d '{"status":"completed"}' >/dev/null
FINAL="$(psql_q "SELECT status FROM shop_orders WHERE order_no='$NO1'")"
check "전량 취소되면 주문도 취소 상태" "$FINAL" "cancelled"
STOCK_FULL="$(psql_q "SELECT stock, sold_count FROM shop_products WHERE id='$PID'")"
check "재고 완전 복원 (100, 0) — 이중 복원 없음" "$STOCK_FULL" "100|0"
EVENTS="$(psql_q "SELECT count(*) FROM shop_order_events e JOIN shop_orders o ON o.id=e.order_id WHERE o.order_no='$NO1' AND e.to_status='cancelled'")"
check "상태 이력에 기록" "$EVENTS" "1"
check "취소된 주문에는 더 신청 불가" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO1/returns" -H 'content-type: application/json' --data-binary "@$TMP/rest.json")" "400"

echo "── 이중 복원 방어 (부분 반품 후 주문 전체 취소)"
printf '{"items":[{"productId":"%s","quantity":3}],"orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o2.json"
NO2="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o2.json" | jq_get "['orderNo']")"
ITEM2="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$NO2'")"
check "주문 후 재고 97" "$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")" "97"
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM2" > "$TMP/p1.json"
RID3="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO2/returns" -H 'content-type: application/json' --data-binary "@$TMP/p1.json" | jq_get "['id']")"
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID3" -H 'content-type: application/json' -d '{"status":"approved"}' >/dev/null
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID3" -H 'content-type: application/json' -d '{"status":"completed"}' >/dev/null
check "1개 반품 후 재고 98" "$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")" "98"
# 이제 주문 관리에서 주문 전체를 취소한다 — 남은 2개만 복원되어야 한다
OID2="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO2'")"
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID2" -H 'content-type: application/json' \
  -d '{"status":"cancelled","note":"관리자 취소"}' >/dev/null
check "주문 취소 후 재고 100 (101이 아니다 — 이중 복원 방어)" \
  "$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")" "100"
check "판매수량도 0" "$(psql_q "SELECT sold_count FROM shop_products WHERE id='$PID'")" "0"

echo "── 배송 후 반품: 단순변심은 반송비를 고객이 낸다"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o3.json"
NO3="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o3.json" | jq_get "['orderNo']")"
OID3="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO3'")"
ITEM3="$(psql_q "SELECT oi.id FROM shop_order_items oi WHERE oi.order_id='$OID3'")"
for st in paid preparing shipped delivered; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID3" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\"}" >/dev/null
done
DELIVERED="$(psql_q "SELECT delivered_at IS NOT NULL FROM shop_orders WHERE order_no='$NO3'")"
check "배송완료 시각 기록 (청약철회 기산점)" "$DELIVERED" "true"
RA3="$(curl -s -b "$B1" "$SHOP/orders/$NO3/returnable")"
contains "배송 후에는 반품·교환" "$RA3" '"code":"return"'
absent "배송 후에는 취소 불가" "$RA3" '"code":"cancel"'
contains "청약철회 기한 제공" "$RA3" '"withdrawalDeadline":"20'
contains "아직 기한 내" "$RA3" '"withdrawalExpired":false'

printf '{"kind":"return","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM3" > "$TMP/ret1.json"
RREQ="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO3/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret1.json")"
RID4="$(echo "$RREQ" | jq_get "['id']")"
contains "단순변심 반품: 10000-3000=7000" "$RREQ" '"refundAmount":7000'
contains "고객 부담 표기" "$RREQ" '"shippingPayer":"customer"'
FEE="$(psql_q "SELECT return_shipping_fee, shipping_payer FROM shop_returns WHERE id='$RID4'")"
check "반품 배송비 기록" "$FEE" "3000|customer"

echo "── 불량은 사업자 부담 (고객에게 청구하면 위법)"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자2","ordererPhone":"010-3333-4444","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o4.json"
NO4="$(curl -s -b "$B2" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o4.json" | jq_get "['orderNo']")"
OID4="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO4'")"
ITEM4="$(psql_q "SELECT oi.id FROM shop_order_items oi WHERE oi.order_id='$OID4'")"
for st in paid preparing shipped delivered; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID4" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
printf '{"kind":"return","reasonCode":"defect","reason":"화면에 흠집이 있습니다","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM4" > "$TMP/ret2.json"
DREQ="$(curl -s -b "$B2" -X POST "$SHOP/orders/$NO4/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret2.json")"
RID5="$(echo "$DREQ" | jq_get "['id']")"
contains "불량 반품: 전액 환불 (반송비 차감 없음)" "$DREQ" '"refundAmount":10000'
contains "사업자 부담 표기" "$DREQ" '"shippingPayer":"seller"'
FEE2="$(psql_q "SELECT return_shipping_fee FROM shop_returns WHERE id='$RID5'")"
check "불량은 반품 배송비 0" "$FEE2" "0"

echo "── 반품 진행: 수거 → 입고 → 완료"
contains "승인" "$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID5" -H 'content-type: application/json' \
  -d '{"status":"approved","pickup_tracking_no":"123456789"}')" '"status":"approved"'
contains "수거중" "$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID5" -H 'content-type: application/json' \
  -d '{"status":"collecting"}')" '"status":"collecting"'
contains "입고완료" "$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID5" -H 'content-type: application/json' \
  -d '{"status":"received"}')" '"status":"received"'
STOCK_PRE="$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")"
DONE5="$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID5" -H 'content-type: application/json' \
  -d '{"status":"completed"}')"
contains "처리완료" "$DONE5" '"status":"completed"'
STOCK_POST="$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")"
check "입고 후 재고 복원" "$STOCK_POST" "$((STOCK_PRE + 1))"
REFUNDED="$(psql_q "SELECT o.status, r.refunded_at IS NOT NULL FROM shop_orders o JOIN shop_returns r ON r.order_id=o.id WHERE r.id='$RID5'")"
contains "전량 반품이면 주문은 환불 상태" "$REFUNDED" "refunded|true"
TRACK="$(psql_q "SELECT pickup_tracking_no FROM shop_returns WHERE id='$RID5'")"
check "수거 운송장 기록" "$TRACK" "123456789"

echo "── 교환: 같은 상품의 다른 옵션으로만"
printf '{"items":[{"productId":"%s","quantity":1,"optionId":"%s"}],"orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID2" "$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$PID2' AND name LIKE '%빨강%'")" > "$TMP/o5.json"
NO5="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o5.json" | jq_get "['orderNo']")"
OID5="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO5'")"
ITEM5="$(psql_q "SELECT oi.id FROM shop_order_items oi WHERE oi.order_id='$OID5'")"
BLUE="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$PID2' AND name LIKE '%파랑%'")"
OTHER_OPT="$(psql_q "SELECT id FROM shop_product_options WHERE product_id != '$PID2' LIMIT 1")"
for st in paid preparing shipped delivered; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID5" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
if [[ -n "$OTHER_OPT" ]]; then
  printf '{"kind":"exchange","reasonCode":"size_or_color","items":[{"orderItemId":"%s","quantity":1,"exchangeOptionId":"%s"}]}' "$ITEM5" "$OTHER_OPT" > "$TMP/badex.json"
  check "다른 상품의 옵션으로 교환 차단" \
    "$(code -b "$B1" -X POST "$SHOP/orders/$NO5/returns" -H 'content-type: application/json' --data-binary "@$TMP/badex.json")" "400"
else
  ok "다른 상품의 옵션으로 교환 차단 (대상 없음 — 검증 생략)"
fi
printf '{"kind":"exchange","reasonCode":"size_or_color","items":[{"orderItemId":"%s","quantity":1,"exchangeOptionId":"%s"}]}' "$ITEM5" "$BLUE" > "$TMP/ex.json"
EREQ="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO5/returns" -H 'content-type: application/json' --data-binary "@$TMP/ex.json")"
RID6="$(echo "$EREQ" | jq_get "['id']")"
[[ -n "$RID6" ]] && ok "교환 신청" || bad "교환 신청"
contains "교환은 환불 금액 없음" "$EREQ" '"refundAmount":0'
RED_BEFORE="$(psql_q "SELECT stock FROM shop_product_options WHERE product_id='$PID2' AND name LIKE '%빨강%'")"
BLUE_BEFORE="$(psql_q "SELECT stock FROM shop_product_options WHERE id='$BLUE'")"
for st in approved received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID6" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\",\"exchange_tracking_no\":\"999888777\"}" >/dev/null
done
check "반품 옵션 재고 +1" \
  "$(psql_q "SELECT stock FROM shop_product_options WHERE product_id='$PID2' AND name LIKE '%빨강%'")" "$((RED_BEFORE + 1))"
check "교환 옵션 재고 -1" "$(psql_q "SELECT stock FROM shop_product_options WHERE id='$BLUE'")" "$((BLUE_BEFORE - 1))"
NEWOPT="$(psql_q "SELECT option_name FROM shop_order_items WHERE id='$ITEM5'")"
contains "주문 항목의 옵션이 바뀜 (무엇을 받았는지 기록)" "$NEWOPT" "파랑"
EX_STATUS="$(psql_q "SELECT status FROM shop_orders WHERE order_no='$NO5'")"
check "교환은 주문 상태를 바꾸지 않음" "$EX_STATUS" "delivered"

echo "── 청약철회 7일 (전자상거래법 제17조)"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o6.json"
NO6="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o6.json" | jq_get "['orderNo']")"
OID6="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO6'")"
ITEM6="$(psql_q "SELECT oi.id FROM shop_order_items oi WHERE oi.order_id='$OID6'")"
for st in paid preparing shipped delivered; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID6" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
# 배송완료를 8일 전으로 밀어 기한 초과 상황을 만든다
psql_q "UPDATE shop_orders SET delivered_at = now() - interval '8 days' WHERE order_no='$NO6'" >/dev/null
RA6="$(curl -s -b "$B1" "$SHOP/orders/$NO6/returnable")"
contains "기한 초과 표시" "$RA6" '"withdrawalExpired":true'
printf '{"kind":"return","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM6" > "$TMP/late.json"
check "기한 초과 후 단순변심 반품 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/late.json")" "400"
contains "기한을 알려준다" \
  "$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/late.json")" "7일 안에만"
# 하지만 불량은 기간과 무관하게 받아야 한다 (하자 책임은 청약철회와 별개다)
printf '{"kind":"return","reasonCode":"defect","reason":"사용 중 고장","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM6" > "$TMP/latedefect.json"
LATE_DEFECT="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/latedefect.json")"
contains "기한 초과여도 불량은 접수 (하자 책임은 별개)" "$LATE_DEFECT" '"returnNo"'

echo "── 고객의 요청 철회"
RID7="$(echo "$LATE_DEFECT" | jq_get "['id']")"
check "남의 요청은 철회 불가" "$(code -b "$B2" -X POST "$SHOP/returns/$RID7/cancel")" "404"
contains "본인은 철회 가능" "$(curl -s -b "$B1" -X POST "$SHOP/returns/$RID7/cancel")" '"ok":true'
check "이미 철회한 요청은 다시 못 함" "$(code -b "$B1" -X POST "$SHOP/returns/$RID7/cancel")" "409"
# 처리가 시작된 요청은 철회할 수 없다
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM6" > "$TMP/again.json"
RID8="$(curl -s -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/again.json" | jq_get "['id']")"
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID8" -H 'content-type: application/json' -d '{"status":"approved"}' >/dev/null
check "승인된 요청은 고객이 철회 불가" "$(code -b "$B1" -X POST "$SHOP/returns/$RID8/cancel")" "409"
contains "판매자에게 문의하라고 안내" "$(curl -s -b "$B1" -X POST "$SHOP/returns/$RID8/cancel")" "판매자에게 문의"

echo "── 거부"
DENY="$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID8" -H 'content-type: application/json' \
  -d '{"status":"rejected","reject_reason":"사용 흔적이 많아 반품이 어렵습니다."}')"
contains "거부 처리" "$DENY" '"status":"rejected"'
REJECT="$(psql_q "SELECT reject_reason FROM shop_returns WHERE id='$RID8'")"
contains "거부 사유 저장 (고객에게 전달)" "$REJECT" "사용 흔적"
STOCK_NOCHANGE="$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")"
curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID8" -H 'content-type: application/json' -d '{"status":"completed"}' >/dev/null 2>&1 || true
check "거부된 요청은 완료로 갈 수 없다 (재고 변화 없음)" \
  "$(psql_q "SELECT stock FROM shop_products WHERE id='$PID'")" "$STOCK_NOCHANGE"

echo "── 내 요청 목록 · 상세"
MY="$(curl -s -b "$B1" "$SHOP/my/returns")"
contains "내 요청 목록" "$MY" '"return_no"'
contains "라벨 제공" "$MY" '"kind_label"'
contains "다음 가능 상태 제공 (화면이 버튼을 만든다)" "$MY" '"next_statuses"'
MY2="$(curl -s -b "$B2" "$SHOP/my/returns")"
absent "남의 요청은 안 보임" "$MY2" "$RNO1"
DETAIL="$(curl -s -b "$B1" "$SHOP/returns/$RID4")"
contains "상세에 대상 상품" "$DETAIL" "반품테스트 상품"
check "남의 요청 상세는 404" "$(code -b "$B2" "$SHOP/returns/$RID4")" "404"

echo "── 관리자 목록"
ADMIN_LIST="$(curl -s -b "$CK" "$SHOP/admin/returns")"
contains "전체 요청 목록" "$ADMIN_LIST" '"return_no"'
contains "미처리 건수 집계" "$ADMIN_LIST" '"pendingCount"'
contains "사유 라벨" "$ADMIN_LIST" '"reason_label"'
contains "상태 필터" "$(curl -s -b "$CK" "$SHOP/admin/returns?status=completed")" '"status":"completed"'
contains "종류 필터" "$(curl -s -b "$CK" "$SHOP/admin/returns?kind=exchange")" '"kind":"exchange"'
check "비관리자 접근 차단" "$(code -b "$B1" "$SHOP/admin/returns")" "403"

echo "── 검증 (잘못된 입력)"
printf '{"kind":"bogus","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM6" > "$TMP/badkind.json"
check "없는 종류 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/badkind.json")" "400"
printf '{"kind":"return","reasonCode":"nope","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM6" > "$TMP/badreason.json"
check "없는 사유 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/badreason.json")" "400"
check "대상 없는 신청 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' \
      -d '{"kind":"return","reasonCode":"defect","items":[]}')" "400"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":0}]}' "$ITEM6" > "$TMP/zero.json"
check "수량 0 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/zero.json")" "400"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1},{"orderItemId":"%s","quantity":1}]}' "$ITEM6" "$ITEM6" > "$TMP/twice.json"
check "같은 항목 두 번 차단" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$NO6/returns" -H 'content-type: application/json' --data-binary "@$TMP/twice.json")" "400"
check "없는 주문은 404" \
  "$(code -b "$B1" "$SHOP/orders/NOPE-0000/returnable")" "404"

echo "── 동시 신청 (주문 수량을 넘길 수 없다)"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/o7.json"
NO7="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o7.json" | jq_get "['orderNo']")"
OID7="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$NO7'")"
ITEM7="$(psql_q "SELECT oi.id FROM shop_order_items oi WHERE oi.order_id='$OID7'")"
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM7" > "$TMP/race.json"
PIDS=()
for i in 1 2 3 4; do
  curl -s -b "$B1" -X POST "$SHOP/orders/$NO7/returns" -H 'content-type: application/json' \
    --data-binary "@$TMP/race.json" -o "$TMP/race$i.json" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" || true; done
# 각 요청은 아직 완료되지 않았으므로 cancelled_qty 는 0이다 —
# 신청 자체는 여러 건이 접수될 수 있다. 문제는 **완료**에서 막히는가다.
REQS="$(psql_q "SELECT count(*) FROM shop_returns r JOIN shop_orders o ON o.id=r.order_id WHERE o.order_no='$NO7'")"
[[ "$REQS" -ge 1 ]] && ok "동시 신청 접수 ($REQS건)" || bad "동시 신청 접수"
# 하나를 완료하면 나머지는 완료될 수 없어야 한다 (수량이 이미 소진)
FIRST=""
for i in 1 2 3 4; do
  ID="$(cat "$TMP/race$i.json" 2>/dev/null | jq_get "['id']")"
  [[ -n "$ID" ]] || continue
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$ID" -H 'content-type: application/json' -d '{"status":"approved"}' >/dev/null
  RES="$(code -b "$CK" -X PUT "$SHOP/admin/returns/$ID" -H 'content-type: application/json' -d '{"status":"completed"}')"
  if [[ -z "$FIRST" && "$RES" == "200" ]]; then FIRST="$ID"; fi
done
CQ7="$(psql_q "SELECT cancelled_qty FROM shop_order_items WHERE id='$ITEM7'")"
check "취소 수량이 주문 수량(1)을 넘지 않음" "$CQ7" "1"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -50 "$TMP/api.log"; exit 1; }
