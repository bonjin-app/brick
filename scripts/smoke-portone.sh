#!/usr/bin/env bash
#
# 포트원(PortOne) V2 결제 — 국내 주요 PG(이니시스·KCP·NICE·카카오페이·네이버페이…)를 한 번에.
#
# 돈이 오가는 경로라 스텁 포트원(scripts/portone-stub.mjs)을 세우고 **실제 HTTP** 로 본다:
#   - 결제 확인은 조회다(승인 단계가 없다) — 상태가 PAID 이고 금액이 주문 총액과 같을 때만
#   - 결제 ID 가 **이 주문의 것**인지(다른 주문의 같은 금액 결제로 이 주문을 끝낼 수 없다)
#   - 부분환불은 취소 전 잔액을 함께 보낸다 — 포트원이 이중 부분환불을 막는 장치
#   - 시크릿은 어디에도 새지 않는다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-portone.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
PO="$API/api/plugins/brick-pay-portone"
PO_PORT=42640
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
POLOG="$TMP/portone.jsonl"
SECRET="portone_SECRET_VALUE_DO_NOT_LEAK"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${PO_PID:-}" ]]; then kill "$PO_PID" 2>/dev/null || true; wait "$PO_PID" 2>/dev/null || true; fi
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
po_last() {  # po_last <kind> <필드> — 포트원으로 나간 요청 중 마지막
  python3 -c "
import json, sys
found = None
for line in open('$POLOG', encoding='utf-8'):
    m = json.loads(line)
    if m.get('kind') == sys.argv[1]: found = m
print('' if found is None else found.get(sys.argv[2], ''))
" "$1" "$2"
}
po_count() { python3 -c "
import json
print(sum(1 for l in open('$POLOG', encoding='utf-8') if json.loads(l).get('kind') == '$1'))"; }
paid_by_customer() {  # paid_by_customer <paymentId> <금액> [상태] [storeId] — 손님이 결제창에서 결제를 마쳤다
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/payments" -H 'content-type: application/json' \
    -d "{\"paymentId\":\"$1\",\"total\":$2,\"status\":\"${3:-PAID}\",\"storeId\":\"${4:-store-brick-test}\"}"
}
confirm() {  # confirm <주문번호> <paymentId> → 응답 전체
  curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
    -d "{\"orderNo\":\"$1\",\"provider\":\"portone\",\"providerTid\":\"$2\",\"amount\":0}"
}

echo "▶ 포트원 결제 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

echo "── 스텁 포트원 시작"
PO_INFO="$(start_stub scripts/portone-stub.mjs "$PO_PORT" "$TMP/po.log" --out "$POLOG" --secret "$SECRET")" \
  || { bad "포트원 스텁 시작 실패: $(tail -5 "$TMP/po.log" 2>/dev/null)"; exit 1; }
PO_PORT="${PO_INFO% *}"; PO_PID="${PO_INFO#* }"
ok "스텁 포트원 시작 (:$PO_PORT)"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-portone-secret-value}"
export BRICK_CAPTCHA=off
# 테스트 전용 — 스텁 포트원으로 돌린다
export BRICK_PORTONE_API_BASE="http://127.0.0.1:${PO_PORT}"

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
    -d '{"siteName":"포트원","adminEmail":"admin@po.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@po.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-pay-portone; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"b@po.test","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"구매자"}' >/dev/null
curl -s -c "$TMP/b.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"b@po.test","password":"password123"}' >/dev/null
B="$TMP/b.txt"

echo "── 설정 (값이 모두 있어야 결제수단으로 뜬다)"
absent "설정 전에는 결제수단 목록에 없다" "$(curl -s "$SHOP/payment-methods")" '"portone"'
check "상점 ID 형식이 틀리면 거절 (어디서 확인하는지 알려 준다)" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"storeId":"abc"}')" "400"
check "시크릿 없이 켤 수 없다" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' \
      -d '{"storeId":"store-brick-test","channelKey":"channel-key-inicis-test","enabled":true}')" "400"
PUT="$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' \
  -d "{\"storeId\":\"store-brick-test\",\"channelKey\":\"channel-key-inicis-test\",\"apiSecret\":\"$SECRET\",\"payMethod\":\"CARD\",\"enabled\":true}")"
contains "저장된다" "$PUT" '"apiSecretConfigured":true'
absent "저장 응답에 시크릿이 없다" "$PUT" "SECRET_VALUE_DO_NOT_LEAK"
check "모르는 결제 수단은 기존 값을 지킨다" \
  "$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"payMethod":"VIRTUAL_ACCOUNT"}' | jq_get "['payMethod']")" "CARD"
METHODS="$(curl -s "$SHOP/payment-methods")"
contains "설정 후 결제수단으로 뜬다" "$METHODS" '"portone"'
contains "그 자리에서 결제창으로 넘기는 수단이다" "$METHODS" '"online":true'
PUB="$(curl -s "$PO/config")"
contains "공개 설정에 채널 키는 있다 (결제창이 쓴다)" "$PUB" "channel-key-inicis-test"
absent "공개 설정에 시크릿은 없다" "$PUB" "SECRET_VALUE_DO_NOT_LEAK"
absent "관리 조회에도 시크릿 원문이 없다" "$(curl -s -b "$CK" "$PO/admin/config")" "SECRET_VALUE_DO_NOT_LEAK"

echo "── 주문서가 포트원 결제창을 여는 스크립트를 싣는다"
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"shop","title":"쇼핑몰","status":"published","blocks":[{"block":"brick-shop/storefront","props":{}}]}' >/dev/null
CHECKOUT_HTML="$(curl -s -b "$B" "$API/api/render/page?path=shop/checkout" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))')"
contains "포트원 SDK 를 불러오는 스크립트" "$CHECKOUT_HTML" "cdn.portone.io/v2/browser-sdk.js"
contains "결제 ID 를 주문번호로 시작하게 만든다" "$CHECKOUT_HTML" "order.orderNo + '-'"
CSP="$(curl -s -D - -o /dev/null "$API/api/render/page?path=shop" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
contains "CSP 가 포트원 SDK 출처를 허용한다" "$CSP" "https://cdn.portone.io"
# 결제창에서 돌아온 주소를 읽는 함수 — 실패·취소면 code 가 붙어 온다(그때는 결제로 읽지 않는다)
READ_RETURN="$(node -e '
  const html = process.argv[1];
  const i = html.indexOf("window.brickPay[\x27portone\x27].readReturn");
  const j = html.indexOf("};", i) + 2;
  const vm = require("node:vm");
  const window = { brickPay: { portone: {} } };
  vm.runInNewContext(html.slice(i, j), { window, URLSearchParams });
  const r = window.brickPay.portone.readReturn;
  console.log(JSON.stringify([
    r(new URLSearchParams("brickPay=portone&orderNo=1&paymentId=1-abc")),
    r(new URLSearchParams("brickPay=portone&orderNo=1&paymentId=1-abc&code=FAILURE_TYPE_PG&message=x")),
  ]));
' "$CHECKOUT_HTML")"
check "돌아온 주소 읽기 — 성공은 결제 ID, 실패·취소는 null" "$READ_RETURN" '[{"providerTid":"1-abc","amount":0},null]'

echo "── 준비: 상품과 주문"
P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"po-item","name":"포트원 시험 상품","price":11000,"stock":100,"status":"selling"}' | jq_get "['id']")"
mkorder() {  # mkorder <수량> → 주문번호
  printf '{"items":[{"productId":"%s","quantity":%s}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울","paymentMethod":"portone"}}' "$P" "$1" > "$TMP/mk.json"
  curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json" | jq_get "['orderNo']"
}
O1="$(mkorder 2)"
check "포트원으로 주문한다 (11,000 × 2 + 배송비 3,000)" "$(psql_q "SELECT payment_method, total FROM shop_orders WHERE order_no='$O1'")" "portone|25000"

echo "── 결제 ID 가 이 주문의 것이어야 한다"
# 다른 주문의 결제(같은 금액)를 들고 와서 이 주문을 결제 완료로 만드는 경로를 막는다 —
# 금액 대조만으로는 못 막는다
O_OTHER="$(mkorder 2)"
paid_by_customer "$O_OTHER-zz1" 25000
WRONG="$(confirm "$O1" "$O_OTHER-zz1")"
contains "다른 주문의 결제 ID 는 거절한다" "$WRONG" "이 주문의 결제가 아닙니다"
check "포트원에 묻기 전에 거절한다" "$(po_count get)" "0"
check "주문은 결제대기 그대로" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O1'")" "unpaid"

echo "── 결제가 끝나지 않았으면 결제 완료로 만들지 않는다"
paid_by_customer "$O1-f1" 25000 FAILED
contains "실패한 결제는 거절하고 이유를 말한다" "$(confirm "$O1" "$O1-f1")" "결제가 실패했습니다"
paid_by_customer "$O1-va" 25000 VIRTUAL_ACCOUNT_ISSUED
contains "가상계좌 발급(입금 전)은 결제 완료가 아니다" "$(confirm "$O1" "$O1-va")" "가상계좌"
check "주문은 여전히 결제대기" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O1'")" "unpaid"

echo "── 금액이 주문 총액과 다르면 결제를 되돌린다"
paid_by_customer "$O1-low" 1000
LOW="$(confirm "$O1" "$O1-low")"
contains "금액 불일치를 거절한다" "$LOW" "일치하지 않습니다"
check "포트원에 취소를 요청했다" "$(po_last cancel paymentId)" "$O1-low"

echo "── 정상 결제"
paid_by_customer "$O1-ok" 25000
OK_RES="$(confirm "$O1" "$O1-ok")"
contains "결제 완료" "$OK_RES" '"ok":true'
check "주문이 결제완료로" "$(psql_q "SELECT payment_status, status FROM shop_orders WHERE order_no='$O1'")" "paid|paid"
check "포트원에 인증 헤더로 조회했다" "$(po_last get authOk)" "True"
check "결제 기록 (결제 ID · 금액 · 수단)" \
  "$(psql_q "SELECT provider, provider_tid, amount, method FROM shop_payments WHERE provider_tid='$O1-ok'")" "portone|$O1-ok|25000|카드"
contains "같은 결제로 다시 확인해도 이중 계상하지 않는다" "$(confirm "$O1" "$O1-ok")" '"ok":true'
check "결제 기록은 하나" "$(psql_q "SELECT count(*) FROM shop_payments WHERE provider_tid='$O1-ok'")" "1"

echo "── 다른 상점의 결제는 받지 않는다"
O2="$(mkorder 1)"
paid_by_customer "$O2-x" 14000 PAID store-someone-else
contains "상점이 다르면 거절한다 (손님에게는 일반 안내 — 설정 사정은 손님 탓이 아니다)" "$(confirm "$O2" "$O2-x")" '"statusCode":402'
check "주문은 결제대기 그대로" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O2'")" "unpaid"
contains "운영자가 볼 기록에 이유가 남는다" "$(psql_q "SELECT failure_reason FROM shop_payments WHERE provider_tid='$O2-x'")" "다른 상점"

echo "── 부분환불 — 취소 전 잔액을 함께 보낸다 (이중 부분환불 방지)"
R1="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":11000,\"reason\":\"부분 환불\"}")"
contains "1차 부분환불" "$R1" '"refundedNow":11000'
check "포트원으로 간 취소 금액" "$(po_last cancel amount)" "11000"
check "취소 전 잔액 25000 을 함께 보냈다" "$(po_last cancel currentCancellableAmount)" "25000"
R2="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":3000,\"reason\":\"배송비 환불\"}")"
contains "2차 부분환불" "$R2" '"refundedNow":3000'
check "두 번째는 잔액 14000 으로" "$(po_last cancel currentCancellableAmount)" "14000"
# PG 쪽 잔액이 우리 기록과 어긋나면(커밋되지 않은 재시도가 이미 한 번 나갔다고 치자)
# 포트원이 거절한다 — 같은 환불이 두 번 나가지 않는다
curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/phantom-cancel" -H 'content-type: application/json' \
  -d "{\"paymentId\":\"$O1-ok\",\"amount\":2000}"
R3="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":2000,\"reason\":\"재시도 흉내\"}")"
contains "잔액이 어긋나면 포트원이 거절하고 우리도 환불로 기록하지 않는다" "$R3" "잔액"
check "우리 기록의 누적 환불액은 그대로" "$(psql_q "SELECT refunded_amount FROM shop_payments WHERE provider_tid='$O1-ok'")" "14000"

echo "── 시크릿이 새지 않는다"
absent "서버 로그에 시크릿이 없다" "$(cat "$TMP/api.log")" "SECRET_VALUE_DO_NOT_LEAK"
absent "결제 기록(raw)에 시크릿이 없다" "$(psql_q "SELECT raw::text FROM shop_payments")" "SECRET_VALUE_DO_NOT_LEAK"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
# 실측을 남긴다(설정됐을 때만) — README 의 표가 실제와 같은지 CI 가 대조한다.
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 포트원으로 나간 요청 ──"; cat "$POLOG"; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
