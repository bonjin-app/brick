#!/usr/bin/env bash
#
# 정기결제 E2E 스모크 — 스텁 PG · 스텁 SMTP 로 실제로 나가는 것을 본다.
#
# 못박는 것:
#   - 카드번호가 이 시스템을 지나가지 않는가 (빌링키만 저장)
#   - 첫 결제 실패 = 가입 실패인가 (주문 취소 · 재고 복원 · 구독 없음)
#   - **청구액이 가입 시점과 달라지면 결제하지 않고 멈추는가** —
#     동의 없이 인상된 금액을 청구하면 안 된다
#   - 3회 연속 실패 시 멈추고 알리는가 · 성공하면 실패 카운트가 리셋되는가
#   - **해지는 항상, 즉시** — 해지 후 시간이 지나도 청구가 없는가
#   - 카드 삭제가 그 카드의 구독을 즉시 멈추는가
#   - 밀린 회차를 몰아 청구하지 않는가 (석 달 밀려도 1건)
#   - 남의 카드·남의 구독을 만질 수 없는가
#   - 같은 회차가 두 번 청구되지 않는가 (멱등키가 PG 로 가는가)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-subscriptions.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TOSS="$API/api/plugins/brick-pay-toss"
PG_PORT=42627
SMTP_PORT=42728
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PGLOG="$TMP/pg.jsonl"
MAILBOX="$TMP/mails.jsonl"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${PG_PID:-}" ]]; then kill "$PG_PID" 2>/dev/null; wait "$PG_PID" 2>/dev/null || true; fi
  if [[ -n "${SINK_PID:-}" ]]; then kill "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null || true; fi
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

pg_charge_count() { python3 -c "
import json
n = 0
try:
  for line in open('$PGLOG', encoding='utf-8'):
    if json.loads(line).get('kind') == 'billing-charge': n += 1
except FileNotFoundError: pass
print(n)
"; }
pg_last_charge() {  # pg_last_charge <필드>
  python3 -c "
import json, sys
found = None
for line in open('$PGLOG', encoding='utf-8'):
    m = json.loads(line)
    if m.get('kind') == 'billing-charge': found = m
print('' if found is None else found.get(sys.argv[1], ''))
" "$1"
}
mails_containing() { python3 -c "
import json
n = 0
try:
  for line in open('$MAILBOX', encoding='utf-8'):
    m = json.loads(line)
    if '$1' in (m.get('subject') or '') or '$1' in (m.get('text') or m.get('body') or ''): n += 1
except FileNotFoundError: pass
print(n)
"; }
stub_fail_next() {  # stub_fail_next <n> — 다음 n 건의 청구를 실패시킨다
  curl -s -X POST "http://127.0.0.1:$PG_PORT/__control" -H 'content-type: application/json' \
    -d "{\"failNextCharges\":$1}" >/dev/null
}
sweep() { curl -s -b "$CK" -X POST "$SHOP/admin/subscriptions/sweep"; }
time_travel() {  # time_travel <slug 무관: 구독 id> <interval SQL>
  psql_q "UPDATE shop_subscriptions SET next_charge_at = now() - interval '$2' WHERE id = '$1'" >/dev/null
}

echo "▶ 정기결제 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  fi
}

echo "── 스텁 시작 (PG · SMTP)"
for p in $(pids_on_port "$PG_PORT"); do kill -9 "$p" 2>/dev/null || true; done
for p in $(pids_on_port "$SMTP_PORT"); do kill -9 "$p" 2>/dev/null || true; done
node "$ROOT/scripts/pg-stub.mjs" --port "$PG_PORT" --out "$PGLOG" > "$TMP/pg.log" 2>&1 &
PG_PID=$!
node "$ROOT/scripts/smtp-sink.mjs" --port "$SMTP_PORT" --out "$MAILBOX" > "$TMP/sink.log" 2>&1 &
SINK_PID=$!
for i in $(seq 1 30); do
  grep -q 'listening' "$TMP/pg.log" 2>/dev/null && grep -q 'listening' "$TMP/sink.log" 2>/dev/null && break
  sleep 0.3
done
if [[ "$(pids_on_port "$PG_PORT")" == *"$PG_PID"* && "$(pids_on_port "$SMTP_PORT")" == *"$SINK_PID"* ]]; then
  ok "스텁 2개 시작 (우리 프로세스가 듣고 있다)"
else
  bad "스텁 시작 실패 ($(tail -2 "$TMP/pg.log" 2>/dev/null) / $(tail -2 "$TMP/sink.log" 2>/dev/null))"
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-subs-secret-val}"
export BRICK_CAPTCHA=off
export BRICK_TOSS_API_BASE="http://127.0.0.1:${PG_PORT}/v1"
export SMTP_HOST=127.0.0.1
export SMTP_PORT="$SMTP_PORT"
export SMTP_FROM="정기배송 <noreply@subs.test>"

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
    -d '{"siteName":"정기배송","adminEmail":"admin@subs.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@subs.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-pay-toss; do
  curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate" >/dev/null
done
curl -s -b "$CK" -X PUT "$TOSS/admin/config" -H 'content-type: application/json' \
  -d '{"secretKey":"test_sk_SECRET","clientKey":"test_ck_public","enabled":true}' >/dev/null

# 회원 둘 — 남의 것을 만질 수 없는지 보려면 둘이 필요하다
for u in a b; do
  printf '{"email":"%s@subs.test","password":"password123",%s"displayName":"회원%s"}' "$u" "$CONSENT" "$u" > "$TMP/reg.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
  curl -s -c "$TMP/$u.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$u@subs.test\",\"password\":\"password123\"}" >/dev/null
done
A="$TMP/a.txt"; B="$TMP/b.txt"

# 상품: 정기배송(월) 하나, 일반 하나. 무료배송으로 두어 금액 계산을 단순하게.
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"milk","name":"우유 구독","price":12000,"stock":50,"status":"selling","free_shipping":true,"sub_interval":"month"}' >/dev/null
curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"cup","name":"컵","price":5000,"stock":10,"status":"selling","free_shipping":true}' >/dev/null
ok "상품 2개 (정기배송 1 · 일반 1)"

ORDERER='{"ordererName":"회원a","ordererPhone":"010-1111-2222","postcode":"04524","address1":"서울 중구 세종대로 110"}'

echo "── 카드 등록 (빌링키)"
contains "정기결제 지원 결제수단 목록" "$(curl -s "$SHOP/billing/providers")" '"toss"'
check "비로그인 등록 불가" "$(code -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' -d '{}')" "401"
CUST_A="$(curl -s -b "$A" -X POST "$SHOP/me/billing-keys/prepare" | jq_get "['customerKey']")"
[[ "$CUST_A" == cust-* ]] && ok "고객 키 발급 (내부 id 가 아니다)" || bad "고객 키 발급 ($CUST_A)"
check "잘못된 authKey 는 402" \
  "$(code -b "$A" -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' \
      -d "{\"provider\":\"toss\",\"authKey\":\"auth-bad\",\"customerKey\":\"$CUST_A\"}")" "402"
KEY_A="$(curl -s -b "$A" -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' \
  -d "{\"provider\":\"toss\",\"authKey\":\"auth-ok-a\",\"customerKey\":\"$CUST_A\"}")"
KEY_A_ID="$(echo "$KEY_A" | jq_get "['id']")"
contains "카드 등록 성공 · 표시는 마스킹" "$KEY_A" "****1234"
contains "내 카드 목록" "$(curl -s -b "$A" "$SHOP/me/billing-keys")" "$KEY_A_ID"
check "카드번호가 DB 에 없다 (빌링키 토큰만)" \
  "$(psql_q "SELECT count(*) FROM shop_billing_keys WHERE billing_key LIKE '%1234%' OR billing_key ~ '[0-9]{12}'")" "0"

echo "── 가입 — 첫 회차 즉시 결제"
check "일반 상품은 구독 불가" \
  "$(code -b "$A" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' \
      -d "{\"productSlug\":\"cup\",\"billingKeyId\":\"$KEY_A_ID\",\"orderer\":$ORDERER}")" "400"
check "남의 카드로는 가입 불가" \
  "$(code -b "$B" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' \
      -d "{\"productSlug\":\"milk\",\"billingKeyId\":\"$KEY_A_ID\",\"orderer\":$ORDERER}")" "404"

SUB="$(curl -s -b "$A" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' \
  -d "{\"productSlug\":\"milk\",\"billingKeyId\":\"$KEY_A_ID\",\"orderer\":$ORDERER}")"
SUB_ID="$(echo "$SUB" | jq_get "['id']")"
ORDER1="$(echo "$SUB" | jq_get "['orderNo']")"
[[ -n "$SUB_ID" ]] && ok "가입 성공" || bad "가입 성공 ($SUB)"
check "청구액 = 주문 총액" "$(echo "$SUB" | jq_get "['total']")" "12000"
check "첫 주문이 결제 완료다" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$ORDER1'")" "paid"
check "재고 차감" "$(psql_q "SELECT stock FROM shop_products WHERE slug='milk'")" "49"
check "스텁 PG 에 나간 청구 금액" "$(pg_last_charge amount)" "12000"
contains "회차 멱등키가 PG 로 간다" "$(pg_last_charge idemKey)" "sub-${SUB_ID}-c1"
check "고객 키 짝이 맞는다" "$(pg_last_charge customerKey)" "$CUST_A"
MY="$(curl -s -b "$A" "$SHOP/me/subscriptions")"
contains "내 구독 목록 · 진행 중" "$MY" '"status":"active"'
contains "다음 결제일이 잡혔다" "$MY" '"nextChargeAt":"2'
check "남의 구독 목록에는 없다" "$(curl -s -b "$B" "$SHOP/me/subscriptions" | jq_get "['items'].__len__()")" "0"

echo "── 첫 결제 실패 = 가입 실패 (주문 취소 · 재고 복원 · 구독 없음)"
stub_fail_next 1
FAILSUB_CODE="$(code -b "$A" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' \
  -d "{\"productSlug\":\"milk\",\"billingKeyId\":\"$KEY_A_ID\",\"orderer\":$ORDERER}")"
check "402 로 거절" "$FAILSUB_CODE" "402"
check "재고 복원 (차감된 채 남지 않는다)" "$(psql_q "SELECT stock FROM shop_products WHERE slug='milk'")" "49"
check "구독이 만들어지지 않았다" "$(psql_q "SELECT count(*) FROM shop_subscriptions WHERE user_id=(SELECT id FROM users WHERE email='a@subs.test')")" "1"

echo "── 회차 청구 (스윕)"
BEFORE="$(pg_charge_count)"
contains "결제일 전에는 청구하지 않는다" "$(sweep)" '"due":0'
time_travel "$SUB_ID" "1 hour"
SWEEP1="$(sweep)"
contains "결제일이 되면 청구한다" "$SWEEP1" '"charged":1'
check "청구가 1건 늘었다" "$(pg_charge_count)" "$((BEFORE + 1))"
contains "2회차 멱등키" "$(pg_last_charge idemKey)" "sub-${SUB_ID}-c2"
check "회차 전진" "$(psql_q "SELECT cycle_no FROM shop_subscriptions WHERE id='$SUB_ID'")" "2"
check "2회차 주문도 결제 완료" "$(psql_q "SELECT count(*) FROM shop_orders WHERE user_id=(SELECT id FROM users WHERE email='a@subs.test') AND status='paid'")" "2"
contains "같은 회차를 다시 청구하지 않는다 (스윕 재실행)" "$(sweep)" '"due":0'

echo "── 밀린 회차를 몰아 청구하지 않는다"
psql_q "UPDATE shop_subscriptions SET next_charge_at = now() - interval '3 months' WHERE id='$SUB_ID'" >/dev/null
B2="$(pg_charge_count)"
contains "석 달 밀려도 1건" "$(sweep)" '"charged":1'
check "청구는 1건뿐" "$(pg_charge_count)" "$((B2 + 1))"
NEXT_FUTURE="$(psql_q "SELECT (next_charge_at > now()) FROM shop_subscriptions WHERE id='$SUB_ID'")"
check "다음 결제일이 미래다" "$NEXT_FUTURE" "true"

echo "── 청구액이 달라지면 결제하지 않고 멈춘다"
PRODUCT_ID="$(psql_q "SELECT id FROM shop_products WHERE slug='milk'")"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$PRODUCT_ID" -H 'content-type: application/json' \
  -d '{"slug":"milk","name":"우유 구독","price":15000,"stock":50,"status":"selling","free_shipping":true,"sub_interval":"month"}' >/dev/null
check "정기배송 주기가 수정에도 유지된다" "$(psql_q "SELECT sub_interval FROM shop_products WHERE slug='milk'")" "month"
time_travel "$SUB_ID" "1 hour"
B3="$(pg_charge_count)"
SWEEP_PAUSE="$(sweep)"
contains "멈춘다" "$SWEEP_PAUSE" '"paused":1'
check "PG 청구는 없다 (돈이 움직이지 않았다)" "$(pg_charge_count)" "$B3"
ST="$(curl -s -b "$A" "$SHOP/me/subscriptions")"
contains "중지 상태 · 사유에 금액" "$ST" "12,000"
contains "회차 주문은 취소됐다" "$(psql_q "SELECT status FROM shop_orders WHERE user_id=(SELECT id FROM users WHERE email='a@subs.test') ORDER BY created_at DESC LIMIT 1")" "cancelled"
sleep 1
check "중지 알림 메일 발송" "$(mails_containing '정기배송 중지')" "1"

echo "── 재개 — 가격을 되돌리면 다시 돈다"
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$PRODUCT_ID" -H 'content-type: application/json' \
  -d '{"slug":"milk","name":"우유 구독","price":12000,"stock":50,"status":"selling","free_shipping":true,"sub_interval":"month"}' >/dev/null
contains "재개" "$(curl -s -b "$A" -X POST "$SHOP/me/subscriptions/$SUB_ID/resume" -H 'content-type: application/json' -d '{}')" '"ok":true'
contains "재개 즉시 청구 대상이 된다" "$(sweep)" '"charged":1'
check "회차 4" "$(psql_q "SELECT cycle_no FROM shop_subscriptions WHERE id='$SUB_ID'")" "4"

echo "── 결제 실패: 재시도 → 3연속이면 중지"
stub_fail_next 9
time_travel "$SUB_ID" "1 hour"
contains "1회 실패" "$(sweep)" '"failed":1'
check "실패 카운트 1" "$(psql_q "SELECT fail_count FROM shop_subscriptions WHERE id='$SUB_ID'")" "1"
check "재시도는 하루 뒤 (즉시 재청구하지 않는다)" \
  "$(psql_q "SELECT (next_charge_at > now() + interval '20 hours') FROM shop_subscriptions WHERE id='$SUB_ID'")" "true"
time_travel "$SUB_ID" "1 hour"; sweep >/dev/null
time_travel "$SUB_ID" "1 hour"; sweep >/dev/null
check "3연속 실패 → 중지" "$(psql_q "SELECT status FROM shop_subscriptions WHERE id='$SUB_ID'")" "paused"
sleep 1
# "3회 연속" 은 실패 예고 메일에도 들어간다 — 중지 메일만의 문구로 센다
check "중지 알림 메일 (실패 사유 포함)" "$(mails_containing '연속 실패하여')" "1"
check "실패마다 예고 메일" "$(mails_containing '다시 시도합니다')" "2"
stub_fail_next 0

echo "── 성공은 실패 카운트를 리셋한다"
contains "재개" "$(curl -s -b "$A" -X POST "$SHOP/me/subscriptions/$SUB_ID/resume" -H 'content-type: application/json' -d '{}')" '"ok":true'
contains "청구 성공" "$(sweep)" '"charged":1'
check "실패 카운트 0" "$(psql_q "SELECT fail_count FROM shop_subscriptions WHERE id='$SUB_ID'")" "0"

echo "── 해지 — 항상, 즉시, 조건 없이"
check "남의 구독은 해지 불가" "$(code -b "$B" -X POST "$SHOP/me/subscriptions/$SUB_ID/cancel")" "404"
contains "회원 해지" "$(curl -s -b "$A" -X POST "$SHOP/me/subscriptions/$SUB_ID/cancel")" '"ok":true'
contains "두 번 눌러도 오류가 아니다" "$(curl -s -b "$A" -X POST "$SHOP/me/subscriptions/$SUB_ID/cancel")" '"ok":true'
psql_q "UPDATE shop_subscriptions SET next_charge_at = now() - interval '1 day' WHERE id='$SUB_ID'" >/dev/null
B4="$(pg_charge_count)"
contains "해지 뒤에는 청구 대상이 아니다" "$(sweep)" '"due":0'
check "청구 없음" "$(pg_charge_count)" "$B4"
EV="$(curl -s -b "$A" "$SHOP/me/subscriptions/$SUB_ID/events")"
contains "이벤트 이력에 해지가 남는다" "$EV" "회원 해지"

echo "── 카드 삭제는 그 카드의 구독을 즉시 멈춘다"
CUST_B="$(curl -s -b "$B" -X POST "$SHOP/me/billing-keys/prepare" | jq_get "['customerKey']")"
KEY_B_ID="$(curl -s -b "$B" -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' \
  -d "{\"provider\":\"toss\",\"authKey\":\"auth-ok-b\",\"customerKey\":\"$CUST_B\"}" | jq_get "['id']")"
SUB_B_ID="$(curl -s -b "$B" -X POST "$SHOP/subscriptions" -H 'content-type: application/json' \
  -d "{\"productSlug\":\"milk\",\"billingKeyId\":\"$KEY_B_ID\",\"orderer\":{\"ordererName\":\"회원b\",\"ordererPhone\":\"010-3333-4444\",\"postcode\":\"04524\",\"address1\":\"서울\"}}" | jq_get "['id']")"
check "남의 카드는 삭제 불가" "$(code -b "$A" -X DELETE "$SHOP/me/billing-keys/$KEY_B_ID")" "404"
contains "카드 삭제 → 구독 1개 중지" \
  "$(curl -s -b "$B" -X DELETE "$SHOP/me/billing-keys/$KEY_B_ID")" '"pausedSubscriptions":1'
check "중지됨" "$(psql_q "SELECT status FROM shop_subscriptions WHERE id='$SUB_B_ID'")" "paused"
check "삭제된 카드로는 재개 불가" \
  "$(code -b "$B" -X POST "$SHOP/me/subscriptions/$SUB_B_ID/resume" -H 'content-type: application/json' -d '{}')" "400"
CUST_B2="$(curl -s -b "$B" -X POST "$SHOP/me/billing-keys/prepare" | jq_get "['customerKey']")"
KEY_B2_ID="$(curl -s -b "$B" -X POST "$SHOP/me/billing-keys" -H 'content-type: application/json' \
  -d "{\"provider\":\"toss\",\"authKey\":\"auth-ok-b2\",\"customerKey\":\"$CUST_B2\"}" | jq_get "['id']")"
contains "새 카드로 재개" "$(curl -s -b "$B" -X POST "$SHOP/me/subscriptions/$SUB_B_ID/resume" \
  -H 'content-type: application/json' -d "{\"billingKeyId\":\"$KEY_B2_ID\"}")" '"ok":true'
contains "새 카드로 청구된다" "$(sweep)" '"charged":1'
check "새 고객 키가 PG 로 갔다" "$(pg_last_charge customerKey)" "$CUST_B2"

echo "── 관리자"
ADM="$(curl -s -b "$CK" "$SHOP/admin/subscriptions")"
contains "관리자 목록 (회원 이메일)" "$ADM" "b@subs.test"
contains "관리자 해지" "$(curl -s -b "$CK" -X DELETE "$SHOP/admin/subscriptions/$SUB_B_ID")" '"ok":true'
check "해지됨" "$(psql_q "SELECT status FROM shop_subscriptions WHERE id='$SUB_B_ID'")" "cancelled"
check "비관리자는 목록 불가" "$(code -b "$A" "$SHOP/admin/subscriptions")" "403"
check "관리 화면 등록" "$(curl -s -b "$CK" "$API/api/admin/nav" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(any(r['name']=='subscriptions' for r in d['resources']))")" "True"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
