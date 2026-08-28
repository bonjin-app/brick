#!/usr/bin/env bash
#
# 결제 게이트웨이 E2E 스모크 — 스텁 PG 로 **실제로 무엇이 나가는지** 본다.
#
# 왜 이 수트가 필요한가: 부분 환불 금액이 PG 에 전달되는 경로는 있었지만
# **검증이 없었다.** 무통장 게이트웨이의 cancel() 은 인자를 무시하고 성공을
# 반환하고, 모든 수트가 무통장만 썼다. 그래서 "10,000원 반품에 22,000원을
# 환불 요청" 같은 버그가 있어도 전부 통과했을 것이다.
#
# 못박는 것:
#   - 부분 환불에 **정확한 금액**이 PG 로 가는가
#   - 전액 환불에는 금액을 **보내지 않는가** (토스 규약: 없으면 전액)
#   - 누적 환불이 승인 금액을 넘지 않는가 (PG 가 거절하기 전에 우리가 막는가)
#   - PG 가 다른 금액을 승인하면 결제를 거부하는가 (금액 위조 방어)
#   - 멱등키를 보내는가 (재시도로 이중 승인/이중 취소되지 않게)
#   - 시크릿 키가 응답이나 로그로 새지 않는가
#   - https 아닌 PG 주소를 운영에서 거부하는가
#
# 개인결제(주문서 없는 청구)도 여기서 본다:
#   - 결제하면 **주문이 만들어지는가** (안 만들면 매출·세금 자료에서 빠진다)
#   - 링크 토큰이 추측 불가능한가 (청구번호로는 남의 청구서를 열 수 있다)
#   - 만료·취소된 청구서로 결제할 수 없는가
#   - 새로고침으로 주문이 여러 개 생기지 않는가
#   - 재고를 건드리지 않는가 (상품이 없는 주문이다)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-payments.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TOSS="$API/api/plugins/brick-pay-toss"
PG_PORT=42625
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PGLOG="$TMP/pg.jsonl"
PASS=0; FAIL=0

cleanup() {
  # 진입 시점의 종료 코드를 보존한다.
  #
  # kill 한 백그라운드 프로세스를 `wait` 하면 그 종료 코드(143 = SIGTERM)가
  # 스크립트의 종료 코드가 되고, 뒤에서 `exit 0` 을 해도 덮이지 않는다.
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${PG_PID:-}" ]]; then kill "$PG_PID" 2>/dev/null; wait "$PG_PID" 2>/dev/null || true; fi
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

# PG 로 나간 요청을 읽는다
pg_calls() { python3 -c "
import json, sys
for line in open('$PGLOG', encoding='utf-8'):
    m = json.loads(line)
    if m.get('kind') in ('confirm', 'cancel'):
        print(json.dumps(m, ensure_ascii=False))
"; }
pg_last() {  # pg_last <kind> <필드>
  python3 -c "
import json, sys
found = None
for line in open('$PGLOG', encoding='utf-8'):
    m = json.loads(line)
    if m.get('kind') == sys.argv[1]:
        found = m
print('' if found is None else found.get(sys.argv[2], ''))
" "$1" "$2"
}
pg_count() { python3 -c "
import json
n = 0
for line in open('$PGLOG', encoding='utf-8'):
    if json.loads(line).get('kind') == '$1': n += 1
print(n)
"; }

echo "▶ 결제 게이트웨이 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

echo "── 스텁 PG 시작"
# 이전 실행의 스텁이 포트를 잡고 있으면 우리 기록이 비어 있는데도 통과한다
pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
  fi
}
for p in $(pids_on_port "$PG_PORT"); do kill -9 "$p" 2>/dev/null || true; done

node "$ROOT/scripts/pg-stub.mjs" --port "$PG_PORT" --out "$PGLOG" > "$TMP/pg.log" 2>&1 &
PG_PID=$!
for i in $(seq 1 30); do
  grep -q 'listening' "$TMP/pg.log" 2>/dev/null && break
  kill -0 "$PG_PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$PG_PID" 2>/dev/null && [[ "$(pids_on_port "$PG_PORT")" == *"$PG_PID"* ]]; then
  ok "스텁 PG 시작 (우리 프로세스가 듣고 있다)"
else
  bad "스텁 PG 시작 ($(tail -2 "$TMP/pg.log" 2>/dev/null))"
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-pay-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_TIMEZONE="Asia/Seoul"
# 테스트 전용 — 스텁 PG 로 돌린다
export BRICK_TOSS_API_BASE="http://127.0.0.1:${PG_PORT}/v1"

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
    -d '{"siteName":"결제","adminEmail":"admin@pay.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@pay.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-pay-toss; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done

printf '{"email":"b@pay.test","password":"password123",%s"displayName":"구매자"}' "$CONSENT" > "$TMP/reg.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
curl -s -c "$TMP/b.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"b@pay.test","password":"password123"}' >/dev/null
B="$TMP/b.txt"

echo "── 토스 설정 (키를 넣기 전에는 결제수단으로 뜨지 않는다)"
METHODS="$(curl -s "$SHOP/payment-methods")"
absent "설정 전에는 목록에 없다" "$METHODS" '"toss"'
contains "설정" "$(curl -s -b "$CK" -X PUT "$TOSS/admin/config" -H 'content-type: application/json' \
  -d '{"secretKey":"test_sk_SECRET_VALUE_DO_NOT_LEAK","clientKey":"test_ck_public","enabled":true}')" '"ok":true'
METHODS="$(curl -s "$SHOP/payment-methods")"
contains "설정 후 목록에 뜬다" "$METHODS" '"toss"'

echo "── 시크릿 키가 새지 않는다"
PUB="$(curl -s "$TOSS/config")"
contains "공개 설정에 클라이언트 키는 있다" "$PUB" "test_ck_public"
absent "시크릿 키는 없다" "$PUB" "SECRET_VALUE_DO_NOT_LEAK"
ADMIN_CFG="$(curl -s -b "$CK" "$TOSS/admin/config")"
absent "관리 조회에도 시크릿 원문이 없다" "$ADMIN_CFG" "SECRET_VALUE_DO_NOT_LEAK"
absent "서버 로그에도 없다" "$(cat "$TMP/api.log")" "SECRET_VALUE_DO_NOT_LEAK"
absent "PG 기록에도 키 값이 없다" "$(cat "$PGLOG")" "SECRET_VALUE_DO_NOT_LEAK"

echo "── 준비: 상품과 주문"
P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"pay-item","name":"결제테스트 상품","price":11000,"stock":100,"status":"selling"}' | jq_get "['id']")"
[[ -n "$P" ]] && ok "상품 등록" || bad "상품 등록"

mkorder() {  # mkorder <수량> → orderNo
  printf '{"items":[{"productId":"%s","quantity":%s}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" "$1" > "$TMP/mk.json"
  curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json" | jq_get "['orderNo']"
}

echo "══ 승인: PG 응답 금액을 신뢰하지 않는다 ══"
# 11,000 × 2 = 22,000 + 배송비 3,000 = 25,000
O1="$(mkorder 2)"
check "주문 금액 25000" "$(psql_q "SELECT total FROM shop_orders WHERE order_no='$O1'")" "25000"

echo "── PG 가 승인한 금액이 주문 금액과 다르면 결제를 취소한다 (금액 위조 방어)"
# 클라이언트가 낮은 금액을 주장하면 PG 는 그 금액으로 승인한다.
# 그것을 그대로 받으면 25,000원짜리를 1,000원에 팔게 된다.
# brick-shop 은 PG 응답 금액을 **DB 의 주문 금액과 대조**하고, 다르면
# 승인된 결제를 즉시 취소해야 한다 — 돈만 받고 주문은 미결제로 남으면 안 된다.
CONF_LOW="$(curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"provider\":\"toss\",\"providerTid\":\"pk_low\",\"amount\":1000}")"
contains "금액 불일치를 거부한다" "$CONF_LOW" "일치하지 않습니다"
contains "승인된 결제를 취소했다고 알린다" "$CONF_LOW" "결제를 취소했습니다"
check "PG 로 1000 이 갔다 (클라이언트가 주장한 금액)" "$(pg_last confirm requestedAmount)" "1000"
# 그리고 즉시 취소되었어야 한다 — 안 하면 손님 돈 1,000원이 사업자에게 남는다
check "잘못 승인된 결제를 취소했다" "$(pg_last cancel paymentKey)" "pk_low"
check "주문은 미결제 그대로" "$(psql_q "SELECT payment_status FROM shop_orders WHERE order_no='$O1'")" "unpaid"

echo "── 정상 승인"
BEFORE_CONFIRMS="$(pg_count confirm)"
CONF="$(curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"provider\":\"toss\",\"providerTid\":\"pk_o1\",\"amount\":25000}")"
contains "승인됨" "$CONF" '"ok":true'
contains "금액을 돌려준다" "$CONF" '"amount":25000'
check "PG 에 승인 요청이 갔다" "$(pg_count confirm)" "$((BEFORE_CONFIRMS + 1))"
check "PG 로 보낸 금액이 주문 금액과 같다" "$(pg_last confirm requestedAmount)" "25000"
check "인증 헤더를 보냈다" "$(pg_last confirm hasAuth)" "True"
IDEM="$(pg_last confirm idemKey)"
[[ -n "$IDEM" && "$IDEM" != "None" ]] && ok "멱등키를 보냈다 ($IDEM)" || bad "멱등키를 보냈다"
PAID="$(psql_q "SELECT payment_status, paid_at IS NOT NULL, status FROM shop_orders WHERE order_no='$O1'")"
check "주문이 결제완료로 전이" "$PAID" "paid|true|paid"
check "결제 기록 저장" "$(psql_q "SELECT provider, amount, refunded_amount, status FROM shop_payments WHERE provider_tid='pk_o1'")" "toss|25000|0|paid"

echo "── 같은 주문을 두 번 승인할 수 없다 (이중 승인)"
DUP="$(curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"provider\":\"toss\",\"providerTid\":\"pk_o1_again\",\"amount\":25000}")"
contains "거부한다" "$DUP" "이미"
check "PG 를 다시 부르지 않았다" "$(pg_count confirm)" "$((BEFORE_CONFIRMS + 1))"

echo "══ 부분 환불: 정확한 금액이 PG 로 가는가 ══"
# 이것이 이 수트의 존재 이유다. 지금까지 아무도 확인하지 않았다.
RES="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":11000,\"reason\":\"부분 환불 검증\"}")"
contains "부분 환불 성공" "$RES" '"refundedNow":11000'
contains "누적도 11000" "$RES" '"refunded":11000'
contains "남은 금액을 알려준다" "$RES" '"remaining":14000'
PART_CANCELS="$(pg_count cancel)"
[[ "$PART_CANCELS" -ge 2 ]] && ok "PG 에 취소 요청이 갔다" || bad "PG 에 취소 요청이 갔다 ($PART_CANCELS)"
check "PG 로 보낸 취소 금액이 정확히 11000" "$(pg_last cancel cancelAmount)" "11000"
contains "사유도 전달했다" "$(pg_last cancel cancelReason)" "부분 환불 검증"
check "결제 기록에 누적" "$(psql_q "SELECT refunded_amount, status FROM shop_payments WHERE provider_tid='pk_o1'")" "11000|partial_refunded"
check "주문은 환불 상태가 아니다 (부분이므로)" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O1'")" "paid"

echo "── 남은 금액을 넘는 환불은 PG 를 부르기 전에 막는다"
BEFORE_CANCELS="$(pg_count cancel)"
OVER="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":99000,\"reason\":\"초과\"}")"
contains "초과를 거부한다" "$OVER" "초과"
contains "가능 금액을 알려준다" "$OVER" "14,000"
check "PG 를 부르지 않았다 (부르면 PG 가 거절하고 로그가 더러워진다)" "$(pg_count cancel)" "$BEFORE_CANCELS"

echo "── 전액 환불에는 금액을 보내지 않는다 (토스 규약: 없으면 전액)"
FULL="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"reason\":\"나머지 전액\"}")"
contains "이번에 나간 금액은 14000" "$FULL" '"refundedNow":14000'
contains "누적은 25000" "$FULL" '"refunded":25000'
check "PG 취소 요청이 한 번 늘었다" "$(pg_count cancel)" "$((PART_CANCELS + 1))"
# 금액을 명시하면 PG 가 "부분 취소"로 처리하고 잔액이 남을 수 있다.
# 남은 전액일 때는 생략하는 것이 맞다.
check "마지막 취소에는 금액이 없다 (null = 전액)" "$(pg_last cancel cancelAmount)" "None"
check "결제가 전액 환불 상태" "$(psql_q "SELECT refunded_amount, status FROM shop_payments WHERE provider_tid='pk_o1'")" "25000|refunded"
check "주문도 환불 상태로 전이" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O1'")" "refunded"
check "재고가 복원됨 (100)" "$(psql_q "SELECT stock FROM shop_products WHERE id='$P'")" "100"

echo "── 다 환불한 뒤에는 더 환불할 수 없다"
BEFORE_CANCELS="$(pg_count cancel)"
NOMORE="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O1\",\"amount\":1000,\"reason\":\"또\"}")"
contains "환불할 내역이 없다고 한다" "$NOMORE" "환불"
check "PG 를 부르지 않았다" "$(pg_count cancel)" "$BEFORE_CANCELS"

echo "══ 반품이 PG 에 보내는 금액 ══"
# 반품 흐름은 내부에서 금액을 계산해 refundPayment 로 넘긴다.
# 할인이 있으면 안분되므로, 그 값이 그대로 PG 에 가는지 본다.
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"pay2000","name":"2천원","discount_type":"fixed","discount_value":2000}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":2}],"couponCode":"pay2000","orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" > "$TMP/o2.json"
O2="$(curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o2.json" | jq_get "['orderNo']")"
# 22,000 − 2,000 + 3,000 = 23,000
check "할인 주문 금액 23000" "$(psql_q "SELECT subtotal, discount, total FROM shop_orders WHERE order_no='$O2'")" "22000|2000|23000"
curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O2\",\"provider\":\"toss\",\"providerTid\":\"pk_o2\",\"amount\":23000}" >/dev/null
psql_q "UPDATE shop_orders SET status='delivered', delivered_at=now() WHERE order_no='$O2'" >/dev/null

ITEM2="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O2'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM2" > "$TMP/ret.json"
RID="$(curl -s -b "$B" -X POST "$SHOP/orders/$O2/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret.json" | jq_get "['id']")"
# 할인 안분: 2개 중 1개 → 11,000 − 1,000 = 10,000
check "반품 예정 환불액 10000 (할인 안분)" "$(psql_q "SELECT refund_amount FROM shop_returns WHERE id='$RID'")" "10000"
BEFORE_CANCELS="$(pg_count cancel)"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\"}" >/dev/null
done
check "PG 취소 요청이 한 번 늘었다" "$(pg_count cancel)" "$((BEFORE_CANCELS + 1))"
check "PG 로 간 금액이 정확히 10000 (11000 이 아니다)" "$(pg_last cancel cancelAmount)" "10000"
check "결제 기록에도 10000" "$(psql_q "SELECT refunded_amount, status FROM shop_payments WHERE provider_tid='pk_o2'")" "10000|partial_refunded"
check "주문은 배송완료 그대로 (부분 반품)" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O2'")" "delivered"

echo "── 남은 1개도 반품하면 나머지가 나간다"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM2" > "$TMP/ret2.json"
RID2="$(curl -s -b "$B" -X POST "$SHOP/orders/$O2/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret2.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID2" -H 'content-type: application/json' \
    -d "{\"status\":\"$st\"}" >/dev/null
done
check "두 번째도 10000" "$(pg_last cancel cancelAmount)" "10000"
# 23,000 중 20,000 을 환불했다 — 배송비 3,000 은 남는다(상품은 배송되었다)
check "누적 환불 20000, 배송비는 남는다" "$(psql_q "SELECT refunded_amount FROM shop_payments WHERE provider_tid='pk_o2'")" "20000"
SUM_CHECK="$(psql_q "SELECT (SELECT sum(refund_amount) FROM shop_returns WHERE order_id=(SELECT id FROM shop_orders WHERE order_no='$O2') AND status='completed') = (SELECT refunded_amount FROM shop_payments WHERE provider_tid='pk_o2')")"
check "반품 환불액 합계 == PG 환불 누적 (어긋나면 돈이 새거나 남는다)" "$SUM_CHECK" "true"

echo "══ 멱등키: 재시도로 이중 취소되지 않는다 ══"
# 같은 금액의 같은 결제에 대한 취소는 같은 키를 쓴다 —
# 네트워크 재시도로 두 번 가도 PG 가 한 번만 처리한다
KEYS="$(python3 -c "
import json
keys = [json.loads(l).get('idemKey') for l in open('$PGLOG', encoding='utf-8')
        if json.loads(l).get('kind') == 'cancel']
print('있음' if all(k for k in keys) else '없음')
")"
check "모든 취소 요청에 멱등키가 있다" "$KEYS" "있음"
# 이 수트의 취소는 모두 **서로 다른 동작**이다. 키가 겹치면 PG 가 뒤의 것을
# 재생하고, 우리는 환불했다고 기록한다 — 돌려줘야 할 돈이 사업자에게 남는다.
# (같은 금액을 두 번 환불하는 경우가 실제로 이 수트에 있다: 같은 가격 상품
#  두 개를 따로 반품)
DISTINCT="$(python3 -c "
import json
keys = [json.loads(l)['idemKey'] for l in open('$PGLOG', encoding='utf-8')
        if json.loads(l).get('kind') == 'cancel']
dupes = [k for k in set(keys) if keys.count(k) > 1]
print('모두 다름' if not dupes else f'중복 {dupes}')
")"
check "서로 다른 취소는 서로 다른 멱등키" "$DISTINCT" "모두 다름"
# 같은 금액의 두 취소가 실제로 있었는지 확인한다 — 없으면 위 검증이 헛돈다
SAME_AMOUNT="$(python3 -c "
import json
amts = [json.loads(l)['cancelAmount'] for l in open('$PGLOG', encoding='utf-8')
        if json.loads(l).get('kind') == 'cancel']
print('있음' if any(amts.count(a) > 1 for a in amts if a is not None) else '없음')
")"
check "같은 금액의 취소가 두 번 있었다 (검증이 헛돌지 않는다)" "$SAME_AMOUNT" "있음"

echo "══ PG 주소 재정의 안전장치 ══"
# 운영에서 이 변수가 잘못 설정되면 카드 정보가 평문으로 나간다
BASE_TEST="$(node -e '
function resolve(override) {
  const DEFAULT = "https://api.tosspayments.com/v1";
  if (!override) return DEFAULT;
  try {
    const url = new URL(override);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return DEFAULT;
    return override.replace(/\/$/, "");
  } catch { return DEFAULT; }
}
const cases = [
  ["", "default"],
  ["http://evil.example.com/v1", "default"],
  ["http://127.0.0.1:1234/v1", "override"],
  ["http://localhost:1234/v1", "override"],
  ["https://sandbox.example.com/v1", "override"],
  ["not-a-url", "default"],
];
const D = "https://api.tosspayments.com/v1";
const bad = cases.filter(([input, want]) => {
  const got = resolve(input);
  return want === "default" ? got !== D : got === D;
});
console.log(bad.length === 0 ? "모두 통과" : `실패 ${bad.length}건: ${JSON.stringify(bad)}`);
')"
check "http 는 localhost 만 허용한다" "$BASE_TEST" "모두 통과"

echo "══ PG 가 실패하면 ══"
O3="$(mkorder 1)"
# 존재하지 않는 결제를 취소하면 스텁이 404 를 준다
curl -s -b "$B" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O3\",\"provider\":\"toss\",\"providerTid\":\"pk_o3\",\"amount\":14000}" >/dev/null
psql_q "UPDATE shop_payments SET provider_tid='pk_nonexistent' WHERE provider_tid='pk_o3'" >/dev/null
FAILED_CODE="$(code -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O3\",\"amount\":1000,\"reason\":\"실패 검증\"}")"
FAILED_REFUND="$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$O3\",\"amount\":1000,\"reason\":\"실패 검증\"}")"
check "실패를 402 로 알린다" "$FAILED_CODE" "402"
contains "PG 가 준 사유를 그대로 올린다 (운영자가 원인을 알아야 한다)" \
  "$FAILED_REFUND" "존재하지 않는 결제입니다"
check "환불 누적이 늘지 않았다 (실패했는데 성공으로 기록하면 돈이 사라진다)" \
  "$(psql_q "SELECT refunded_amount FROM shop_payments WHERE provider_tid='pk_nonexistent'")" "0"
check "주문 상태도 그대로" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$O3'")" "paid"

echo "── 비관리자는 환불할 수 없다"
check "일반 회원 403" \
  "$(code -b "$B" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
      -d "{\"orderNo\":\"$O3\",\"amount\":1000,\"reason\":\"x\"}")" "403"
check "비로그인 403" \
  "$(code -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' \
      -d "{\"orderNo\":\"$O3\",\"amount\":1000,\"reason\":\"x\"}")" "403"

echo "══ 개인결제 (주문서 없는 청구) ══"

echo "── 관리 화면 등록"
contains "청구 리소스" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"name":"payment-requests"'
PRF="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/payment-requests")"
contains "결제 링크 필드" "$PRF" '"name":"pay_path"'
contains "금액 수정을 막았음을 설명한다" "$PRF" "취소하고 새로 청구"
check "수정 불가로 선언" "$(echo "$PRF" | python3 -c "
import sys,json; print(json.load(sys.stdin)['can']['update'])")" "False"

echo "── 검증"
check "제목 없으면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"amount":10000}')" "400"
check "금액 0 은 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":0}')" "400"
check "음수도 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":-5000}')" "400"
contains "1억 초과는 거부 (0 을 하나 더 붙이는 실수)" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":200000000}')" "너무 큽니다"
check "잘못된 이메일 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":10000,"customerEmail":"not-an-email"}')" "400"
check "유효기간 0 은 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":10000,"expireDays":0}')" "400"
check "비관리자는 청구할 수 없다" \
  "$(code -b "$B" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
      -d '{"title":"x","amount":10000}')" "403"

echo "── 청구서 만들기"
PR="$(curl -s -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
  -d '{"title":"맞춤 제작 티셔츠 30장","description":"디자인 확정 후 잔금","amount":450000,"customerName":"김철수","customerPhone":"010-9999-8888"}')"
PR_TOKEN="$(echo "$PR" | jq_get "['token']")"
PR_NO="$(echo "$PR" | jq_get "['requestNo']")"
[[ -n "$PR_TOKEN" ]] && ok "청구서 생성 ($PR_NO)" || bad "청구서 생성 ($PR)"
contains "청구번호는 PR- 접두 (주문번호와 구분)" "$PR_NO" "PR-"
contains "결제 링크를 준다" "$PR" '"payPath":"/shop/pay/'
# 링크만으로 결제되므로 추측 불가능해야 한다
[[ "${#PR_TOKEN}" -ge 40 ]] && ok "토큰이 충분히 길다 (${#PR_TOKEN}자)" || bad "토큰 길이 (${#PR_TOKEN}자)"
check "만료 시각이 설정됨" "$(psql_q "SELECT expires_at IS NOT NULL FROM shop_payment_requests WHERE request_no='$PR_NO'")" "true"

echo "── 손님이 보는 청구서 (로그인 불필요)"
VIEW="$(curl -s "$SHOP/pay/$PR_TOKEN")"
contains "제목" "$VIEW" "맞춤 제작 티셔츠 30장"
contains "금액" "$VIEW" '"amount":450000'
contains "설명" "$VIEW" "디자인 확정 후 잔금"
contains "결제 가능" "$VIEW" '"payable":true'
absent "토큰을 되돌려주지 않는다" "$VIEW" "$PR_TOKEN"
check "청구번호로는 열 수 없다 (순차적이라 남의 것을 볼 수 있다)" \
  "$(code "$SHOP/pay/$PR_NO")" "404"
check "틀린 토큰은 404" "$(code "$SHOP/pay/wrong-token-value")" "404"

echo "── 결제 준비: 주문이 만들어진다"
# 청구서에 받는 분을 안 적었고 손님도 안 넣으면 연락할 방법이 없다.
# 전자상거래법상 거래 기록에도 필요하다.
PR_NOINFO="$(curl -s -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
  -d '{"title":"연락처 없는 청구","amount":5000}')"
NOINFO_TOKEN="$(echo "$PR_NOINFO" | jq_get "['token']")"
check "양쪽 다 없으면 400" \
  "$(code -X POST "$SHOP/pay/$NOINFO_TOKEN/prepare" -H 'content-type: application/json' -d '{}')" "400"
contains "무엇이 필요한지 알려준다" \
  "$(curl -s -X POST "$SHOP/pay/$NOINFO_TOKEN/prepare" -H 'content-type: application/json' -d '{}')" \
  "이름을 입력해주세요"
check "이름만 있고 연락처가 없어도 400" \
  "$(code -X POST "$SHOP/pay/$NOINFO_TOKEN/prepare" -H 'content-type: application/json' \
      -d '{"ordererName":"손님"}')" "400"
contains "손님이 직접 넣으면 통과" \
  "$(curl -s -X POST "$SHOP/pay/$NOINFO_TOKEN/prepare" -H 'content-type: application/json' \
      -d '{"ordererName":"손님","ordererPhone":"010-0000-0000"}')" '"orderNo"'

# 청구서에 담긴 값을 기본으로 쓴다 (빈 값을 보내도 대체된다)
PREP="$(curl -s -X POST "$SHOP/pay/$PR_TOKEN/prepare" -H 'content-type: application/json' -d '{}')"
PR_ORDER="$(echo "$PREP" | jq_get "['orderNo']")"
[[ -n "$PR_ORDER" ]] && ok "주문 생성 ($PR_ORDER)" || bad "주문 생성 ($PREP)"
contains "금액이 청구액과 같다" "$PREP" '"amount":450000'
ORD="$(psql_q "SELECT total, is_direct_payment, orderer_name, payment_status FROM shop_orders WHERE order_no='$PR_ORDER'")"
check "주문 금액·개인결제 표시·주문자" "$ORD" "450000|true|김철수|unpaid"
ITEM="$(psql_q "SELECT product_id IS NULL, product_name, line_total FROM shop_order_items WHERE order_id=(SELECT id FROM shop_orders WHERE order_no='$PR_ORDER')")"
check "상품 없는 항목 하나 (제목이 상품명)" "$ITEM" "true|맞춤 제작 티셔츠 30장|450000"

echo "── 새로고침해도 주문이 늘지 않는다"
PREP2="$(curl -s -X POST "$SHOP/pay/$PR_TOKEN/prepare" -H 'content-type: application/json' -d '{}')"
check "같은 주문번호를 돌려준다" "$(echo "$PREP2" | jq_get "['orderNo']")" "$PR_ORDER"
check "이 청구서의 주문은 하나뿐" \
  "$(psql_q "SELECT count(*) FROM shop_orders WHERE order_no='$PR_ORDER'")" "1"

echo "── 결제는 일반 주문과 같은 경로를 쓴다 (금액 위조 방어를 두 번 만들지 않는다)"
BEFORE_CONFIRMS="$(pg_count confirm)"
LOW="$(curl -s -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$PR_ORDER\",\"provider\":\"toss\",\"providerTid\":\"pk_pr_low\",\"amount\":1000}")"
contains "낮은 금액 주장을 거부한다" "$LOW" "일치하지 않습니다"
check "청구서는 여전히 대기" "$(psql_q "SELECT status FROM shop_payment_requests WHERE request_no='$PR_NO'")" "pending"

PRPAY="$(curl -s -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' \
  -d "{\"orderNo\":\"$PR_ORDER\",\"provider\":\"toss\",\"providerTid\":\"pk_pr\",\"amount\":450000}")"
contains "결제 성공" "$PRPAY" '"ok":true'
check "PG 로 정확한 금액이 갔다" "$(pg_last confirm requestedAmount)" "450000"
check "청구서가 결제완료" "$(psql_q "SELECT status, paid_at IS NOT NULL FROM shop_payment_requests WHERE request_no='$PR_NO'")" "paid|true"
check "주문도 결제완료" "$(psql_q "SELECT payment_status, paid_at IS NOT NULL FROM shop_orders WHERE order_no='$PR_ORDER'")" "paid|true"

echo "── 매출과 세금 자료에 포함된다 (이게 그림자 주문을 만드는 이유다)"
TODAY="$(psql_q "SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')")"
SALES="$(curl -s -b "$CK" "$SHOP/admin/reports/sales?from=$TODAY&to=$TODAY")"
python3 -c "
import json, sys
d = json.load(sys.stdin)
print('포함' if d['total']['net'] >= 450000 else f\"누락 (net={d['total']['net']})\")
" <<< "$SALES" > "$TMP/sales.txt"
check "판매 리포트에 잡힌다" "$(cat "$TMP/sales.txt")" "포함"
PRODS="$(curl -s -b "$CK" "$SHOP/admin/reports/products?from=$TODAY&to=$TODAY")"
contains "상품별 리포트에 청구 제목으로 나온다" "$PRODS" "맞춤 제작 티셔츠 30장"
VAT="$(curl -s -b "$CK" "$SHOP/admin/reports/vat?year=$(date +%Y)&period=2-full")"
python3 -c "
import json, sys
d = json.load(sys.stdin)
print('포함' if d['total']['total'] >= 450000 else f\"누락 ({d['total']['total']})\")
" <<< "$VAT" > "$TMP/vat.txt"
check "부가세 신고 자료에도 잡힌다" "$(cat "$TMP/vat.txt")" "포함"

echo "── 재고를 건드리지 않는다 (상품이 없는 주문이다)"
check "상품 재고는 그대로 (99: 앞의 O3 하나만 팔렸다)" "$(psql_q "SELECT stock FROM shop_products WHERE id='$P'")" "99"

echo "── 이미 결제된 청구서"
check "다시 결제 준비하면 409" \
  "$(code -X POST "$SHOP/pay/$PR_TOKEN/prepare" -H 'content-type: application/json' -d '{}')" "409"
PAID_VIEW="$(curl -s "$SHOP/pay/$PR_TOKEN")"
contains "결제 완료라고 알려준다 (404 를 주면 링크가 잘못된 줄 안다)" "$PAID_VIEW" "이미 결제가 완료되었습니다"
contains "결제 불가" "$PAID_VIEW" '"payable":false'
contains "주문번호를 보여준다" "$PAID_VIEW" "$PR_ORDER"
contains "결제된 청구서는 취소할 수 없다 (환불과 혼동된다)" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/payment-requests/$(echo "$PR" | jq_get "['id']")" \
      -H 'content-type: application/json' -d '{"status":"cancelled","reason":"x"}')" "환불은 결제 관리에서"

echo "── 취소한 청구서"
PR2="$(curl -s -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
  -d '{"title":"취소할 청구","amount":20000,"customerName":"이영희","customerPhone":"010-1111-2222"}')"
PR2_ID="$(echo "$PR2" | jq_get "['id']")"
PR2_TOKEN="$(echo "$PR2" | jq_get "['token']")"
contains "취소" "$(curl -s -b "$CK" -X PUT "$SHOP/admin/payment-requests/$PR2_ID" \
  -H 'content-type: application/json' -d '{"status":"cancelled","reason":"금액 변경"}')" '"ok":true'
CANCELLED_VIEW="$(curl -s "$SHOP/pay/$PR2_TOKEN")"
contains "사유를 알려준다" "$CANCELLED_VIEW" "판매자가 취소한 청구서입니다"
contains "결제 불가" "$CANCELLED_VIEW" '"payable":false'
check "결제 준비도 막힌다" \
  "$(code -X POST "$SHOP/pay/$PR2_TOKEN/prepare" -H 'content-type: application/json' -d '{}')" "400"
contains "취소 사유가 메모에 남는다" "$(psql_q "SELECT memo FROM shop_payment_requests WHERE id='$PR2_ID'")" "금액 변경"

echo "── 기한이 지난 청구서"
PR3="$(curl -s -b "$CK" -X POST "$SHOP/admin/payment-requests" -H 'content-type: application/json' \
  -d '{"title":"기한 지난 청구","amount":30000,"customerName":"박민수","customerPhone":"010-3333-4444"}')"
PR3_TOKEN="$(echo "$PR3" | jq_get "['token']")"
psql_q "UPDATE shop_payment_requests SET expires_at = now() - interval '1 day' WHERE id='$(echo "$PR3" | jq_get "['id']")'" >/dev/null
EXPIRED_VIEW="$(curl -s "$SHOP/pay/$PR3_TOKEN")"
contains "기한이 지났다고 알려준다" "$EXPIRED_VIEW" "유효 기간이 지났습니다"
contains "상태가 expired" "$EXPIRED_VIEW" '"status":"expired"'
check "결제 준비가 막힌다 (옛 링크로 틀린 금액이 결제되면 안 된다)" \
  "$(code -X POST "$SHOP/pay/$PR3_TOKEN/prepare" -H 'content-type: application/json' -d '{}')" "400"
# 배치로 상태를 바꾸지 않으므로 DB 는 pending 그대로다 — 계산해서 판단한다
check "DB 상태는 pending 이지만 만료로 취급" \
  "$(psql_q "SELECT status FROM shop_payment_requests WHERE token='$PR3_TOKEN'")" "pending"

echo "── 목록"
LIST="$(curl -s -b "$CK" "$SHOP/admin/payment-requests")"
contains "결제완료 라벨" "$LIST" '"status_label":"결제완료"'
contains "기한 지남 라벨 (배치 없이 계산한다)" "$LIST" '"status_label":"기한 지남"'
contains "취소 라벨" "$LIST" '"status_label":"취소"'
contains "결제 링크를 준다" "$LIST" '"pay_path":"/shop/pay/'
check "비관리자는 목록을 볼 수 없다" "$(code "$SHOP/admin/payment-requests")" "403"
PAID_ONLY="$(curl -s -b "$CK" "$SHOP/admin/payment-requests?status=paid")"
check "상태 필터" "$(echo "$PAID_ONLY" | jq_get "['total']")" "1"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── PG 로 나간 요청 ──"; pg_calls; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
