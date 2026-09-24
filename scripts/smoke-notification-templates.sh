#!/usr/bin/env bash
#
# 알림 문구 — 운영자가 주문 안내의 제목·본문·문자 문구를 고친다.
#
#   - 알림 종류·변수·기본 문구는 알림을 보내는 플러그인이 선언한다
#   - **기본 문구는 실제로 나가던 문구와 글자까지 같다** — 기본 문구를 그대로 저장해 보낸 알림과
#     고치지 않은 알림을 나란히 놓고 주문마다 다른 값만 바꿔 비교한다
#   - 고친 문구가 알림함·메일·문자에 모두 쓰이고, 문자 문구를 따로 쓰면 단문으로 나간다
#   - 이 알림이 채울 수 없는 변수·여러 줄 제목은 저장 전에 거절한다
#   - 되돌리면 기본 문구로 나간다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-notification-templates.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
NT="$API/api/admin/notification-templates"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
OUT="$TMP/sms.jsonl"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${STUB_PID:-}" ]]; then kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:260})"; }
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
# sms <주문번호> <필드> — 그 주문번호가 담긴 마지막 문자의 필드
sms() {
  python3 -c "
import json, sys
hit = None
for line in open('$OUT', encoding='utf-8'):
    m = json.loads(line)
    if sys.argv[1] in (m.get('msg') or ''): hit = m
print('' if hit is None else hit.get(sys.argv[2], ''))
" "$1" "$2"
}
sms_count() { python3 -c "
import json, sys
print(sum(1 for l in open('$OUT', encoding='utf-8') if sys.argv[1] in (json.loads(l).get('msg') or '')))" "$1"; }
put_tpl() {  # put_tpl <알림> <json 파일> → 본문 + 상태코드
  curl -s -b "$CK" -w ' %{http_code}' -X PUT "$NT/$1" -H 'content-type: application/json' --data-binary "@$2"
}
json_file() {  # json_file <파일> <subject> <body> [sms]
  python3 -c "import json,sys; json.dump({'subject':sys.argv[2],'body':sys.argv[3],'sms':sys.argv[4] if len(sys.argv)>4 else ''}, open(sys.argv[1],'w'), ensure_ascii=False)" "$@"
}

echo "▶ 알림 문구 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

STUB_INFO="$(start_stub scripts/sms-stub.mjs 42920 "$TMP/stub.log" --out "$OUT")" \
  || { bad "문자 스텁 시작 실패: $(tail -5 "$TMP/stub.log" 2>/dev/null)"; exit 1; }
STUB_PORT="${STUB_INFO% *}"; STUB_PID="${STUB_INFO#* }"
: > "$OUT"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-notitpl-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_ALIGO_API_BASE="http://127.0.0.1:${STUB_PORT}"

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
    -d '{"siteName":"문구상점","adminEmail":"admin@nt.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@nt.test","password":"adminpass123"}' >/dev/null

echo "── 알림을 보내는 확장이 없으면 목록이 비어 있다"
check "빈 목록" "$(curl -s -b "$CK" "$NT")" '{"items":[]}'

for pl in brick-shop brick-sms-aligo; do curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/$pl/activate"; done
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/plugins/brick-sms-aligo/admin/config" -H 'content-type: application/json' \
  -d '{"enabled":true,"userId":"brick","apiKey":"k","sender":"02-123-4567"}'
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/settings" -H 'content-type: application/json' \
  -d '{"notifyOrderSms":true,"notifyOrderMail":true,"shippingFee":3000,"freeShippingOver":50000,"pageSize":20,"returnShippingFee":3000,"bankAccount":"신한은행 110-000-000000 (문구상점)"}'
curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"m@nt.test","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"회원"}'
curl -s -o /dev/null -c "$TMP/m.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"m@nt.test","password":"password123"}'
M="$TMP/m.txt"
MID="$(psql_q "SELECT id FROM users WHERE email='m@nt.test'")"

echo "── 목록과 기본 문구"
LIST="$(curl -s -b "$CK" "$NT")"
contains "쇼핑몰의 주문 알림이 목록에 있다" "$LIST" '"event":"shop.order.pending"'
contains "기본 문구로 나가는 중" "$LIST" '"customized":false'
check "관리자만" "$(code -b "$M" "$NT")" "403"
DETAIL="$(curl -s -b "$CK" "$NT/shop.order.pending")"
contains "기본 제목이 변수로 쓰여 있다" "$DETAIL" '"subject":"[#{쇼핑몰명}] 주문이 접수되었습니다 (#{주문번호})"'
contains "기본 본문에 입금 안내 변수" "$DETAIL" "#{결제안내}"
contains "쓸 수 있는 변수와 설명" "$DETAIL" '"name":"상품목록"'
check "없는 알림은 404" "$(code -b "$CK" "$NT/shop.order.nope")" "404"

echo "── 기본 문구는 실제로 나가던 문구와 글자까지 같다"
P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"nt-mug","name":"문구 머그컵","price":12000,"stock":50,"status":"selling"}' | jq_get "['id']")"
order() {  # order <쿠키|-> <전화> → 주문번호
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  printf '{"items":[{"productId":"%s","quantity":2}],"orderer":{"ordererName":"박문구","ordererPhone":"%s","ordererEmail":"o@nt.test","postcode":"06236","address1":"서울","paymentMethod":"bank_transfer"}}' "$P" "$2" > "$TMP/o.json"
  curl -s ${jar[@]+"${jar[@]}"} -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json" | jq_get "['orderNo']"
}
O_DEFAULT="$(order - 010-1000-0001)"
sleep 1
TEXT_DEFAULT="$(sms "$O_DEFAULT" msg)"
[[ -n "$TEXT_DEFAULT" ]] && ok "고치지 않은 안내가 나갔다" || bad "기본 안내가 나가지 않았다"
# 기본 문구를 한 글자도 바꾸지 않고 저장한다 — 그러면 코어의 문구 경로로 나간다
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))['defaults']
json.dump({'subject':d['subject'],'body':d['body'],'sms':''}, open(sys.argv[2],'w'), ensure_ascii=False)
" <(echo "$DETAIL") "$TMP/same.json"
check "기본 문구를 그대로 저장" "$(put_tpl shop.order.pending "$TMP/same.json" | tail -c 3)" "200"
O_SAVED="$(order - 010-1000-0001)"
sleep 1
TEXT_SAVED="$(sms "$O_SAVED" msg)"
# 주문마다 다른 값(주문번호·조회 토큰·입금 기한)을 같은 자리표로 바꿔 비교한다
norm() { python3 -c "
import re,sys
t=sys.stdin.read()
t=re.sub(r'\d{8}-\d{6}','<주문번호>',t)
t=re.sub(r'token=[0-9a-f]+','token=<토큰>',t)
t=re.sub(r'입금 기한: [^\n]*','입금 기한: <기한>',t)
print(t)"; }
[[ -n "$TEXT_SAVED" && "$(echo "$TEXT_DEFAULT" | norm)" == "$(echo "$TEXT_SAVED" | norm)" ]] \
  && ok "기본 문구를 저장해 보낸 안내 = 고치지 않은 안내 (문자 전체)" \
  || bad "기본 문구가 실제 문구와 다르다
--- 기본
$TEXT_DEFAULT
--- 저장
$TEXT_SAVED"
contains "그 안내에 무통장 입금 안내가 들어 있다 (비교가 빈 문구끼리가 아니다)" "$TEXT_SAVED" "신한은행 110-000-000000"

echo "── 저장 전에 거절하는 것"
json_file "$TMP/badvar.json" "[#{쇼핑몰명}] 주문 접수" "#{고객명}님 적립금 #{적립금}원이 쌓였습니다."
R="$(put_tpl shop.order.pending "$TMP/badvar.json")"
[[ "$R" == *" 400" && "$R" == *"채울 수 없는 변수"*"#{적립금}"* ]] && ok "이 알림이 채울 수 없는 변수를 짚어 준다" || bad "변수 검사 (${R:0:200})"
contains "쓸 수 있는 변수를 함께 알려 준다" "$R" "쓸 수 있는 변수: #{고객명}"
json_file "$TMP/badship.json" "발송" "#{고객명}님 송장 #{송장번호}"
R="$(put_tpl shop.order.paid "$TMP/badship.json")"
[[ "$R" == *" 400" && "$R" == *"#{송장번호}"* ]] && ok "알림마다 변수가 다르다 — 결제 확인에는 송장번호가 없다" || bad "알림별 변수 (${R:0:200})"
json_file "$TMP/twolines.json" $'두 줄\n제목' "본문"
check "제목은 한 줄" "$(put_tpl shop.order.pending "$TMP/twolines.json" | tail -c 3)" "400"
json_file "$TMP/nobody.json" "제목" ""
check "본문은 비울 수 없다" "$(put_tpl shop.order.pending "$TMP/nobody.json" | tail -c 3)" "400"
check "거절된 문구는 저장되지 않았다 — 앞서 저장한 문구 그대로" \
  "$(psql_q "SELECT subject FROM notification_templates WHERE event='shop.order.pending'")" "[#{쇼핑몰명}] 주문이 접수되었습니다 (#{주문번호})"

echo "── 고친 문구가 알림함·메일·문자에 쓰인다"
json_file "$TMP/custom.json" "[#{쇼핑몰명}] #{고객명}님 주문 감사합니다 (#{주문번호})" \
  $'#{고객명}님, 주문해 주셔서 감사합니다.\n입금 확인 후 1~2일 안에 발송됩니다.\n\n#{상품목록}\n합계 #{결제금액}\n\n#{결제안내}' \
  "[#{쇼핑몰명}] #{주문번호} 접수. #{결제금액} 입금 부탁드립니다."
PV="$(curl -s -b "$CK" -X POST "$NT/shop.order.pending/preview" -H 'content-type: application/json' --data-binary "@$TMP/custom.json")"
contains "미리보기 — 예시 값으로 채운다" "$PV" "홍길동님 주문 감사합니다"
contains "미리보기 — 문자가 단문으로 나가는지 알려 준다" "$PV" '"smsType":"SMS"'
check "저장" "$(put_tpl shop.order.pending "$TMP/custom.json" | tail -c 3)" "200"
contains "목록에 고친 문구로 표시" "$(curl -s -b "$CK" "$NT")" '"customized":true'
O_CUSTOM="$(order "$M" 010-2000-0002)"
sleep 1
INBOX="$(psql_q "SELECT title || ' / ' || body FROM notifications WHERE user_id='$MID' AND kind='shop.order' ORDER BY created_at DESC LIMIT 1")"
contains "알림함 제목이 고친 문구" "$INBOX" "박문구님 주문 감사합니다 ($O_CUSTOM)"
contains "알림함 본문이 고친 문구 (변수 채움)" "$INBOX" "입금 확인 후 1~2일 안에 발송됩니다."
contains "상품목록 변수" "$INBOX" "문구 머그컵 × 2"
contains "메일도 고친 문구로 (SMTP 없음 — 로그의 본문)" "$(cat "$TMP/api.log")" "입금 확인 후 1~2일 안에 발송됩니다."
check "문자는 따로 쓴 짧은 문구" "$(sms "$O_CUSTOM" msg)" "[문구상점] $O_CUSTOM 접수. 27,000원 입금 부탁드립니다."
check "그래서 단문(SMS)으로 나간다" "$(sms "$O_CUSTOM" msg_type)" "SMS"
check "한 번만 나간다" "$(sms_count "$O_CUSTOM")" "1"
absent "채우지 못한 자리표가 남지 않는다" "$INBOX" "#{"

echo "── 고치지 않은 다른 알림은 기본 문구 그대로"
OID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O_CUSTOM'")"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' -d '{"status":"paid"}'
sleep 1
contains "결제 확인 — 기본 문구" "$(psql_q "SELECT title FROM notifications WHERE user_id='$MID' AND kind='shop.order' ORDER BY created_at DESC LIMIT 1")" "결제가 확인되었습니다 ($O_CUSTOM)"

echo "── 되돌리면 기본 문구로"
check "되돌리기" "$(curl -s -b "$CK" -X DELETE "$NT/shop.order.pending" | jq_get "['removed']")" "True"
O_BACK="$(order - 010-3000-0003)"
sleep 1
contains "기본 문구로 나간다" "$(sms "$O_BACK" msg)" "주문이 접수되었습니다 ($O_BACK)"
absent "고친 문구는 남지 않는다" "$(sms "$O_BACK" msg)" "입금 부탁드립니다"
contains "고친 기록이 감사 로그에 남는다" "$(psql_q "SELECT string_agg(action, ',') FROM audit_logs WHERE action LIKE 'notification.template%'")" "notification.template.reset"

echo "── 영어 사이트"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.locale":"en"}'
sleep 2
EN="$(curl -s -b "$CK" "$NT/shop.order.pending")"
contains "기본 문구도 사이트 언어를 따른다" "$EN" "We received your order"
contains "알림 이름도" "$EN" '"label":"Order — received"'
contains "거절 이유도" "$(put_tpl shop.order.pending "$TMP/badvar.json")" "cannot fill"

echo "── 쇼핑몰을 끄면 그 알림도 목록에서 빠진다"
curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/brick-shop/deactivate"
check "목록이 빈다" "$(curl -s -b "$CK" "$NT")" '{"items":[]}'

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 문자 ──"; cat "$OUT"; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
