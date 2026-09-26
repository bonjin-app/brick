#!/usr/bin/env bash
#
# 포트원(PortOne) V2 결제 — 국내 주요 PG(이니시스·KCP·NICE·카카오페이·네이버페이…)를 한 번에.
#
# 돈이 오가는 경로라 스텁 포트원(scripts/portone-stub.mjs)을 세우고 **실제 HTTP** 로 본다:
#   - 결제 확인은 조회다(승인 단계가 없다) — 상태가 PAID 이고 금액이 주문 총액과 같을 때만
#   - 결제 ID 가 **이 주문의 것**인지(다른 주문의 같은 금액 결제로 이 주문을 끝낼 수 없다)
#   - 부분환불은 취소 전 잔액을 함께 보낸다 — 포트원이 이중 부분환불을 막는 장치
#   - 가상계좌는 입금 대기로 두고, 입금은 웹훅으로 안다(웹훅 내용은 믿지 않고 포트원에 다시 묻는다)
#   - 정기결제: 빌링키는 이 회원에게 발급된 것만 받고, 회차 결제 ID 는 정해진 값 — 응답을 잃어도
#     이중 청구도, "긁혔는데 취소된 주문" 도 없다. 탈퇴하면 청구가 멈춘다
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
  "$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"payMethod":"BITCOIN"}' | jq_get "['payMethod']")" "CARD"
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
# 계좌 번호 없이 "발급됨" 만 오면 손님에게 보여 줄 계좌가 없다 — 입금 대기로도 두지 않는다
VA_NOACC="$(printf '{"orderNo":"%s","provider":"portone","providerTid":"%s-va","amount":0}' "$O1" "$O1")"
check "계좌 번호 없는 가상계좌 발급 응답은 받지 않는다" "$(code -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' -d "$VA_NOACC")" "402"
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

echo "── 가상계좌 — 발급은 입금 대기, 입금은 웹훅으로 (웹훅 내용은 믿지 않고 다시 조회)"
check "입금 기한은 1~720시간" "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"vaHours":0}')" "400"
check "가상계좌로 바꾼다 (기한 48시간)" \
  "$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"payMethod":"VIRTUAL_ACCOUNT","vaHours":48}' | jq_get "['payMethod']")" "VIRTUAL_ACCOUNT"
contains "결제창에 입금 기한을 넘긴다" "$(curl -s "$PO/config")" '"vaHours":48'
contains "결제창 스크립트가 계좌 기한을 싣는다" "$(curl -s -b "$B" "$API/api/render/page?path=shop/checkout")" "accountExpiry"
issue_va() {  # issue_va <paymentId> <금액> [만료 시각] — 결제창에서 계좌가 발급됐다
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/payments" -H 'content-type: application/json' \
    -d "{\"paymentId\":\"$1\",\"total\":$2,\"status\":\"VIRTUAL_ACCOUNT_ISSUED\",\"storeId\":\"store-brick-test\",\"virtualAccount\":{\"accountNumber\":\"56211234567890\",\"expiredAt\":\"${3:-2099-01-01T00:00:00Z}\"}}"
}
webhook() {  # webhook <paymentId> [storeId] → 상태코드
  code -X POST "$PO/webhook" -H 'content-type: application/json' \
    -d "{\"type\":\"Transaction.Paid\",\"timestamp\":\"2026-09-24T00:00:00Z\",\"data\":{\"paymentId\":\"$1\",\"storeId\":\"${2:-store-brick-test}\"}}"
}
deposit() { curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/deposit" -H 'content-type: application/json' -d "{\"paymentId\":\"$1\"}"; }
O_VA="$(mkorder 1)"
issue_va "$O_VA-va1" 14000
VA="$(confirm "$O_VA" "$O_VA-va1")"
contains "발급된 계좌를 손님에게 보여 준다 (은행 코드 → 이름)" "$VA" "신한은행 56211234567890 (예금주 브릭상점)"
contains "입금 기한도" "$VA" '"expiresAt":"'
check "주문은 아직 결제대기" "$(psql_q "SELECT status, payment_status FROM shop_orders WHERE order_no='$O_VA'")" "pending|unpaid"
check "결제는 입금 대기로 기록" "$(psql_q "SELECT p.status, p.va_account FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_VA'")" "waiting|56211234567890"
DETAIL="$(curl -s -b "$B" "$SHOP/orders/$O_VA")"
contains "주문 조회에서 계좌를 다시 본다" "$DETAIL" "56211234567890"
contains "입금 대기 주문에는 다시 결제를 내밀지 않는다 (계좌가 하나 더 생긴다)" "$DETAIL" '"payable":false'
sleep 1
check "입금 안내가 한 번 나간다 (계좌·기한)" "$(grep -c "가상계좌 입금 안내 ($O_VA)" "$TMP/api.log" || true)" "1"
confirm "$O_VA" "$O_VA-va1" >/dev/null
sleep 1
check "새로고침해도 안내는 다시 가지 않는다" "$(grep -c "가상계좌 입금 안내 ($O_VA)" "$TMP/api.log" || true)" "1"
check "새로고침해도 여전히 입금 대기" "$(psql_q "SELECT p.status FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_VA'")" "waiting"
# 결제 미완료 자동 취소(분)가 입금 기한 전에 가상계좌 주문을 지우면 안 된다
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/settings" -H 'content-type: application/json' \
  -d '{"shippingFee":3000,"freeShippingOver":50000,"pageSize":20,"returnShippingFee":3000,"unpaidCancelMinutes":30}'
psql_q "UPDATE shop_orders SET created_at = now() - interval '2 hours' WHERE order_no='$O_VA'" >/dev/null
curl -s -o /dev/null -b "$CK" -X POST "$SHOP/admin/orders/unpaid-sweep"
check "결제 미완료 규칙은 입금 대기 주문을 취소하지 않는다" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_VA'")" "pending"
check "입금 전 웹훅 — 받기는 한다" "$(webhook "$O_VA-va1")" "200"
check "입금 전이면 결제 완료가 아니다 (포트원에 다시 물었다)" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O_VA'")" "unpaid"
deposit "$O_VA-va1"
# 입금 통지가 왔는데 포트원 조회가 잠시 실패했다 — 입금 대기를 잃으면 다시 확정할 길이 없다
curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/fail-get" -H 'content-type: application/json' -d '{"n":1}'
check "조회가 잠시 실패한 통지 — 받기는 한다" "$(webhook "$O_VA-va1")" "200"
check "결제 완료는 아니다" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O_VA'")" "unpaid"
check "입금 대기를 잃지 않는다 (failed 가 되면 같은 거래를 다시 확정할 수 없다)" \
  "$(psql_q "SELECT p.status FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_VA'")" "waiting"
check "입금 뒤 웹훅 (포트원이 다시 보낸다)" "$(webhook "$O_VA-va1")" "200"
check "결제 완료" "$(psql_q "SELECT status, payment_status FROM shop_orders WHERE order_no='$O_VA'")" "paid|paid"
check "입금 대기 기록이 결제로 확정 (새 기록을 만들지 않는다)" "$(psql_q "SELECT count(*), max(p.status) FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_VA'")" "1|paid"
check "같은 웹훅이 다시 와도 그대로 (재전송)" "$(webhook "$O_VA-va1"; psql_q "SELECT count(*) FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_VA'")" "2001"

echo "── 웹훅은 믿지 않는다"
O_SP="$(mkorder 1)"
check "우리 결제 ID 모양이 아니면 무시" "$(curl -s -X POST "$PO/webhook" -H 'content-type: application/json' -d '{"data":{"paymentId":"../../etc"}}' | jq_get "['ignored']")" "paymentId"
OTHER_STORE="$(printf '{"data":{"paymentId":"%s-x1","storeId":"store-other"}}' "$O_SP")"
check "다른 상점의 통지는 무시" "$(curl -s -X POST "$PO/webhook" -H 'content-type: application/json' -d "$OTHER_STORE" | jq_get "['ignored']")" "storeId"
check "포트원에 없는 결제의 통지 — 받되" "$(webhook "$O_SP-fake1")" "200"
check "주문은 결제되지 않는다" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O_SP'")" "unpaid"

echo "── 카드로 결제하고 창을 닫은 손님 — 웹훅이 확정한다"
curl -s -o /dev/null -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"payMethod":"CARD"}'
O_CL="$(mkorder 1)"
paid_by_customer "$O_CL-c1" 14000
check "돌아오지 않았어도" "$(webhook "$O_CL-c1")" "200"
check "결제 완료로 확정된다" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O_CL'")" "paid"

echo "── 입금 기한이 지난 가상계좌"
O_EXP="$(mkorder 1)"
issue_va "$O_EXP-e1" 14000 "2020-01-01T00:00:00Z"
confirm "$O_EXP" "$O_EXP-e1" >/dev/null
curl -s -o /dev/null -b "$CK" -X POST "$SHOP/admin/orders/unpaid-sweep"
check "기한이 지나면 자동 취소 (재고를 돌려놓는다)" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_EXP'")" "cancelled"
contains "이유가 이력에 남는다" "$(psql_q "SELECT note FROM shop_order_events e JOIN shop_orders o ON o.id=e.order_id WHERE o.order_no='$O_EXP' ORDER BY e.created_at DESC LIMIT 1")" "가상계좌 입금 기한 경과"
check "닫힌 계좌는 더 이상 입금 대기가 아니다" "$(psql_q "SELECT p.status FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_EXP'")" "cancelled"

echo "── 운영자가 취소한 뒤 들어온 입금 — 모른 척하지 않는다"
O_LATE="$(mkorder 1)"
issue_va "$O_LATE-l1" 14000
confirm "$O_LATE" "$O_LATE-l1" >/dev/null
LATE_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_LATE'")"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$LATE_ID" -H 'content-type: application/json' -d '{"status":"cancelled"}'
deposit "$O_LATE-l1"
webhook "$O_LATE-l1" >/dev/null
check "주문은 취소 그대로" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_LATE'")" "cancelled"
check "들어온 돈은 환불을 시도했다" "$(po_last cancel paymentId)" "$O_LATE-l1"
# 가상계좌는 손님 계좌 없이 돌려줄 수 없다 — 자동 환불은 거절되고 운영자가 볼 수 있게 남는다
check "수동 환불이 필요하다고 기록한다" "$(psql_q "SELECT p.status || '|' || p.failure_reason FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_LATE'")" "paid|주문이 취소된 뒤 승인됨 — 환불 실패, 수동 환불 필요"
LATE_REF="$(printf '{"orderNo":"%s","refund_bank":"KAKAO","refund_account_no":"3333012345678","refund_holder":"늦은손님"}' "$O_LATE")"
check "운영자가 손님 계좌로 환불한다" "$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$LATE_REF" | jq_get "['refundedNow']")" "14000"
check "그때 기록이 환불로" "$(psql_q "SELECT p.status FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_LATE'")" "refunded"

echo "── 관리자가 결제된 주문을 취소·환불로 바꾸면 돈을 먼저 돌려준다"
# 전에는 상태만 바꿨다 — 카드 결제를 취소해도 PG 취소가 나가지 않았고, "환불" 로 바꾸면 환불액 0원인 채
# 손님에게 "환불이 완료되었습니다" 가 나갔다
O_ADM="$(mkorder 1)"; paid_by_customer "$O_ADM-ok" 14000; confirm "$O_ADM" "$O_ADM-ok" >/dev/null
ADM_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_ADM'")"
check "결제된 주문을 취소로" "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$ADM_ID" -H 'content-type: application/json' -d '{"status":"cancelled"}')" "200"
check "PG 에 전액 취소가 나갔다" "$(po_last cancel paymentId)" "$O_ADM-ok"
check "주문은 운영자가 고른 대로 취소" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_ADM'")" "cancelled"
check "결제 기록은 환불 (금액까지)" "$(psql_q "SELECT status, refunded_amount FROM shop_payments WHERE provider_tid='$O_ADM-ok'")" "refunded|14000"
O_ADM2="$(mkorder 1)"; paid_by_customer "$O_ADM2-ok" 14000; confirm "$O_ADM2" "$O_ADM2-ok" >/dev/null
ADM2_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_ADM2'")"
check "환불완료로" "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$ADM2_ID" -H 'content-type: application/json' -d '{"status":"refunded"}')" "200"
check "실제로 환불됐다" "$(psql_q "SELECT status, refunded_amount FROM shop_payments WHERE provider_tid='$O_ADM2-ok'")" "refunded|14000"
check "PG 에도" "$(po_last cancel paymentId)" "$O_ADM2-ok"
# 허용되지 않은 전이는 환불을 내보내기 **전에** 거절한다 — 돈이 나간 뒤 상태 전이가 막히면 어긋난다
O_SHIP="$(mkorder 1)"; paid_by_customer "$O_SHIP-ok" 14000; confirm "$O_SHIP" "$O_SHIP-ok" >/dev/null
SHIP_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_SHIP'")"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$SHIP_ID" -H 'content-type: application/json' -d '{"status":"preparing"}'
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$SHIP_ID" -H 'content-type: application/json' -d '{"status":"shipped"}'
check "배송중 → 취소는 허용되지 않는다" "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$SHIP_ID" -H 'content-type: application/json' -d '{"status":"cancelled"}')" "400"
check "그래서 환불도 나가지 않았다" "$(psql_q "SELECT status, refunded_amount FROM shop_payments WHERE provider_tid='$O_SHIP-ok'")" "paid|0"
# PG 가 취소를 거절하면 상태를 바꾸지 않는다
O_REJ="$(mkorder 1)"; paid_by_customer "$O_REJ-ok" 14000; confirm "$O_REJ" "$O_REJ-ok" >/dev/null
curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/phantom-cancel" -H 'content-type: application/json' -d "{\"paymentId\":\"$O_REJ-ok\",\"amount\":1000}"
REJ_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_REJ'")"
check "PG 가 거절한 환불" "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$REJ_ID" -H 'content-type: application/json' -d '{"status":"cancelled"}')" "402"
check "주문 상태는 그대로 (환불되지 않은 채 취소로 보이지 않는다)" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_REJ'")" "paid"

echo "── 입금된 가상계좌의 환불 — 손님 계좌가 있어야 한다"
VA_REF="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$(printf '{"orderNo":"%s"}' "$O_VA")")"
contains "계좌 없이는 무엇이 필요한지 먼저 말한다" "$VA_REF" "환불 받을 계좌"
check "PG 에 보내지 않았다" "$(python3 -c "
import json
print(sum(1 for l in open('$POLOG', encoding='utf-8') if json.loads(l).get('kind')=='cancel' and json.loads(l).get('paymentId')=='$O_VA-va1'))")" "0"
check "모르는 은행은 거절" "$(code -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$(printf '{"orderNo":"%s","refund_bank":"MOON","refund_account_no":"110123456789","refund_holder":"손님"}' "$O_VA")")" "400"
check "계좌번호 형식" "$(code -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$(printf '{"orderNo":"%s","refund_bank":"SHINHAN","refund_account_no":"12","refund_holder":"손님"}' "$O_VA")")" "400"
check "계좌를 주면 환불된다" "$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$(printf '{"orderNo":"%s","refund_bank":"shinhan","refund_account_no":"110-123-456789","refund_holder":"손님"}' "$O_VA")" | jq_get "['refundedNow']")" "14000"
contains "포트원에 환불 계좌를 실었다 (은행 코드·숫자만)" "$(python3 -c "
import json
hit=None
for l in open('$POLOG', encoding='utf-8'):
    m=json.loads(l)
    if m.get('kind')=='cancel' and m.get('paymentId')=='$O_VA-va1': hit=m
print(json.dumps(hit.get('refundAccount') if hit else None, ensure_ascii=False))")" '{"bank": "SHINHAN", "number": "110123456789", "holderName": "손님"}'

echo "── 손님이 취소 신청서에 환불 계좌를 적는다 (가상계좌 주문)"
O_VR="$(mkorder 1)"
issue_va "$O_VR-v1" 14000; confirm "$O_VR" "$O_VR-v1" >/dev/null; deposit "$O_VR-v1"; webhook "$O_VR-v1" >/dev/null
check "입금되어 결제 완료" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O_VR'")" "paid"
RETV="$(curl -s -b "$B" "$SHOP/orders/$O_VR/returnable")"
contains "신청 화면이 계좌 칸을 연다" "$RETV" '"needsRefundAccount":true'
VR_ITEM="$(echo "$RETV" | jq_get "['items'][0]['orderItemId']")"
ret_req() {  # ret_req <추가 JSON 조각> → 본문+상태
  curl -s -b "$B" -w ' %{http_code}' -X POST "$SHOP/orders/$O_VR/returns" -H 'content-type: application/json' \
    -d "$(printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}]%s}' "$VR_ITEM" "$1")"
}
R="$(ret_req "")"
[[ "$R" == *" 400" && "$R" == *"환불 받을 계좌"* ]] && ok "계좌 없이 신청하면 무엇이 필요한지 말한다" || bad "계좌 없는 신청 (${R:0:160})"
check "형식이 틀리면 거절" "$(ret_req ',"refund_bank":"SHINHAN","refund_account_no":"1","refund_holder":"손님"' | tail -c 3)" "400"
check "계좌를 적어 신청한다" "$(ret_req ',"refund_bank":"KOOKMIN","refund_account_no":"123-45-6789012","refund_holder":"구매자"' | tail -c 3)" "200"
RET_ID="$(psql_q "SELECT r.id FROM shop_returns r JOIN shop_orders o ON o.id=r.order_id WHERE o.order_no='$O_VR'")"
check "신청서에 계좌가 남는다 (숫자만)" "$(psql_q "SELECT refund_bank, refund_account FROM shop_returns WHERE id='$RET_ID'")" "KOOKMIN|123456789012"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/returns/$RET_ID" -H 'content-type: application/json' -d '{"status":"approved"}'
check "운영자가 완료 처리" "$(code -b "$CK" -X PUT "$SHOP/admin/returns/$RET_ID" -H 'content-type: application/json' -d '{"status":"completed"}')" "200"
contains "그 계좌로 포트원에 환불을 보냈다" "$(python3 -c "
import json
hit=None
for l in open('$POLOG', encoding='utf-8'):
    m=json.loads(l)
    if m.get('kind')=='cancel' and m.get('paymentId')=='$O_VR-v1': hit=m
print(json.dumps(hit.get('refundAccount') if hit else None, ensure_ascii=False))")" '"number": "123456789012"'
check "환불됐다" "$(psql_q "SELECT status FROM shop_payments WHERE provider_tid='$O_VR-v1'")" "refunded"
check "돌려준 뒤 계좌는 지운다" "$(psql_q "SELECT coalesce(refund_account, '(없음)') FROM shop_returns WHERE id='$RET_ID'")" "(없음)"
O_CARDRET="$(mkorder 1)"; paid_by_customer "$O_CARDRET-ok" 14000; confirm "$O_CARDRET" "$O_CARDRET-ok" >/dev/null
contains "카드 주문에는 계좌 칸을 열지 않는다" "$(curl -s -b "$B" "$SHOP/orders/$O_CARDRET/returnable")" '"needsRefundAccount":false'

echo "── 정기결제 (빌링키) — 설정"
BILLING="$(curl -s "$SHOP/billing/providers")"
absent "정기결제를 켜기 전에는 정기결제 수단에 없다" "$BILLING" '"portone"'
check "정기결제 채널 키 형식이 틀리면 거절" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"billingChannelKey":"abc"}')" "400"
check "채널 키 없이 정기결제를 켤 수 없다" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"billingEnabled":true}')" "400"
BILL_PUT="$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' \
  -d '{"billingEnabled":true,"billingChannelKey":"channel-key-billing-test"}')"
contains "정기결제를 켠다" "$BILL_PUT" '"billingEnabled":true'
contains "켜면 정기결제 수단에 뜬다" "$(curl -s "$SHOP/billing/providers")" '"portone"'
contains "공개 설정에 정기결제 채널 키 (카드 등록 창이 쓴다)" "$(curl -s "$PO/config")" "channel-key-billing-test"
# 일반 결제는 다른 PG 로 받고 정기결제만 포트원으로 — 카드 등록 화면이 창을 여는 스크립트를 실어야 한다
curl -s -o /dev/null -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"enabled":false}'
render_html() { curl -s -b "$B" "$API/api/render/page?path=$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'; }
CARDS_HTML="$(render_html shop/cards)"
contains "결제를 꺼도 카드 등록 화면은 포트원 빌링키 창을 싣는다" "$CARDS_HTML" "requestIssueBillingKey"
absent "주문서에는 싣지 않는다 (결제는 꺼져 있다)" "$(render_html shop/checkout)" "cdn.portone.io"
contains "정기결제만 켜도 정기결제 수단에 뜬다" "$(curl -s "$SHOP/billing/providers")" '"portone"'
curl -s -o /dev/null -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"enabled":true}'
READ_CARD="$(node -e '
  const html = process.argv[1];
  const i = html.indexOf("window.brickPay[\x27portone\x27].readCardReturn");
  const j = html.indexOf("};", i) + 2;
  const vm = require("node:vm");
  const window = { brickPay: { portone: {} } };
  vm.runInNewContext(html.slice(i, j), { window, URLSearchParams });
  const r = window.brickPay.portone.readCardReturn;
  console.log(JSON.stringify([
    r(new URLSearchParams("brickCard=portone&customerKey=cust-1&billingKey=bk-1")),
    r(new URLSearchParams("brickCard=portone&customerKey=cust-1&billingKey=bk-1&code=FAILURE_TYPE_PG&message=x")),
    r(new URLSearchParams("brickCard=portone&customerKey=cust-1")),
  ]));
' "$CARDS_HTML" 2>/dev/null || true)"
check "카드 등록 뒤 돌아온 주소 읽기 — 성공은 빌링키·고객 식별자, 실패·취소는 null" "$READ_CARD" \
  '[{"authKey":"bk-1","customerKey":"cust-1"},null,null]'

echo "── 정기결제 — 카드 등록은 이 회원에게 발급된 빌링키만"
prepare() { curl -s -b "$1" -X POST "$SHOP/me/billing-keys/prepare" | jq_get "['customerKey']"; }
bk_issued() {  # bk_issued <빌링키> <고객 식별자> [storeId] — 손님이 포트원 창에서 카드를 등록했다
  local body; body="$(printf '{"billingKey":"%s","customerId":"%s","storeId":"%s"}' "$1" "$2" "${3:-store-brick-test}")"
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/billing-keys" -H 'content-type: application/json' -d "$body"
}
register_card() {  # register_card <쿠키> <빌링키> <고객 식별자> → 본문 + 상태
  local body; body="$(printf '{"provider":"portone","authKey":"%s","customerKey":"%s"}' "$2" "$3")"
  curl -s -b "$1" -w ' %{http_code}' -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' -d "$body"
}
stub_ctl() { curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/$1" -H 'content-type: application/json' -d "$(printf '{"n":%s}' "$2")"; }
CUST="$(prepare "$B")"
[[ "$CUST" == cust-* ]] && ok "고객 식별자 발급 (내부 id 가 아니다)" || bad "고객 식별자 발급 ($CUST)"
check "고객 식별자는 회원마다 하나 — 다시 받아도 같다" "$(prepare "$B")" "$CUST"
bk_issued "bk-someone" "cust-someone-else"
R="$(register_card "$B" "bk-someone" "$CUST")"
[[ "$R" == *" 402" && "$R" == *"이 회원에게 발급된 빌링키가 아닙니다"* ]] && ok "다른 고객 식별자로 발급된 빌링키는 거절" || bad "고객 불일치 (${R:0:160})"
bk_issued "bk-otherstore" "$CUST" "store-other"
R="$(register_card "$B" "bk-otherstore" "$CUST")"
[[ "$R" == *" 402" && "$R" == *"다른 상점"* ]] && ok "다른 상점의 빌링키는 거절" || bad "다른 상점 (${R:0:160})"
check "포트원에 없는 빌링키는 거절" "$(register_card "$B" "bk-missing" "$CUST" | tail -c 3)" "402"
bk_issued "bk-b" "$CUST"
REG="$(register_card "$B" "bk-b" "$CUST")"
[[ "$REG" == *" 200" ]] && ok "카드 등록" || bad "카드 등록 (${REG:0:160})"
contains "카드 표시는 마스킹" "$REG" "****1234"
BK_ID="$(echo "${REG% *}" | jq_get "['id']")"
check "포트원에 빌링키를 직접 조회했다 (인증 헤더)" "$(po_last billing-key-get authOk)" "True"
# 남의 카드 등록 결과(빌링키 + 그 사람의 고객 식별자)는 돌아오는 주소에 실린다 — 들고 와도 붙일 수 없어야 한다
printf '{"email":"c@po.test","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"다른 회원"}' > "$TMP/c.json"
curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/c.json"
curl -s -o /dev/null -c "$TMP/c.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"c@po.test","password":"password123"}'
C="$TMP/c.txt"
R="$(register_card "$C" "bk-b" "$CUST")"
[[ "$R" == *" 400" && "$R" == *"처음부터"* ]] && ok "남의 고객 식별자로는 등록할 수 없다" || bad "남의 고객 식별자 (${R:0:160})"
check "남의 빌링키를 내 고객 식별자로 들고 와도 포트원 대조에서 거절" "$(register_card "$C" "bk-b" "$(prepare "$C")" | tail -c 3)" "402"
check "다른 회원 계정에 카드가 붙지 않았다" \
  "$(psql_q "SELECT count(*) FROM shop_billing_keys k JOIN users u ON u.id=k.user_id WHERE u.email='c@po.test'")" "0"

echo "── 정기결제 — 가입과 회차 청구"
curl -s -o /dev/null -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"po-sub","name":"포트원 정기배송","price":20000,"stock":50,"status":"selling","sub_interval":"month"}'
SUB_BODY="$(printf '{"productSlug":"po-sub","billingKeyId":"%s","orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$BK_ID")"
SUB="$(curl -s -b "$B" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' -d "$SUB_BODY")"
SUB_ID="$(echo "$SUB" | jq_get "['id']")"
SUB_O1="$(echo "$SUB" | jq_get "['orderNo']")"
[[ -n "$SUB_ID" ]] && ok "정기배송 가입" || bad "정기배송 가입 (${SUB:0:200})"
check "첫 회차 주문이 결제 완료" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$SUB_O1'")" "paid"
check "포트원에 빌링키로 청구했다 (금액 · 통화 · 고객 · 빌링키)" \
  "$(po_last billing-charge total)|$(po_last billing-charge currency)|$(po_last billing-charge customerId)|$(po_last billing-charge billingKey)" "23000|KRW|$CUST|bk-b"
PID1="$(po_last billing-charge paymentId)"
[[ "$PID1" == "$SUB_O1-"* ]] && ok "결제 ID 가 회차 주문번호로 시작한다 (조회·취소·웹훅이 주문을 찾는다)" || bad "결제 ID ($PID1 / $SUB_O1)"
check "결제 기록 (결제 ID · 금액 · 수단)" \
  "$(psql_q "SELECT provider, amount, method FROM shop_payments WHERE provider_tid='$PID1' AND status='paid'")" "portone|23000|카드(정기결제)"
due()   { psql_q "UPDATE shop_subscriptions SET next_charge_at = now() - interval '1 hour' WHERE id='$SUB_ID'" >/dev/null; }
sweep() { curl -s -b "$CK" -X POST "$SHOP/admin/subscriptions/sweep"; }
sub_state() { psql_q "SELECT cycle_no, fail_count, status FROM shop_subscriptions WHERE id='$SUB_ID'"; }
due
contains "결제일이 되면 청구한다" "$(sweep)" '"charged":1'
check "2회차로 전진" "$(sub_state)" "2|0|active"
PID2="$(po_last billing-charge paymentId)"
[[ -n "$PID2" && "$PID2" != "$PID1" ]] && ok "회차마다 다른 결제 ID" || bad "회차 결제 ID ($PID1 / $PID2)"

echo "── 정기결제 — 카드사 거절"
stub_ctl fail-charge 1; due
contains "거절은 실패로 센다" "$(sweep)" '"failed":1'
check "회차는 그대로, 실패 1회" "$(sub_state)" "2|1|active"
contains "손님이 읽는 실패 이유는 카드사의 문장" \
  "$(psql_q "SELECT detail FROM shop_subscription_events WHERE subscription_id='$SUB_ID' AND kind='failed' ORDER BY created_at DESC LIMIT 1")" "한도"
due
contains "카드를 고치면 다음 청구가 된다 (실패한 시도의 결제 ID 에 묶이지 않는다)" "$(sweep)" '"charged":1'
check "3회차로 전진 · 실패 횟수 초기화" "$(sub_state)" "3|0|active"

echo "── 정기결제 — 청구는 됐는데 응답을 잃었다"
stub_ctl lose-charge 1; due
contains "조회로 결제를 확인해 성공으로 마친다" "$(sweep)" '"charged":1'
check "4회차로 전진 (실패로 세지 않는다)" "$(sub_state)" "4|0|active"
PID_L="$(po_last billing-charge paymentId)"
check "그 회차의 청구는 한 번 (다시 청구하지 않았다)" \
  "$(python3 -c "
import json
print(sum(1 for l in open('$POLOG', encoding='utf-8') if json.loads(l).get('kind')=='billing-charge' and json.loads(l).get('paymentId')=='$PID_L'))")" "1"
check "결제 기록이 결제 완료" "$(psql_q "SELECT status FROM shop_payments WHERE provider_tid='$PID_L'")" "paid"

echo "── 정기결제 — 응답도 조회도 잃으면 '처리 중' — 주문을 건드리지 않는다"
stub_ctl lose-charge 1; stub_ctl fail-get 1; due
SW="$(sweep)"
contains "실패로 세지 않는다" "$SW" '"failed":0'
check "회차도 실패 횟수도 그대로" "$(sub_state)" "4|0|active"
PID_P="$(po_last billing-charge paymentId)"
O_P="${PID_P%-*}"
check "그 회차 주문을 취소하지 않는다 (카드는 긁혔다)" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_P'")" "pending"
contains "다음 청구가 같은 결제 ID 로 다시 묻고 '이미 결제됨' 을 성공으로 읽는다" "$(sweep)" '"charged":1'
check "같은 결제 ID 로 다시 보냈다" "$(po_last billing-charge paymentId)" "$PID_P"
check "그 주문이 결제 완료 · 5회차로 전진" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_P'")|$(sub_state)" "paid|5|0|active"
check "그 회차의 결제 기록은 하나" "$(psql_q "SELECT count(*) FROM shop_payments WHERE provider_tid='$PID_P' AND status='paid'")" "1"

echo "── 정기결제 — 청구 응답보다 결제 완료 웹훅이 먼저 왔다"
# 포트원은 웹훅과 API 응답의 순서를 보장하지 않는다 — 스텁이 청구 도중(응답 전)에 웹훅을 보낸다
webhook_mid() {
  local body; body="$(printf '{"url":"%s/webhook"}' "$PO")"
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/webhook-during-charge" -H 'content-type: application/json' -d "$body"
}
webhook_mid; due
SW="$(sweep)"
PID_W="$(po_last billing-charge paymentId)"; O_W="${PID_W%-*}"
check "웹훅이 실제로 청구 도중에 왔다" "$(po_last webhook-sent paymentId)" "$PID_W"
contains "웹훅이 먼저 확정해도 이 회차는 청구 성공이다" "$SW" '"charged":1'
contains "실패로 세지 않는다" "$SW" '"failed":0'
check "6회차로 전진" "$(sub_state)" "6|0|active"
check "주문은 결제 완료" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_W'")" "paid"
check "한 거래를 두 번 적지 않고 끝나지 않은 기록도 남기지 않는다" \
  "$(psql_q "SELECT string_agg(p.status, ',') FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_W'")" "paid"

echo "── 정기결제 — 가입 첫 결제에서도 웹훅이 먼저 왔다"
webhook_mid
SUB2="$(curl -s -b "$B" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' -d "$SUB_BODY")"
SUB2_ID="$(echo "$SUB2" | jq_get "['id']")"; SUB2_O="$(echo "$SUB2" | jq_get "['orderNo']")"
[[ -n "$SUB2_ID" ]] && ok "가입은 성공한다" || bad "웹훅이 먼저 온 가입 (${SUB2:0:200})"
check "첫 회차 결제 완료 · 다음 결제일이 잡혔다" \
  "$(psql_q "SELECT o.status, (s.next_charge_at IS NOT NULL) AS dated FROM shop_subscriptions s, shop_orders o WHERE s.id='$SUB2_ID' AND o.order_no='$SUB2_O'")" "paid|true"
check "결제 기록은 하나" \
  "$(psql_q "SELECT string_agg(p.status, ',') FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$SUB2_O'")" "paid"

echo "── 정기결제 — 가입 첫 결제의 결과를 모르면 스윕이 이어서 끝낸다"
stub_ctl lose-charge 1; stub_ctl fail-get 1
R="$(curl -s -b "$B" -w ' %{http_code}' -X POST "$SHOP/subscriptions" -H 'content-type: application/json' -d "$SUB_BODY")"
[[ "$R" == *" 409" && "$R" == *"처리 중"* ]] && ok "가입 응답은 '처리 중' (카드는 긁혔을 수 있다)" || bad "처리 중 가입 (${R:0:160})"
PID_3="$(po_last billing-charge paymentId)"; O_3="${PID_3%-*}"
SUB3_ID="$(psql_q "SELECT s.id FROM shop_subscriptions s JOIN shop_orders o ON o.idempotency_key = 'sub-' || s.id || '-c1' WHERE o.order_no='$O_3'")"
check "구독은 첫 결제 확인 전 (다음 결제일 없음)" "$(psql_q "SELECT status, (next_charge_at IS NULL) AS undated FROM shop_subscriptions WHERE id='$SUB3_ID'")" "active|true"
check "주문은 건드리지 않는다" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_3'")" "pending"
sweep >/dev/null
check "막 가입한 것은 바로 집지 않는다 (가입 요청이 아직 돌고 있을 수 있다)" "$(psql_q "SELECT (next_charge_at IS NULL) AS undated FROM shop_subscriptions WHERE id='$SUB3_ID'")" "true"
psql_q "UPDATE shop_subscriptions SET created_at = now() - interval '10 minutes' WHERE id='$SUB3_ID'" >/dev/null
sweep >/dev/null
check "스윕이 첫 결제를 확인해 구독을 연다" "$(psql_q "SELECT status, (next_charge_at IS NOT NULL) AS dated, cycle_no FROM shop_subscriptions WHERE id='$SUB3_ID'")" "active|true|1"
check "첫 회차 주문 결제 완료" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_3'")" "paid"
check "첫 회차 이력" "$(psql_q "SELECT count(*) FROM shop_subscription_events WHERE subscription_id='$SUB3_ID' AND kind='charged' AND cycle_no=1")" "1"
check "같은 결제 ID 로 다시 물었다 (새로 긁지 않았다)" "$(po_last billing-charge paymentId)" "$PID_3"
check "결제 기록은 하나" \
  "$(psql_q "SELECT string_agg(p.status, ',') FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_3'")" "paid"

echo "── 정기결제 — 가입 첫 결제가 끊겼고 다시 해 봐도 거절되면 가입하지 않은 것으로"
stub_ctl drop-charge 1
R="$(curl -s -b "$B" -w ' %{http_code}' -X POST "$SHOP/subscriptions" -H 'content-type: application/json' -d "$SUB_BODY")"
[[ "$R" == *" 409" ]] && ok "끊긴 첫 결제 — '처리 중'" || bad "끊긴 첫 결제 (${R:0:160})"
PID_4="$(po_last billing-charge paymentId)"; O_4="${PID_4%-*}"
SUB4_ID="$(psql_q "SELECT s.id FROM shop_subscriptions s JOIN shop_orders o ON o.idempotency_key = 'sub-' || s.id || '-c1' WHERE o.order_no='$O_4'")"
psql_q "UPDATE shop_subscriptions SET created_at = now() - interval '10 minutes' WHERE id='$SUB4_ID'" >/dev/null
STOCK_BEFORE="$(psql_q "SELECT stock FROM shop_products WHERE slug='po-sub'")"
stub_ctl fail-charge 1
sweep >/dev/null
check "구독은 해지 (가입하지 않은 것으로)" "$(psql_q "SELECT status, (next_charge_at IS NULL) AS undated FROM shop_subscriptions WHERE id='$SUB4_ID'")" "cancelled|true"
contains "손님이 읽는 이유가 남는다 (내 정기배송)" "$(psql_q "SELECT coalesce(pause_reason, '') FROM shop_subscriptions WHERE id='$SUB4_ID'")" "한도"
check "첫 회차 주문은 취소되고 재고가 돌아온다" \
  "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_4'")|$(psql_q "SELECT stock - $STOCK_BEFORE FROM shop_products WHERE slug='po-sub'")" "cancelled|1"


echo "── 정기결제 — 첫 결제를 모르는 사이 결제되고 환불된 주문은 다시 청구하지 않는다"
stub_ctl lose-charge 1; stub_ctl fail-get 1
curl -s -o /dev/null -b "$B" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' -d "$SUB_BODY"
PID_5="$(po_last billing-charge paymentId)"; O_5="${PID_5%-*}"
SUB5_ID="$(psql_q "SELECT s.id FROM shop_subscriptions s JOIN shop_orders o ON o.idempotency_key = 'sub-' || s.id || '-c1' WHERE o.order_no='$O_5'")"
check "통지(웹훅)가 그 첫 회차를 결제 완료로" "$(webhook "$PID_5"; echo; psql_q "SELECT status FROM shop_orders WHERE order_no='$O_5'")" "$(printf '200\npaid')"
REFUND5="$(printf '{"orderNo":"%s","reason":"시험 환불"}' "$O_5")"
check "운영자가 그 주문을 환불" "$(code -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' -d "$REFUND5")" "200"
check "주문은 환불 상태" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_5'")" "refunded"
psql_q "UPDATE shop_subscriptions SET created_at = now() - interval '10 minutes' WHERE id='$SUB5_ID'" >/dev/null
CHARGES_5="$(po_count billing-charge)"
sweep >/dev/null
check "환불된 첫 회차는 다시 청구하지 않는다" "$(po_count billing-charge)" "$CHARGES_5"
check "그 가입은 거둔다 (해지)" "$(psql_q "SELECT status, (next_charge_at IS NULL) AS undated FROM shop_subscriptions WHERE id='$SUB5_ID'")" "cancelled|true"

echo "── 정기결제 — 통지 쪽 기록이 멈췄으면 청구가 이어받아 끝낸다"
CYCLE_BEFORE="$(psql_q "SELECT cycle_no FROM shop_subscriptions WHERE id='$SUB_ID'")"
stub_ctl lose-charge 1; stub_ctl fail-get 1; due
sweep >/dev/null
PID_S="$(po_last billing-charge paymentId)"; O_S="${PID_S%-*}"
check "처리 중 — 그 회차 주문은 결제대기" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_S'")" "pending"
# 통지가 같은 거래를 기록하다 멈춘 모습 — 거래 번호가 붙은 'requested' 기록 (먼저 방금 쓴 것 — 이어받지 않는다)
psql_q "INSERT INTO shop_payments (id, order_id, provider, provider_tid, status, amount) SELECT gen_random_uuid(), id, 'portone', '$PID_S', 'requested', total FROM shop_orders WHERE order_no='$O_S'" >/dev/null
SW="$(sweep)"
contains "통지 쪽이 아직 쓰는 중이면 기다린다 (실패로 세지 않는다)" "$SW" '"failed":0'
check "그 주문은 아직 결제대기" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_S'")" "pending"
psql_q "UPDATE shop_payments SET updated_at = now() - interval '10 minutes' WHERE provider_tid='$PID_S'" >/dev/null
contains "10분째 멈춘 기록은 이어받아 청구를 끝낸다" "$(sweep)" '"charged":1'
check "그 주문이 결제 완료 · 회차가 한 칸 나아간다" \
  "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O_S'")|$(psql_q "SELECT cycle_no - $CYCLE_BEFORE FROM shop_subscriptions WHERE id='$SUB_ID'")" "paid|1"
check "결제 기록은 하나 (이어받은 기록이 결제 완료)" \
  "$(psql_q "SELECT string_agg(p.status, ',') FROM shop_payments p JOIN shop_orders o ON o.id=p.order_id WHERE o.order_no='$O_S'")" "paid"

echo "── 환불 전에 탈퇴하면 신청서의 계좌도 지운다"
O_WD="$(mkorder 1)"
issue_va "$O_WD-w1" 14000; confirm "$O_WD" "$O_WD-w1" >/dev/null; deposit "$O_WD-w1"; webhook "$O_WD-w1" >/dev/null
WD_ITEM="$(curl -s -b "$B" "$SHOP/orders/$O_WD/returnable" | jq_get "['items'][0]['orderItemId']")"
WD_REQ="$(printf '{"kind":"cancel","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":1}],"refund_bank":"WOORI","refund_account_no":"1002123456789","refund_holder":"구매자"}' "$WD_ITEM")"
check "계좌를 적어 신청 (아직 처리 전)" "$(code -b "$B" -X POST "$SHOP/orders/$O_WD/returns" -H 'content-type: application/json' -d "$WD_REQ")" "200"
contains "탈퇴" "$(curl -s -b "$B" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' -d '{"password":"password123","deletePosts":false}')" '"ok":true'
check "신청서의 계좌가 남지 않는다" "$(psql_q "SELECT coalesce(r.refund_account, '(없음)') FROM shop_returns r JOIN shop_orders o ON o.id=r.order_id WHERE o.order_no='$O_WD'")" "(없음)"

echo "── 탈퇴한 회원의 카드로 청구를 이어 가지 않는다"
check "정기배송이 해지된다" "$(psql_q "SELECT status, (next_charge_at IS NULL) FROM shop_subscriptions WHERE id='$SUB_ID'")" "cancelled|true"
check "해지 이력이 남는다" "$(psql_q "SELECT count(*) FROM shop_subscription_events WHERE subscription_id='$SUB_ID' AND kind='cancelled'")" "1"
check "빌링키(청구에 쓰는 값)가 지워진다 — 카드 표시는 남는다" \
  "$(psql_q "SELECT billing_key = '' AS erased, revoked_at IS NOT NULL AS revoked, card_label FROM shop_billing_keys WHERE id='$BK_ID'")" "true|true|신한카드 ****1234"
check "고객 식별자도 지워진다" "$(psql_q "SELECT count(*) FROM shop_billing_customers WHERE customer_key='$CUST'")" "0"
# 해지 전에 남은 구독(이 수정 전에 탈퇴한 회원)이 있어도 청구하지 않는다
psql_q "UPDATE shop_subscriptions SET status='active', next_charge_at = now() - interval '1 hour' WHERE id='$SUB_ID'" >/dev/null
CHARGES_BEFORE="$(po_count billing-charge)"
contains "스윕이 탈퇴한 회원의 구독을 집지 않는다" "$(sweep)" '"due":0'
check "포트원에 청구가 나가지 않았다" "$(po_count billing-charge)" "$CHARGES_BEFORE"

echo "── 시크릿이 새지 않는다"
absent "서버 로그에 시크릿이 없다" "$(cat "$TMP/api.log")" "SECRET_VALUE_DO_NOT_LEAK"
absent "결제 기록(raw)에 시크릿이 없다" "$(psql_q "SELECT raw::text FROM shop_payments")" "SECRET_VALUE_DO_NOT_LEAK"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
# 실측을 남긴다(설정됐을 때만) — README 의 표가 실제와 같은지 CI 가 대조한다.
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 포트원으로 나간 요청 ──"; cat "$POLOG"; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
