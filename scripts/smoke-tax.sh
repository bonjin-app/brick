#!/usr/bin/env bash
#
# 세금 증빙 E2E 스모크 — 현금영수증 · 세금계산서 · 부가세 신고 자료.
#
# 이 영역은 틀리면 **세금을 잘못 낸다.** 부가가치세법 제32조의2·제46조:
# 최종소비자가 요청하면 현금영수증을 발급해야 하고, 미발급은 미발급액의
# 20% 가산세다.
#
# 못박는 것:
#   - 카드 결제에 발급을 거부하는가 (카드는 이미 국세청에 통보된다 — 이중 신고)
#   - 같은 주문에 두 번 발급되지 않는가 (세금을 두 번 신고한다)
#   - 공급가액 + 부가세 + 면세금액 == 총액 인가 (1원이라도 어긋나면 반려된다)
#   - 면세 상품에 부가세를 붙이지 않는가 (도서 쇼핑몰이 잘못된 증빙을 낸다)
#   - 반품 환불 후 증빙이 취소되는가 (안 하면 세금을 더 낸다)
#   - 환불된 만큼 빼고 증빙하는가
#   - 남의 주문에 발급할 수 없는가 (404 로, 존재를 알리지 않고)
#   - 발급 대기를 "발급됨"으로 감추지 않는가 (승인번호 없이 완료 불가)
#   - 상품의 면세 설정을 바꿔도 과거 주문의 증빙 금액이 흔들리지 않는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-tax.sh
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

echo "▶ 세금 증빙 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-tax-secret-value}"
export BRICK_CAPTCHA=off
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
    -d '{"siteName":"세금","adminEmail":"admin@tax.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@tax.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

# 구매자 둘 — 남의 주문에 발급할 수 없어야 한다
for n in 1 2; do
  printf '{"email":"b%s@tax.test","password":"password123",%s"displayName":"구매자%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"b%s@tax.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/b$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
B1="$TMP/b1.txt"; B2="$TMP/b2.txt"

echo "── 안내: 법적 근거와 발급 대상을 밝힌다"
INFO="$(curl -s "$SHOP/tax/info")"
contains "법적 근거" "$INFO" "부가가치세법 제32조의2"
contains "소득공제용" "$INFO" '"code":"income_deduction"'
contains "지출증빙용" "$INFO" '"code":"expense_proof"'
contains "카드는 대상이 아님을 알린다" "$INFO" "카드사가 국세청에 자동 통보"
contains "기본 발급 수단은 수동" "$INFO" '"code":"manual"'

echo "── 관리 화면 등록"
NAV="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "현금영수증 리소스" "$NAV" '"name":"cash-receipts"'
contains "세금계산서 리소스" "$NAV" '"name":"tax-invoices"'
PFIELDS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products")"
contains "상품 폼에 면세 항목" "$PFIELDS" '"name":"tax_free"'

echo "── 준비: 과세 상품과 면세 상품"
P_TAX="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"mug","name":"머그컵","price":11000,"stock":100,"status":"selling"}' | jq_get "['id']")"
P_FREE="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"book","name":"소설책","price":15000,"stock":100,"status":"selling","tax_free":true}' | jq_get "['id']")"
[[ -n "$P_TAX" && -n "$P_FREE" ]] && ok "상품 등록" || bad "상품 등록"
check "면세 설정이 저장됨" "$(psql_q "SELECT tax_free FROM shop_products WHERE id='$P_FREE'")" "true"
check "과세 상품은 false" "$(psql_q "SELECT tax_free FROM shop_products WHERE id='$P_TAX'")" "false"

mkorder() {  # mkorder <쿠키> <상품id> <수량> → orderNo
  printf '{"items":[{"productId":"%s","quantity":%s}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$2" "$3" > "$TMP/mk.json"
  curl -s -b "$1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json" | jq_get "['orderNo']"
}
paynow() { psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at=now() WHERE order_no='$1'" >/dev/null; }

echo "── 주문 항목에 면세가 스냅샷으로 남는다"
O_FREE="$(mkorder "$B1" "$P_FREE" 1)"
check "면세 상품 주문 항목" "$(psql_q "SELECT oi.tax_free FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_FREE'")" "true"

echo "── 결제 전에는 발급할 수 없다"
O1="$(mkorder "$B1" "$P_TAX" 1)"
check "미결제 주문은 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "400"
contains "이유를 알려준다" \
  "$(curl -s -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "결제가 확인된 뒤"

echo "── 식별번호 검증 (용도와 번호 형태가 맞아야 국세청이 받는다)"
paynow "$O1"
check "휴대폰 자리수가 틀리면 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"0101234"}')" "400"
check "지출증빙에 휴대폰 번호를 넣으면 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"expense_proof","identifier":"01012345678"}')" "400"
check "체크섬이 틀린 사업자번호는 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"expense_proof","identifier":"1234567890"}')" "400"
check "용도를 안 주면 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"identifier":"01012345678"}')" "400"

echo "── 발급: 금액 분해가 정확해야 한다"
# 11,000 + 배송비 3,000 = 14,000 (전부 과세)
AMT="$(psql_q "SELECT total FROM shop_orders WHERE order_no='$O1'")"
check "주문 총액 14000" "$AMT" "14000"
R1="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"010-1234-5678"}')"
RID1="$(echo "$R1" | jq_get "['id']")"
[[ -n "$RID1" ]] && ok "발급 신청" || bad "발급 신청 ($R1)"
contains "총액" "$R1" '"total":14000'
# 14000 / 1.1 = 12727.27 → 공급가액 12727, 부가세 1273
contains "공급가액 12727" "$R1" '"supplyAmount":12727'
contains "부가세 1273" "$R1" '"vatAmount":1273'
contains "면세 0" "$R1" '"taxFreeAmount":0'
SUM="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['supplyAmount']+d['vatAmount']+d['taxFreeAmount'] == d['total'])" <<< "$R1")"
check "공급가액+부가세+면세 == 총액 (1원도 어긋나면 반려된다)" "$SUM" "True"

echo "── 발급 대기를 \"발급됨\"으로 감추지 않는다"
contains "수동 모드는 대기 상태" "$R1" '"status":"requested"'
contains "대기임을 명시한다" "$R1" '"pending":true'
check "DB 도 requested" "$(psql_q "SELECT status FROM shop_cash_receipts WHERE id='$RID1'")" "requested"
check "승인번호는 아직 없다" "$(psql_q "SELECT coalesce(approval_no,'(없음)') FROM shop_cash_receipts WHERE id='$RID1'")" "(없음)"

echo "── 식별번호는 가려서 내보낸다 (개인정보)"
contains "뒤 4자리만" "$R1" '"identifier":"*******5678"'
LIST="$(curl -s -b "$CK" "$SHOP/admin/cash-receipts")"
absent "목록에 전체 번호가 없다" "$LIST" "01012345678"
contains "목록도 가려서" "$LIST" '5678'
# 저장은 되어야 한다 (취소·재발급에 필요하다)
check "DB 에는 원본이 있다" "$(psql_q "SELECT identifier FROM shop_cash_receipts WHERE id='$RID1'")" "01012345678"

echo "── 중복 발급은 세금을 두 번 신고한다"
check "같은 주문에 두 번은 409" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O1/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "409"
check "행은 하나뿐" "$(psql_q "SELECT count(*) FROM shop_cash_receipts WHERE order_id=(SELECT id FROM shop_orders WHERE order_no='$O1')")" "1"

echo "── 승인번호 없이 발급완료로 바꿀 수 없다"
check "승인번호 없으면 400" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$RID1" -H 'content-type: application/json' \
      -d '{"status":"issued"}')" "400"
contains "왜 필요한지 알려준다" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$RID1" -H 'content-type: application/json' \
      -d '{"status":"issued"}')" "승인번호"
contains "승인번호를 주면 발급완료" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$RID1" -H 'content-type: application/json' \
      -d '{"status":"issued","approvalNo":"123456789012"}')" '"ok":true'
ISSUED="$(psql_q "SELECT status, approval_no, issued_at IS NOT NULL FROM shop_cash_receipts WHERE id='$RID1'")"
check "발급 시각과 승인번호가 남는다" "$ISSUED" "issued|123456789012|true"
check "비관리자는 상태를 바꿀 수 없다" \
  "$(code -b "$B1" -X PUT "$SHOP/admin/cash-receipts/$RID1" -H 'content-type: application/json' \
      -d '{"status":"cancelled"}')" "403"

echo "── 카드 결제에는 발급하지 않는다 (이중 신고가 된다)"
O_CARD="$(mkorder "$B1" "$P_TAX" 1)"
psql_q "UPDATE shop_orders SET payment_method='card', payment_status='paid', status='paid', paid_at=now() WHERE order_no='$O_CARD'" >/dev/null
check "카드 주문은 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_CARD/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "400"
contains "이중 신고를 이유로 든다" \
  "$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_CARD/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "이중 신고"

echo "── 남의 주문에는 발급할 수 없다 (404 — 존재를 알리지 않는다)"
O_OTHER="$(mkorder "$B1" "$P_TAX" 1)"
paynow "$O_OTHER"
check "다른 회원은 404 (403이면 주문 존재가 새어 나간다)" \
  "$(code -b "$B2" -X POST "$SHOP/orders/$O_OTHER/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "404"
check "비로그인도 404" \
  "$(code -X POST "$SHOP/orders/$O_OTHER/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "404"
check "내역 조회도 남의 것은 404" "$(code -b "$B2" "$SHOP/orders/$O_OTHER/cash-receipt")" "404"
contains "관리자는 대신 발급할 수 있다" \
  "$(curl -s -b "$CK" -X POST "$SHOP/orders/$O_OTHER/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01098765432"}')" '"total"'

echo "── 면세 상품: 부가세를 붙이지 않는다"
# 소설책 15,000 + 배송비 3,000 = 18,000. 상품 15,000 은 면세, 배송비는 과세
O_BOOK="$(mkorder "$B1" "$P_FREE" 1)"
paynow "$O_BOOK"
check "주문 총액 18000" "$(psql_q "SELECT total FROM shop_orders WHERE order_no='$O_BOOK'")" "18000"
RB="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_BOOK/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"01011112222"}')"
contains "면세금액 15000" "$RB" '"taxFreeAmount":15000'
# 과세분 3,000 → 공급가액 2727, 부가세 273
contains "과세분만 공급가액 2727" "$RB" '"supplyAmount":2727'
contains "부가세는 273 (15000에는 안 붙는다)" "$RB" '"vatAmount":273'
SUMB="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['supplyAmount']+d['vatAmount']+d['taxFreeAmount'] == d['total'] == 18000)" <<< "$RB")"
check "합계가 총액과 일치" "$SUMB" "True"

echo "── 상품 면세 설정을 바꿔도 과거 증빙 금액은 흔들리지 않는다"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P_FREE" -H 'content-type: application/json' \
  -d '{"slug":"book","name":"소설책","price":15000,"stock":100,"status":"selling","tax_free":false}' >/dev/null
check "상품은 과세로 바뀜" "$(psql_q "SELECT tax_free FROM shop_products WHERE id='$P_FREE'")" "false"
check "과거 주문 항목은 면세 그대로 (스냅샷)" \
  "$(psql_q "SELECT oi.tax_free FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_BOOK'")" "true"
STORED="$(psql_q "SELECT tax_free_amount FROM shop_cash_receipts WHERE order_id=(SELECT id FROM shop_orders WHERE order_no='$O_BOOK')")"
check "발급된 증빙 금액도 그대로" "$STORED" "15000"
# 되돌린다 (뒤 검증에 쓴다)
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P_FREE" -H 'content-type: application/json' \
  -d '{"slug":"book","name":"소설책","price":15000,"stock":100,"status":"selling","tax_free":true}' >/dev/null

echo "── 환불된 만큼 빼고 증빙한다"
# 머그컵 2개 = 22,000 + 배송비 3,000 = 25,000. 하나 반품 후 발급
O_PART="$(mkorder "$B1" "$P_TAX" 2)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$O_PART'" >/dev/null
check "총액 25000" "$(psql_q "SELECT total FROM shop_orders WHERE order_no='$O_PART'")" "25000"
ITEM_P="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_PART'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM_P" > "$TMP/rp.json"
RETP="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_PART/returns" -H 'content-type: application/json' --data-binary "@$TMP/rp.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RETP" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
check "11000 환불됨" "$(psql_q "SELECT refund_amount FROM shop_returns WHERE id='$RETP'")" "11000"
RP="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_PART/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"01033334444"}')"
contains "환불액을 뺀 14000 만 증빙 (25000 이 아니다)" "$RP" '"total":14000'

echo "── 반품 환불이 발급된 증빙을 취소한다 (안 하면 세금을 더 낸다)"
O_RET="$(mkorder "$B1" "$P_TAX" 1)"
psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$O_RET'" >/dev/null
RR="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_RET/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"01055556666"}' | jq_get "['id']")"
curl -s -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$RR" -H 'content-type: application/json' \
  -d '{"status":"issued","approvalNo":"999888777666"}' >/dev/null
check "발급 완료 상태" "$(psql_q "SELECT status FROM shop_cash_receipts WHERE id='$RR'")" "issued"

ITEM_R="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_RET'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM_R" > "$TMP/rr.json"
RETR="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_RET/returns" -H 'content-type: application/json' --data-binary "@$TMP/rr.json" | jq_get "['id']")"
for st in approved picked_up received; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RETR" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
check "입고 단계까지는 증빙이 살아 있다 (환불이 아직 안 나갔다)" \
  "$(psql_q "SELECT status FROM shop_cash_receipts WHERE id='$RR'")" "issued"
DONE_R="$(curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RETR" -H 'content-type: application/json' -d '{"status":"completed"}')"
contains "반품 완료" "$DONE_R" '"status":"completed"'
contains "함께 취소된 증빙 수를 알려준다" "$DONE_R" '"receiptsCancelled":1'
CANCELLED="$(psql_q "SELECT status, cancelled_at IS NOT NULL FROM shop_cash_receipts WHERE id='$RR'")"
check "증빙이 취소됨" "$CANCELLED" "cancelled|true"
contains "취소 사유에 반품이 남는다" "$(psql_q "SELECT cancel_reason FROM shop_cash_receipts WHERE id='$RR'")" "환불"
# 취소된 것은 다시 발급할 수 있어야 한다 (부분 반품 후 잔액 재발급)
check "이미 취소된 것은 다시 취소 못 함" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$RR" -H 'content-type: application/json' \
      -d '{"status":"cancelled"}')" "400"

echo "── 교환은 금액이 안 변하므로 증빙을 건드리지 않는다"
P_OPT="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"tee","name":"티셔츠","price":20000,"stock":100,"status":"selling","options_text":"S|0|50\nM|0|50"}' | jq_get "['id']")"
OPT_S="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$P_OPT' AND name='S'")"
OPT_M="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$P_OPT' AND name='M'")"
printf '{"items":[{"productId":"%s","optionId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P_OPT" "$OPT_S" > "$TMP/ex.json"
O_EX="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/ex.json" | jq_get "['orderNo']")"
psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$O_EX'" >/dev/null
REX="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_EX/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"01077778888"}' | jq_get "['id']")"
curl -s -b "$CK" -X PUT "$SHOP/admin/cash-receipts/$REX" -H 'content-type: application/json' \
  -d '{"status":"issued","approvalNo":"111222333444"}' >/dev/null
ITEM_EX="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_EX'")"
printf '{"kind":"exchange","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1,"exchangeOptionId":"%s"}]}' "$ITEM_EX" "$OPT_M" > "$TMP/exr.json"
RETX="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_EX/returns" -H 'content-type: application/json' --data-binary "@$TMP/exr.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RETX" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
check "교환 완료" "$(psql_q "SELECT status FROM shop_returns WHERE id='$RETX'")" "completed"
check "증빙은 그대로 (돈이 오가지 않았다)" "$(psql_q "SELECT status FROM shop_cash_receipts WHERE id='$REX'")" "issued"

echo "══ 세금계산서 ══"
O_TI="$(mkorder "$B1" "$P_TAX" 1)"
paynow "$O_TI"
check "체크섬이 틀린 사업자번호는 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
      -d '{"businessNo":"1234567890","companyName":"주식회사","ceoName":"홍길동","contactEmail":"a@b.com"}')" "400"
check "상호 없으면 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
      -d '{"businessNo":"104-81-45690","companyName":"","ceoName":"홍길동","contactEmail":"a@b.com"}')" "400"
check "이메일 없으면 400 (보낼 곳이 없다)" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
      -d '{"businessNo":"104-81-45690","companyName":"주식회사","ceoName":"홍길동"}')" "400"
TI="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
  -d '{"businessNo":"104-81-45690","companyName":"본진테크","ceoName":"홍길동","contactEmail":"tax@bonjin.test","address":"서울시","businessType":"소매","businessItem":"전자상거래"}')"
TIID="$(echo "$TI" | jq_get "['id']")"
[[ -n "$TIID" ]] && ok "세금계산서 요청" || bad "세금계산서 요청 ($TI)"
contains "요청 상태" "$TI" '"status":"requested"'
contains "금액 분해" "$TI" '"supplyAmount":12727'
check "같은 주문에 두 번은 409" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
      -d '{"businessNo":"104-81-45690","companyName":"본진테크","ceoName":"홍길동","contactEmail":"tax@bonjin.test"}')" "409"
check "남의 주문은 404" \
  "$(code -b "$B2" -X POST "$SHOP/orders/$O_TI/tax-invoice" -H 'content-type: application/json' \
      -d '{"businessNo":"104-81-45690","companyName":"x","ceoName":"y","contactEmail":"a@b.com"}')" "404"

TIL="$(curl -s -b "$CK" "$SHOP/admin/tax-invoices")"
contains "요청 목록에 뜬다 (묻히지 않는다)" "$TIL" '"companyName":"본진테크"'
contains "받을 이메일이 목록에 있다" "$TIL" "tax@bonjin.test"
check "비관리자는 목록 불가" "$(code "$SHOP/admin/tax-invoices")" "403"

check "승인번호 없이 발급완료 불가" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/tax-invoices/$TIID" -H 'content-type: application/json' \
      -d '{"status":"issued"}')" "400"
check "사유 없이 거부 불가" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/tax-invoices/$TIID" -H 'content-type: application/json' \
      -d '{"status":"rejected"}')" "400"
contains "승인번호를 주면 발급" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/tax-invoices/$TIID" -H 'content-type: application/json' \
      -d '{"status":"issued","invoiceNo":"20260828-0001"}')" '"ok":true'
check "발급 시각이 남는다" \
  "$(psql_q "SELECT status, invoice_no, issued_at IS NOT NULL FROM shop_tax_invoices WHERE id='$TIID'")" \
  "issued|20260828-0001|true"
check "이미 발급된 것은 다시 처리 못 함" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/tax-invoices/$TIID" -H 'content-type: application/json' \
      -d '{"status":"issued","invoiceNo":"x"}')" "400"

echo "══ 부가세 신고 자료 ══"
PERIODS="$(curl -s -b "$CK" "$SHOP/admin/reports/vat/periods")"
contains "과세기간을 골라 준다 (직접 계산하지 않게)" "$PERIODS" '"code":"1-final"'
contains "기간을 한글로 설명" "$PERIODS" "제1기 확정 (4~6월)"
check "비관리자는 불가" "$(code "$SHOP/admin/reports/vat")" "403"
check "없는 과세기간은 400" "$(code -b "$CK" "$SHOP/admin/reports/vat?year=2026&period=3-final")" "400"
check "연도가 이상하면 400" "$(code -b "$CK" "$SHOP/admin/reports/vat?year=1800&period=1-full")" "400"

VAT="$(curl -s -b "$CK" "$SHOP/admin/reports/vat?year=2026&period=2-full")"
contains "기간 라벨" "$VAT" "2026년 제2기 전체 (7~12월)"
contains "기간 시작" "$VAT" '"from":"2026-07-01"'
contains "말일을 정확히 (12월 31일)" "$VAT" '"to":"2026-12-31"'
contains "판매 리포트와 같은 정의임을 밝힌다" "$VAT" "판매 리포트와 같은 정의"
contains "세무 확인 경고" "$VAT" "세무 담당자와 확인"
contains "카드 구분" "$VAT" '"proof":"card"'
contains "현금영수증 구분" "$VAT" '"proof":"cash_receipt"'
contains "세금계산서 구분" "$VAT" '"proof":"tax_invoice"'
contains "증빙 없는 현금 매출을 따로 보여준다" "$VAT" '"proof":"other"'
VAT_SUM="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
t=d['total']
groups=d['groups']
print(sum(g['total'] for g in groups) == t['total'],
      sum(g['supplyAmount'] for g in groups) == t['supplyAmount'],
      sum(g['taxFreeAmount'] for g in groups) == t['taxFreeAmount'])" <<< "$VAT")"
check "그룹 합이 총계와 일치" "$VAT_SUM" "True True True"
FREE_IN_VAT="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['total']['taxFreeAmount'])" <<< "$VAT")"
check "면세 매출이 집계된다 (소설책 15000)" "$FREE_IN_VAT" "15000"
NOPROOF="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d['missingProof']
print('있음' if m and m['total'] > 0 else '없음')" <<< "$VAT")"
check "증빙 누락 매출을 눈에 띄게 준다" "$NOPROOF" "있음"

echo "── 부가세 자료도 CSV 로"
curl -s -b "$CK" -D "$TMP/vh.txt" "$SHOP/admin/reports/vat?year=2026&period=2-full&format=csv" -o "$TMP/vat.csv"
contains "CSV content-type" "$(cat "$TMP/vh.txt")" "text/csv"
BOM="$(head -c 3 "$TMP/vat.csv" | od -An -tx1 | tr -d ' \n')"
check "BOM (엑셀 한글)" "$BOM" "efbbbf"
contains "헤더" "$(cat "$TMP/vat.csv")" "공급가액"

echo "── 취소된 증빙은 부가세 자료의 현금영수증 발행분에서 빠진다"
# O_RET 은 반품으로 증빙이 취소되었고 환불도 전액이므로 매출 자체가 0이다
RET_IN_VAT="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
cr=[g for g in d['groups'] if g['proof']=='cash_receipt']
print(cr[0]['orders'] if cr else 0)" <<< "$VAT")"
[[ "$RET_IN_VAT" -ge 1 ]] && ok "현금영수증 발행분이 집계됨 ($RET_IN_VAT건)" || bad "현금영수증 발행분이 집계됨"
# 반품(return)은 배송비를 환불하지 않는다 — 상품은 이미 배송되었다.
# 전체 취소(cancel)만 배송비를 돌려준다.
FULL_RET_NET="$(psql_q "SELECT o.total - coalesce((SELECT sum(r.refund_amount) FROM shop_returns r WHERE r.order_id=o.id AND r.status='completed'),0) FROM shop_orders o WHERE o.order_no='$O_RET'")"
check "상품 전량 반품 후 순매출은 배송비뿐 (14000-11000)" "$FULL_RET_NET" "3000"

echo "── 취소된 증빙은 잔액으로 다시 발급할 수 있다"
# 부분 반품 후 잔액 재발급이 실무다 (국세청 API 가 부분 취소를 지원하지 않는 경우가 많다)
REISSUE="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_RET/cash-receipt" -H 'content-type: application/json' \
  -d '{"kind":"income_deduction","identifier":"01055556666"}')"
contains "남은 3000 으로 재발급" "$REISSUE" '"total":3000'
check "취소된 것과 새 것이 함께 남는다 (이력)" \
  "$(psql_q "SELECT count(*) FROM shop_cash_receipts WHERE order_id=(SELECT id FROM shop_orders WHERE order_no='$O_RET')")" "2"

echo "── 전액 환불(전체 취소)된 주문에는 발급할 수 없다"
O_ZERO="$(mkorder "$B1" "$P_TAX" 1)"
paynow "$O_ZERO"
ITEM_Z="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O_ZERO'")"
printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM_Z" > "$TMP/rz.json"
RETZ="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_ZERO/returns" -H 'content-type: application/json' --data-binary "@$TMP/rz.json" | jq_get "['id']")"
for st in approved completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RETZ" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
check "전체 취소는 배송비까지 환불 (14000)" "$(psql_q "SELECT refund_amount FROM shop_returns WHERE id='$RETZ'")" "14000"
check "받은 돈이 0이면 400" \
  "$(code -b "$B1" -X POST "$SHOP/orders/$O_ZERO/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "400"
contains "이유를 알려준다" \
  "$(curl -s -b "$B1" -X POST "$SHOP/orders/$O_ZERO/cash-receipt" -H 'content-type: application/json' \
      -d '{"kind":"income_deduction","identifier":"01012345678"}')" "전액 환불"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
