#!/usr/bin/env bash
#
# 카카오 알림톡 (알리고) — 주문 안내가 승인된 템플릿으로 나가는가.
#
# 알림톡은 카카오가 심사한 템플릿과 글자 하나까지 같아야 나간다(#{변수} 자리만 바뀐다). 스텁
# 알리고(scripts/sms-stub.mjs)가 실제처럼 **템플릿과 다른 본문은 거절**하므로, 여기서 나간
# 알림톡이 통과했다는 것은 템플릿을 제대로 채웠다는 뜻이다.
#   - 알림 종류와 변수는 알림을 보내는 플러그인이 선언한다(코어 등록부)
#   - 연결은 코드만 받고 원문은 알리고에서 — 승인 전·중지·채울 수 없는 변수는 거절
#   - 연결한 알림은 알림톡, 나머지는 문자. 알림톡 요청이 거절되면 문자로 한 번
#   - 대체 문자는 문자 사용을 켠 가게에서만
#   - 이메일 없이 전화번호만 적은 비회원도 안내를 받는다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-alimtalk.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
AL="$API/api/plugins/brick-sms-aligo"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
OUT="$TMP/aligo.jsonl"
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
# sent <kind> <주문번호> <필드> — 그 주문번호가 담긴 마지막 요청의 필드 (kind: alimtalk | sms)
sent() {
  python3 -c "
import json, sys
kind, no, field = sys.argv[1], sys.argv[2], sys.argv[3]
hit = None
for line in open('$OUT', encoding='utf-8'):
    m = json.loads(line)
    k = m.get('kind') or 'sms'
    text = (m.get('message_1') or '') + (m.get('msg') or '')
    if k == kind and no in text: hit = m
print('' if hit is None else hit.get(field, ''))
" "$1" "$2" "$3"
}
# count <kind> <주문번호> — 그 주문번호가 담긴 요청 수
count() {
  python3 -c "
import json, sys
kind, no = sys.argv[1], sys.argv[2]
n = 0
for line in open('$OUT', encoding='utf-8'):
    m = json.loads(line)
    k = m.get('kind') or 'sms'
    if k == kind and no in ((m.get('message_1') or '') + (m.get('msg') or '')): n += 1
print(n)
" "$1" "$2"
}

echo "▶ 알림톡 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

STUB_INFO="$(start_stub scripts/sms-stub.mjs 42910 "$TMP/stub.log" --out "$OUT")" \
  || { bad "알리고 스텁 시작 실패: $(tail -5 "$TMP/stub.log" 2>/dev/null)"; exit 1; }
STUB_PORT="${STUB_INFO% *}"; STUB_PID="${STUB_INFO#* }"
STUB="http://127.0.0.1:${STUB_PORT}"
: > "$OUT"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-alimtalk-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_ALIGO_API_BASE="$STUB"
export BRICK_ALIGO_KAKAO_API_BASE="$STUB"

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
    -d '{"siteName":"알림톡상점","adminEmail":"admin@at.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@at.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-sms-aligo; do
  curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/$pl/activate"
done
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/settings" -H 'content-type: application/json' \
  -d '{"notifyOrderSms":true,"notifyOrderMail":true,"shippingFee":3000,"freeShippingOver":50000,"pageSize":20,"returnShippingFee":3000,"bankAccount":"국민은행 123-45-6789 (알림톡상점)"}'

echo "── 알림 종류는 알림을 보내는 플러그인이 선언한다"
LIST="$(curl -s -b "$CK" "$AL/admin/alimtalk")"
check "주문 알림 여섯 가지가 목록에 있다" "$(echo "$LIST" | jq_get "['total']")" "6"
contains "사람이 읽는 이름" "$LIST" "주문 — 접수"
contains "쓸 수 있는 변수가 보인다" "$LIST" "#{주문번호}"
contains "접수 알림은 입금계좌도 채운다" "$(curl -s -b "$CK" "$AL/admin/alimtalk/shop.order.pending")" "#{입금계좌}"
check "관리자만 본다" "$(code "$AL/admin/alimtalk")" "403"

echo "── 설정"
check "발신프로필 키 없이 알림톡을 켤 수 없다" \
  "$(code -b "$CK" -X PUT "$AL/admin/config" -H 'content-type: application/json' \
      -d '{"userId":"brick","apiKey":"ALIGO_KEY_DO_NOT_LEAK","sender":"02-123-4567","alimtalkEnabled":true}')" "400"
check "발신번호 없이 알림톡을 켤 수 없다 (대체 문자가 그 번호로 나간다)" \
  "$(code -b "$CK" -X PUT "$AL/admin/config" -H 'content-type: application/json' \
      -d '{"userId":"brick","apiKey":"ALIGO_KEY_DO_NOT_LEAK","senderKey":"sk-test","alimtalkEnabled":true}')" "400"
CFG="$(curl -s -b "$CK" -X PUT "$AL/admin/config" -H 'content-type: application/json' \
  -d '{"enabled":true,"userId":"brick","apiKey":"ALIGO_KEY_DO_NOT_LEAK","sender":"02-123-4567","alimtalkEnabled":true,"senderKey":"sk-test"}')"
contains "저장된다" "$CFG" '"alimtalkEnabled":true'
absent "저장 응답에 API 키가 없다" "$CFG" "ALIGO_KEY_DO_NOT_LEAK"

echo "── 템플릿 연결 — 원문은 알리고에서, 승인된 것만, 채울 수 있는 변수만"
cat > "$TMP/templates.json" <<'JSON'
[
  {"templtCode":"ORDER_RECV","templtName":"주문접수","inspStatus":"APR","status":"A",
   "templtContent":"[#{쇼핑몰명}] #{고객명}님, 주문(#{주문번호})이 접수되었습니다.\n상품: #{상품명}\n금액: #{결제금액}\n입금계좌: #{입금계좌}",
   "buttons":[{"name":"주문 조회","linkType":"WL","linkTypeName":"웹링크","linkMo":"#{주문조회}","linkPc":"#{주문조회}"}]},
  {"templtCode":"SHIP","templtName":"발송","inspStatus":"APR","status":"A",
   "templtContent":"#{고객명}님, 주문(#{주문번호}) 상품이 발송되었습니다. 송장번호: #{송장번호}","buttons":[]},
  {"templtCode":"IN_REVIEW","templtName":"검수중","inspStatus":"REQ","status":"R","templtContent":"#{고객명}님 안녕하세요","buttons":[]},
  {"templtCode":"POINTS","templtName":"적립","inspStatus":"APR","status":"A","templtContent":"#{고객명}님 #{적립금} 적립","buttons":[]},
  {"templtCode":"STOPPED","templtName":"중지됨","inspStatus":"APR","status":"S","templtContent":"#{고객명}님","buttons":[]}
]
JSON
curl -s -o /dev/null -X PUT "$STUB/_templates" -H 'content-type: application/json' --data-binary "@$TMP/templates.json"
OPTS="$(curl -s -b "$CK" "$AL/admin/alimtalk-templates")"
contains "고를 수 있는 템플릿에 승인된 것이 나온다" "$OPTS" '"value":"ORDER_RECV"'
absent "검수 중인 템플릿은 고를 수 없다" "$OPTS" "IN_REVIEW"
absent "중지된 템플릿은 고를 수 없다" "$OPTS" "STOPPED"
link() {  # link <알림> <코드> → 응답 전체 + 상태코드
  curl -s -b "$CK" -w ' %{http_code}' -X PUT "$AL/admin/alimtalk/$1" -H 'content-type: application/json' -d "{\"template_code\":\"$2\"}"
}
# 거절은 상태 코드와 거절 문장으로 본다 — 연결이 성공해도 응답(템플릿 이름·본문)에 "검수"·"#{적립금}" 이 있다
R="$(link shop.order.paid IN_REVIEW)"
[[ "$R" == *" 400" && "$R" == *"검수를 통과하지"* ]] && ok "검수 전 템플릿은 연결을 거절한다" || bad "검수 전 템플릿 연결 (${R:0:200})"
R="$(link shop.order.paid STOPPED)"
[[ "$R" == *" 400" && "$R" == *"발송을 중지한"* ]] && ok "중지된 템플릿도" || bad "중지된 템플릿 연결 (${R:0:200})"
BADVAR="$(link shop.order.paid POINTS)"
[[ "$BADVAR" == *" 400" && "$BADVAR" == *"채울 수 없는 변수"*"#{적립금}"* ]] && ok "채울 수 없는 변수를 짚어 준다" || bad "변수 검사 (${BADVAR:0:200})"
contains "쓸 수 있는 변수를 함께 알려 준다" "$BADVAR" "쓸 수 있는 변수: #{고객명}"
R="$(link shop.order.paid SHIP)"
[[ "$R" == *" 400" && "$R" == *"채울 수 없는 변수"*"#{송장번호}"* ]] && ok "알림마다 변수가 다르다 — 결제 확인에는 송장번호가 없다" || bad "알림별 변수 (${R:0:200})"
check "없는 코드는 거절" "$(link shop.order.paid NOPE | tail -c 3)" "400"
check "거절된 연결은 저장되지 않았다" "$(curl -s -b "$CK" "$AL/admin/alimtalk/shop.order.paid" | jq_get "['template_code']")" ""
LINKED="$(link shop.order.pending ORDER_RECV)"
contains "승인된 템플릿을 연결한다" "$LINKED" "주문접수 (ORDER_RECV)"
contains "원문을 알리고에서 받아 둔다" "$LINKED" "입금계좌: #{입금계좌}"
check "발송 알림에도 연결" "$(link shop.order.shipped SHIP | tail -c 3)" "200"

echo "── 연결한 알림은 알림톡으로"
P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"at-mug","name":"알림톡 머그컵","price":12000,"stock":50,"status":"selling"}' | jq_get "['id']")"
P2="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"at-cup","name":"알림톡 컵받침","price":3000,"stock":50,"status":"selling"}' | jq_get "['id']")"
order() {  # order <이메일> <전화> → 주문번호 (두 상품)
  printf '{"items":[{"productId":"%s","quantity":1},{"productId":"%s","quantity":2}],"orderer":{"ordererName":"김알림","ordererPhone":"%s","ordererEmail":"%s","postcode":"06236","address1":"서울","paymentMethod":"bank_transfer"}}' \
    "$P" "$P2" "$2" "$1" > "$TMP/o.json"
  curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json" | jq_get "['orderNo']"
}
O1="$(order guest@at.test 010-1234-5678)"
sleep 1
MSG="$(sent alimtalk "$O1" message_1)"
[[ -n "$MSG" ]] && ok "접수 안내가 알림톡으로 나갔다 (스텁이 템플릿 대조를 통과시켰다)" || bad "알림톡이 나가지 않았다 ($(tail -3 "$OUT"))"
check "연결한 템플릿 코드로" "$(sent alimtalk "$O1" tpl_code)" "ORDER_RECV"
check "번호는 숫자만" "$(sent alimtalk "$O1" receiver_1)" "01012345678"
contains "변수를 채운다 — 이름" "$MSG" "김알림님"
contains "변수를 채운다 — 상품명(여러 개면 외 N건)" "$MSG" "알림톡 머그컵 외 1건"
contains "변수를 채운다 — 금액" "$MSG" "21,000원"
contains "변수를 채운다 — 무통장 입금계좌" "$MSG" "국민은행 123-45-6789"
absent "채우지 못한 변수가 남지 않는다" "$MSG" "#{"
BTN="$(sent alimtalk "$O1" button_1)"
contains "버튼 링크도 채운다 — 비회원 조회 주소(토큰 포함)" "$BTN" "/shop/orders/$O1?token="
check "카카오톡이 없는 손님에게 대체 문자 (문자 사용이 켜져 있다)" "$(sent alimtalk "$O1" failover)" "Y"
contains "대체 문자는 평소 문자 본문" "$(sent alimtalk "$O1" fmessage_1)" "$O1"
check "같은 안내가 문자로 한 번 더 나가지 않는다" "$(count sms "$O1")" "0"

echo "── 연결하지 않은 알림은 문자로"
OID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$O1'")"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' -d '{"status":"paid"}'
sleep 1
check "결제 확인 — 문자" "$(count sms "$O1")" "1"
check "결제 확인은 알림톡으로 나가지 않았다" "$(count alimtalk "$O1")" "1"
curl -s -o /dev/null -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' -d '{"status":"preparing"}'
check "상품 준비는 손님에게 알리지 않는다" "$(count sms "$O1")/$(count alimtalk "$O1")" "1/1"
check "발송 처리" "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' -d '{"status":"shipped","tracking_no":"123456789012"}')" "200"
sleep 1
contains "발송 — 알림톡에 송장번호" "$(sent alimtalk "$O1" message_1)" "송장번호: 123456789012"

echo "── 알림톡 요청이 거절되면 문자로 한 번"
curl -s -o /dev/null -X PUT "$STUB/_kakao_fail" -H 'content-type: application/json' -d '{"n":1}'
O2="$(order guest2@at.test 010-2222-3333)"
sleep 1
check "알림톡을 시도했고" "$(python3 -c "
import json
print(sum(1 for l in open('$OUT', encoding='utf-8') if json.loads(l).get('kind') == 'alimtalk' and json.loads(l).get('receiver_1') == '01022223333'))")" "1"
check "문자로 한 번 나갔다" "$(count sms "$O2")" "1"

echo "── 이메일 없이 전화번호만 적은 비회원"
# 주문서는 전화번호를 필수로 받는다. 전에는 이메일이 없으면 안내를 통째로 건너뛰었다
O3="$(order "" 010-4444-5555)"
sleep 1
check "알림톡을 받는다" "$(sent alimtalk "$O3" receiver_1)" "01044445555"

echo "── 문자를 끈 가게 — 대체 문자도 없다"
curl -s -o /dev/null -b "$CK" -X PUT "$AL/admin/config" -H 'content-type: application/json' -d '{"enabled":false}'
O4="$(order guest4@at.test 010-6666-7777)"
sleep 1
check "알림톡은 나가지만 대체 문자는 꺼져 있다" "$(sent alimtalk "$O4" failover)" "N"
check "대체 문자 본문도 싣지 않는다" "$(sent alimtalk "$O4" fmessage_1)" ""
curl -s -o /dev/null -X PUT "$STUB/_kakao_fail" -H 'content-type: application/json' -d '{"n":1}'
O5="$(order guest5@at.test 010-8888-9999)"
sleep 1
check "알림톡이 거절돼도 문자로 몰래 나가지 않는다" "$(count sms "$O5")" "0"

echo "── 연결을 끊으면 다시 문자로"
curl -s -o /dev/null -b "$CK" -X PUT "$AL/admin/config" -H 'content-type: application/json' -d '{"enabled":true}'
check "연결을 끊는다" "$(link shop.order.pending "" | tail -c 3)" "200"
O6="$(order guest6@at.test 010-1212-3434)"
sleep 1
check "접수 안내가 문자로" "$(count sms "$O6")" "1"
check "알림톡은 없다" "$(count alimtalk "$O6")" "0"

echo "── 새지 않는다"
absent "서버 로그에 API 키가 없다" "$(cat "$TMP/api.log")" "ALIGO_KEY_DO_NOT_LEAK"
absent "서버 로그에 전화번호가 없다" "$(cat "$TMP/api.log")" "01022223333"
contains "알림톡 실패는 로그에 남는다 (번호는 가려서)" "$(cat "$TMP/api.log")" "알림톡 발송 실패 (010****3333"

echo "── 영어 사이트"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.locale":"en"}'
sleep 2
contains "알림 이름이 사이트 언어를 따른다" "$(curl -s -b "$CK" "$AL/admin/alimtalk")" "Order — received"
contains "거절 이유도 번역된다" "$(link shop.order.paid POINTS)" "cannot fill"

echo "── 쇼핑몰을 끄면 그 알림 종류도 사라진다"
curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/brick-shop/deactivate"
check "목록이 빈다" "$(curl -s -b "$CK" "$AL/admin/alimtalk" | jq_get "['total']")" "0"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 알리고로 나간 요청 ──"; cat "$OUT"; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
