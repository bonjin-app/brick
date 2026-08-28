#!/usr/bin/env bash
#
# 재입고 알림 E2E 스모크.
#
# 품절 상품을 찾아온 손님에게 지금은 할 수 있는 것이 없다 — 그 손님은 다시
# 오지 않고, **팔 수 있었던 것을 못 판다.**
#
# 못박는 것:
#   - 품절이 아닌 상품에는 신청을 받지 않는가 (받으면 영원히 대기로 남는다)
#   - 옵션이 있으면 옵션을 요구하는가 ("M 사이즈만 품절"이 대부분이다)
#   - 같은 조합에 중복 신청이 막히는가
#   - 재입고 경로와 무관하게 잡히는가 (반품·취소·관리자 수정·직접 SQL)
#   - **한 사람에게 한 번만** 가는가 (두 번 가면 스팸으로 신고된다)
#   - 다른 옵션이 들어와도 잘못된 알림이 가지 않는가
#   - draft·hidden 으로 내린 상품에는 알림이 가지 않는가 (눌러도 못 산다)
#   - 로그인 없이 해지되는가
#   - 메일이 광고가 아닌가 ((광고) 표기 없음, 다른 상품 없음, 해지 링크 있음)
#   - 탈퇴 시 삭제되는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-restock.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
SMTP_PORT=42727
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
MAILBOX="$TMP/mails.jsonl"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
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

mail_count() { [[ -s "$MAILBOX" ]] && wc -l < "$MAILBOX" | tr -d ' ' || echo 0; }
# 재입고 메일만 센다.
#
# 우편함에는 가입 인증 등 다른 메일도 들어온다. 전체를 세면 "메일 0통" 같은
# 검증이 다른 기능의 메일 때문에 실패하고, 원인을 찾는 데 시간을 쓴다.
mails_to() {  # mails_to <주소일부> → 그 주소로 간 재입고 메일 수
  python3 -c "
import json, sys
n = 0
try:
    for line in open('$MAILBOX', encoding='utf-8'):
        m = json.loads(line)
        if sys.argv[1] in ' '.join(m['envelopeTo']) and '[재입고]' in m['subject']: n += 1
except FileNotFoundError:
    pass
print(n)
" "$1"
}
restock_mail_count() {
  python3 -c "
import json
n = 0
try:
    for line in open('$MAILBOX', encoding='utf-8'):
        if '[재입고]' in json.loads(line)['subject']: n += 1
except FileNotFoundError:
    pass
print(n)
"
}
mail_body() {  # mail_body <주소일부>
  python3 -c "
import json, sys
try:
    for line in open('$MAILBOX', encoding='utf-8'):
        m = json.loads(line)
        if sys.argv[1] in ' '.join(m['envelopeTo']):
            print(m['subject']); print(m['text']); break
except FileNotFoundError:
    pass
" "$1"
}
# 스윕을 돌리고 메일이 도착할 시간을 준다
sweep() {
  curl -s -b "$CK" -X POST "$SHOP/admin/restock-sweep" -H 'content-type: application/json' -d '{}'
}

echo "▶ 재입고 알림 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

echo "── SMTP 스텁 시작 (실제로 무엇이 발송되는지 본다)"
pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
  fi
}
for p in $(pids_on_port "$SMTP_PORT"); do kill -9 "$p" 2>/dev/null || true; done
node "$ROOT/scripts/smtp-sink.mjs" --port "$SMTP_PORT" --out "$MAILBOX" > "$TMP/sink.log" 2>&1 &
SINK_PID=$!
for i in $(seq 1 30); do
  grep -q 'listening' "$TMP/sink.log" 2>/dev/null && break
  kill -0 "$SINK_PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$SINK_PID" 2>/dev/null && [[ "$(pids_on_port "$SMTP_PORT")" == *"$SINK_PID"* ]]; then
  ok "SMTP 스텁 시작"
else
  bad "SMTP 스텁 시작 ($(tail -2 "$TMP/sink.log" 2>/dev/null))"
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-restock-secret-val}"
export BRICK_CAPTCHA=off
export BRICK_TIMEZONE="Asia/Seoul"
export BRICK_SITE_URL="https://restock.test"
export SMTP_HOST=127.0.0.1
export SMTP_PORT="$SMTP_PORT"
export SMTP_FROM="재입고테스트 <noreply@restock.test>"

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
    -d '{"siteName":"재입고샵","adminEmail":"admin@rs.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@rs.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

printf '{"email":"buyer@rs.test","password":"password123",%s"displayName":"구매자"}' "$CONSENT" > "$TMP/reg.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
curl -s -c "$TMP/b.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"buyer@rs.test","password":"password123"}' >/dev/null
B="$TMP/b.txt"

echo "── 준비: 파는 상품 · 품절 상품 · 옵션 상품"
mkproduct() {  # mkproduct <slug> <이름> <stock> <status> [옵션텍스트]
  printf '{"slug":"%s","name":"%s","price":20000,"stock":%s,"status":"%s","options_text":"%s"}' \
    "$1" "$2" "$3" "$4" "${5:-}" > "$TMP/p.json"
  curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/p.json" | jq_get "['id']"
}
P_OK="$(mkproduct "in-stock" "재고있는 상품" 10 "selling")"
P_OUT="$(mkproduct "sold-out" "품절 상품" 0 "soldout")"
P_OPT="$(mkproduct "with-opts" "옵션 상품" 100 "selling" "S|0|0\\nM|0|5\\nL|0|0")"
[[ -n "$P_OK" && -n "$P_OUT" && -n "$P_OPT" ]] && ok "상품 3개" || bad "상품 등록"
OPT_S="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$P_OPT' AND name='S'")"
OPT_M="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$P_OPT' AND name='M'")"
OPT_L="$(psql_q "SELECT id FROM shop_product_options WHERE product_id='$P_OPT' AND name='L'")"
# 이름 순이면 L, M, S 다 — 정렬을 명시하지 않으면 기대값을 맞출 수 없다
check "S·L 품절, M 재고 5" \
  "$(psql_q "SELECT string_agg(name || '=' || stock, ',' ORDER BY name) FROM shop_product_options WHERE product_id='$P_OPT'")" \
  "L=0,M=5,S=0"

echo "══ 품절이 아니면 신청을 받지 않는다 ══"
# 받아두면 재입고 이벤트가 없어 영원히 대기로 남고, 손님은 기다리다 잊는다
NOT_OUT="$(curl -s -X POST "$SHOP/products/in-stock/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"a@x.test"}')"
contains "거부한다" "$NOT_OUT" "품절된 상품에만"
check "행이 만들어지지 않았다" "$(psql_q "SELECT count(*) FROM shop_restock_alerts")" "0"
check "없는 상품은 404" \
  "$(code -X POST "$SHOP/products/no-such-product/restock-alert" -H 'content-type: application/json' \
      -d '{"email":"a@x.test"}')" "404"

echo "══ 옵션이 있으면 옵션을 요구한다 ══"
# "M 사이즈만 품절"이 대부분이다. 상품 단위로 받으면 L 이 들어왔을 때
# M 을 기다린 손님에게 잘못된 알림이 간다.
NO_OPT="$(curl -s -X POST "$SHOP/products/with-opts/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"a@x.test"}')"
contains "옵션을 고르라고 한다" "$NO_OPT" "옵션을 선택해주세요"
printf '{"email":"a@x.test","optionId":"%s"}' "$OPT_M" > "$TMP/optm.json"
IN_STOCK_OPT="$(curl -s -X POST "$SHOP/products/with-opts/restock-alert" -H 'content-type: application/json' \
  --data-binary "@$TMP/optm.json")"
contains "재고 있는 옵션은 거부" "$IN_STOCK_OPT" "품절된 상품에만"
check "다른 상품의 옵션은 404" \
  "$(code -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
      -d "{\"email\":\"a@x.test\",\"optionId\":\"$OPT_S\"}")" "404"

echo "══ 신청 ══"
check "이메일이 없으면 400" \
  "$(code -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' -d '{}')" "400"
check "형식이 틀리면 400" \
  "$(code -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
      -d '{"email":"not-an-email"}')" "400"

R1="$(curl -s -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"guest1@rs.test"}')"
contains "비회원 신청 성공" "$R1" '"id"'
contains "주소를 가려서 돌려준다" "$R1" '"email":"gu****@rs.test"'
absent "원본 주소를 되돌려주지 않는다 (남의 주소 확인 수단이 된다)" "$R1" "guest1@rs.test"
contains "광고가 아님을 알린다" "$R1" "광고 메일이 아닙니다"
check "DB 에는 원본" "$(psql_q "SELECT email FROM shop_restock_alerts WHERE email='guest1@rs.test'")" "guest1@rs.test"
check "IP 는 해시로만" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE ip_hash='127.0.0.1'")" "0"
check "해시는 기록된다" "$(psql_q "SELECT count(*) > 0 FROM shop_restock_alerts WHERE ip_hash IS NOT NULL")" "true"

echo "── 중복 신청은 막는다"
check "같은 주소·같은 상품은 409" \
  "$(code -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
      -d '{"email":"guest1@rs.test"}')" "409"
check "행은 하나뿐" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE email='guest1@rs.test'")" "1"
# 대소문자만 다른 주소도 같은 것으로 본다
check "대문자로 써도 409" \
  "$(code -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
      -d '{"email":"GUEST1@RS.TEST"}')" "409"

echo "── 회원은 가입 이메일로 자동 신청"
MEMBER_R="$(curl -s -b "$B" -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' -d '{}')"
contains "이메일을 안 줘도 된다" "$MEMBER_R" '"id"'
check "가입 주소로 저장" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE email='buyer@rs.test' AND user_id IS NOT NULL")" "1"
MY="$(curl -s -b "$B" "$SHOP/me/restock-alerts")"
contains "내 신청 목록" "$MY" "품절 상품"
contains "해지 링크를 준다" "$MY" '"cancelPath":"/shop/restock/cancel/'
check "비로그인은 401" "$(code "$SHOP/me/restock-alerts")" "401"

echo "── 옵션별 신청"
printf '{"email":"wants-s@rs.test","optionId":"%s"}' "$OPT_S" > "$TMP/ws.json"
curl -s -X POST "$SHOP/products/with-opts/restock-alert" -H 'content-type: application/json' --data-binary "@$TMP/ws.json" >/dev/null
printf '{"email":"wants-l@rs.test","optionId":"%s"}' "$OPT_L" > "$TMP/wl.json"
curl -s -X POST "$SHOP/products/with-opts/restock-alert" -H 'content-type: application/json' --data-binary "@$TMP/wl.json" >/dev/null
check "옵션별로 저장" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE option_id IS NOT NULL")" "2"

echo "══ 재입고 전에는 알림이 가지 않는다 ══"
SW="$(sweep)"
contains "보낼 것이 없다" "$SW" '"sent":0'
check "재입고 메일 0통" "$(restock_mail_count)" "0"

echo "══ 관리자 수정으로 재입고 → 알림이 간다 ══"
# 재고가 오르는 경로는 여러 곳이다. 스윕이 경로와 무관하게 잡는다.
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$P_OUT" -H 'content-type: application/json' \
  -d '{"slug":"sold-out","name":"품절 상품","price":20000,"stock":5,"status":"selling"}' >/dev/null
check "재고가 들어왔다" "$(psql_q "SELECT stock, status FROM shop_products WHERE id='$P_OUT'")" "5|selling"
SW="$(sweep)"
contains "2명에게 발송" "$SW" '"sent":2'
sleep 1
check "guest1 에게 1통" "$(mails_to "guest1@rs.test")" "1"
check "회원에게 1통" "$(mails_to "buyer@rs.test")" "1"
check "옵션 대기자에게는 가지 않았다" "$(mails_to "wants-s@rs.test")" "0"

echo "── 메일 내용: 광고가 아니다"
BODY="$(mail_body "guest1@rs.test")"
contains "제목에 [재입고]" "$BODY" "[재입고] 품절 상품"
absent "(광고) 표기가 없다 (손님이 요청한 정보다)" "$BODY" "(광고)"
contains "상품 링크" "$BODY" "https://restock.test/shop/sold-out"
contains "가격" "$BODY" "20,000원"
contains "1회 발송임을 알린다" "$BODY" "1회 발송"
contains "신청하지 않았다면 안내" "$BODY" "신청하지 않으셨다면"
contains "해지 링크" "$BODY" "/shop/restock/cancel/"
contains "사이트 이름" "$BODY" "재입고샵"
# 다른 상품을 끼워 넣으면 광고가 되고 수신 동의가 필요해진다
absent "다른 상품을 넣지 않는다" "$BODY" "옵션 상품"

echo "══ 한 사람에게 한 번만 ══"
# 두 번 가면 스팸으로 신고된다
check "신청이 소진되었다" \
  "$(psql_q "SELECT status FROM shop_restock_alerts WHERE email='guest1@rs.test'")" "notified"
SW="$(sweep)"
contains "다시 돌려도 발송 없음" "$SW" '"sent":0'
check "여전히 1통" "$(mails_to "guest1@rs.test")" "1"
# 품절 → 재입고를 반복해도 한 번만
psql_q "UPDATE shop_products SET stock = 0, status='soldout' WHERE id='$P_OUT'" >/dev/null
psql_q "UPDATE shop_products SET stock = 3, status='selling' WHERE id='$P_OUT'" >/dev/null
sweep >/dev/null
sleep 1
check "품절-재입고를 반복해도 1통" "$(mails_to "guest1@rs.test")" "1"

echo "── 소진된 뒤에는 다시 신청할 수 있다 (또 품절될 수 있다)"
psql_q "UPDATE shop_products SET stock = 0, status='soldout' WHERE id='$P_OUT'" >/dev/null
AGAIN="$(curl -s -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"guest1@rs.test"}')"
contains "다시 신청 성공" "$AGAIN" '"id"'
check "행이 둘 (이력이 남는다)" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE email='guest1@rs.test'")" "2"

echo "══ 옵션: 다른 옵션이 들어와도 잘못 가지 않는다 ══"
# L 만 재입고한다. S 를 기다린 사람에게 가면 안 된다.
psql_q "UPDATE shop_product_options SET stock = 7 WHERE id='$OPT_L'" >/dev/null
SW="$(sweep)"
sleep 1
check "L 대기자에게만 1통" "$(mails_to "wants-l@rs.test")" "1"
check "S 대기자에게는 0통" "$(mails_to "wants-s@rs.test")" "0"
L_BODY="$(mail_body "wants-l@rs.test")"
contains "옵션 이름이 제목에 들어간다" "$L_BODY" "옵션 상품 (L)"
check "S 신청은 여전히 대기" \
  "$(psql_q "SELECT status FROM shop_restock_alerts WHERE email='wants-s@rs.test'")" "pending"

echo "══ 내린 상품에는 알림이 가지 않는다 ══"
# draft·hidden 이면 재고가 있어도 살 수 없다. 알림을 보내면 눌러도 404 다.
psql_q "UPDATE shop_product_options SET stock = 9 WHERE id='$OPT_S'" >/dev/null
psql_q "UPDATE shop_products SET status = 'hidden' WHERE id='$P_OPT'" >/dev/null
SW="$(sweep)"
contains "내린 상품은 건너뛴다" "$SW" '"sent":0'
check "S 대기자에게 여전히 0통" "$(mails_to "wants-s@rs.test")" "0"
check "신청은 살아 있다 (다시 팔면 간다)" \
  "$(psql_q "SELECT status FROM shop_restock_alerts WHERE email='wants-s@rs.test'")" "pending"
psql_q "UPDATE shop_products SET status = 'selling' WHERE id='$P_OPT'" >/dev/null
sweep >/dev/null
sleep 1
check "다시 팔면 알림이 간다" "$(mails_to "wants-s@rs.test")" "1"

echo "══ 해지 (로그인 없이) ══"
psql_q "UPDATE shop_products SET stock = 0, status='soldout' WHERE id='$P_OUT'" >/dev/null
CANCEL_R="$(curl -s -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"cancel-me@rs.test"}')"
TOKEN="$(psql_q "SELECT token FROM shop_restock_alerts WHERE email='cancel-me@rs.test'")"
[[ -n "$TOKEN" ]] && ok "토큰 확인" || bad "토큰 확인"
contains "로그인 없이 해지" "$(curl -s -X POST "$SHOP/restock-alerts/cancel/$TOKEN")" '"ok":true'
check "상태가 cancelled" "$(psql_q "SELECT status FROM shop_restock_alerts WHERE email='cancel-me@rs.test'")" "cancelled"
# 링크를 두 번 눌러도 오류를 보여주지 않는다 (해지가 안 된 줄 알고 다시 시도한다)
contains "두 번 눌러도 성공" "$(curl -s -X POST "$SHOP/restock-alerts/cancel/$TOKEN")" '"ok":true'
check "없는 토큰은 404" "$(code -X POST "$SHOP/restock-alerts/cancel/no-such-token")" "404"
# 해지했으면 재입고돼도 안 간다
psql_q "UPDATE shop_products SET stock = 4, status='selling' WHERE id='$P_OUT'" >/dev/null
sweep >/dev/null
sleep 1
check "해지한 사람에게는 가지 않는다" "$(mails_to "cancel-me@rs.test")" "0"

echo "══ 반품으로 재고가 돌아와도 잡힌다 ══"
# 재고가 오르는 다른 경로 — 각 지점에 알림을 붙이지 않아도 스윕이 잡는다
psql_q "UPDATE shop_products SET stock = 1, status='selling' WHERE id='$P_OK'" >/dev/null
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P_OK" > "$TMP/o.json"
ORDER="$(curl -s -b "$B" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json" | jq_get "['orderNo']")"
check "주문으로 품절됨" "$(psql_q "SELECT stock FROM shop_products WHERE id='$P_OK'")" "0"
psql_q "UPDATE shop_products SET status='soldout' WHERE id='$P_OK'" >/dev/null
curl -s -X POST "$SHOP/products/in-stock/restock-alert" -H 'content-type: application/json' \
  -d '{"email":"waits-return@rs.test"}' >/dev/null
check "신청됨" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE email='waits-return@rs.test'")" "1"

psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$ORDER'" >/dev/null
ITEM="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$ORDER'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM" > "$TMP/ret.json"
RID="$(curl -s -b "$B" -X POST "$SHOP/orders/$ORDER/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
check "반품으로 재고 복원" "$(psql_q "SELECT stock FROM shop_products WHERE id='$P_OK'")" "1"
# 상태는 soldout 이므로 아직 안 간다 — 운영자가 일부러 내린 것을 존중한다
sweep >/dev/null
check "soldout 상태면 재고가 있어도 안 간다" "$(mails_to "waits-return@rs.test")" "0"
psql_q "UPDATE shop_products SET status='selling' WHERE id='$P_OK'" >/dev/null
sweep >/dev/null
sleep 1
check "판매중으로 바꾸면 간다 (경로와 무관하게 잡힌다)" "$(mails_to "waits-return@rs.test")" "1"

echo "══ 관리자: 어떤 상품을 기다리는 사람이 많은가 ══"
psql_q "UPDATE shop_products SET stock = 0, status='soldout' WHERE id='$P_OUT'" >/dev/null
for n in 1 2 3; do
  curl -s -X POST "$SHOP/products/sold-out/restock-alert" -H 'content-type: application/json' \
    -d "{\"email\":\"demand$n@rs.test\"}" >/dev/null
done
DEMAND="$(curl -s -b "$CK" "$SHOP/admin/restock-demand")"
contains "상품명" "$DEMAND" "품절 상품"
contains "기다리는 사람 수" "$DEMAND" '"waiting":3'
contains "첫 신청 시각" "$DEMAND" '"firstRequestedAt"'
check "비관리자는 볼 수 없다" "$(code "$SHOP/admin/restock-demand")" "403"
check "일반 회원도 불가" "$(code -b "$B" "$SHOP/admin/restock-demand")" "403"
check "스윕도 관리자만" "$(code -X POST "$SHOP/admin/restock-sweep")" "403"

echo "══ 품절 화면에 신청 폼이 있다 ══"
DET="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"sold-out"}}')"
contains "품절 안내" "$DET" "품절된 상품입니다"
contains "신청 폼" "$DET" "brick-restock-form"
contains "광고가 아님을 화면에도" "$DET" "광고 메일이 아닙니다"

echo "── 일부 옵션만 품절이면 살 수 있는 상품에도 폼이 나온다"
# 이게 가장 흔한 경우인데, 상품 status 가 selling 이라 품절 화면이 안 뜬다
psql_q "UPDATE shop_product_options SET stock = 0 WHERE id='$OPT_M'" >/dev/null
psql_q "UPDATE shop_product_options SET stock = 5 WHERE id='$OPT_S'" >/dev/null
OPT_DET="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"with-opts"}}')"
contains "품절 옵션 안내" "$OPT_DET" "품절된 옵션이 있습니다"
contains "신청 폼" "$OPT_DET" "brick-restock-form"
contains "구매 폼도 함께 있다 (살 수 있는 옵션이 있다)" "$OPT_DET" "brick-buy-form"
# 품절 옵션이 하나면 숨겨진 값으로 넣는다
contains "품절 옵션 id 를 폼에 담는다" "$OPT_DET" "name=\\\"optionId\\\""

echo "── 재고가 다 있으면 폼이 없다"
psql_q "UPDATE shop_product_options SET stock = 5 WHERE product_id='$P_OPT'" >/dev/null
FULL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"with-opts"}}')"
HAS_FORM="$(python3 -c "
import json, sys
d = json.load(sys.stdin)
html = d['html'] if isinstance(d, dict) and 'html' in d else str(d)
print('<form class=\"brick-restock-form\"' in html)" <<< "$FULL")"
check "신청 폼이 없다" "$HAS_FORM" "False"

echo "══ 탈퇴하면 신청이 삭제된다 ══"
BEFORE="$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE user_id IS NOT NULL")"
[[ "$BEFORE" -ge 1 ]] && ok "회원 신청이 있다 ($BEFORE건)" || bad "회원 신청 확인"
WD="$(curl -s -b "$B" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123","deletePosts":false,"reason":"검증"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
check "회원 신청이 지워졌다" "$(psql_q "SELECT count(*) FROM shop_restock_alerts WHERE user_id IS NOT NULL")" "0"
check "비회원 신청은 남는다 (다음 재입고에 소진된다)" \
  "$(psql_q "SELECT count(*) > 0 FROM shop_restock_alerts WHERE user_id IS NULL")" "true"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
