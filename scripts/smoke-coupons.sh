#!/usr/bin/env bash
#
# 쿠폰 고도화 E2E 스모크 — 조건과 발급형.
#
# 쿠폰은 돈이 걸린 자동 할인이고, 조건이 틀리면 **비용이 새거나 손님이 막힌다**:
#   - 1인 제한이 없으면 한 사람이 전체 한도를 다 쓴다
#   - 첫 구매 전용이 새면 신규 유치 비용이 기존 회원에게 나간다
#   - 발급형이 새면 코드가 커뮤니티에 퍼졌을 때 통제가 없다
#
# 못박는 것:
#   - 1인당 한도가 (취소 제외) 주문 이력으로 세어지는가
#   - 첫 구매 전용이 결제 이력 기준인가 (미결제 주문은 첫 구매를 막지 않는가)
#   - 등급 전용이 실제 배정 기준인가
#   - 발급형: 지급받지 않으면 못 쓰고, 한 장이 한 번만 쓰이는가
#   - 주문 취소 시 발급형 쿠폰이 반환되는가 · **환불에는 반환되지 않는가**
#   - 회원 조건 쿠폰을 비회원이 쓰면 로그인 안내가 나오는가
#   - 재발급이 중복 지급되지 않는가 (두 번 눌러도 빠진 사람만)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-coupons.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
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

echo "▶ 쿠폰 고도화 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-coupons-secret-va}"
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
    -d '{"siteName":"쿠폰","adminEmail":"admin@cp.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@cp.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

for n in 1 2; do
  printf '{"email":"c%s@cp.test","password":"password123",%s"displayName":"손님%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"c%s@cp.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/c$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
C1="$TMP/c1.txt"; C2="$TMP/c2.txt"

P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"cp-item","name":"쿠폰테스트 상품","price":10000,"stock":999,"status":"selling"}' | jq_get "['id']")"
[[ -n "$P" ]] && ok "상품 등록" || bad "상품 등록"

# 빈 배열 + set -u 는 macOS 기본 bash 3.2 에서 unbound variable 로 죽는다 —
# 배열 대신 쿠키 파일을 그대로 넘기고, "-" 는 빈 쿠키 파일로 처리한다
: > "$TMP/nocookie.txt"
ck_file() { [[ "$1" == "-" ]] && echo "$TMP/nocookie.txt" || echo "$1"; }
order_with() {  # order_with <쿠키|-> <쿠폰코드|""> → 응답 전체
  local coupon=""; [[ -n "$2" ]] && coupon=",\"couponCode\":\"$2\""
  printf '{"items":[{"productId":"%s","quantity":1}]%s,"orderer":{"ordererName":"손님","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" "$coupon" > "$TMP/mk.json"
  curl -s -b "$(ck_file "$1")" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json"
}
quote_with() {  # quote_with <쿠키|-> <쿠폰코드>
  printf '{"items":[{"productId":"%s","quantity":1}],"couponCode":"%s","postcode":"06236"}' "$P" "$2" > "$TMP/q.json"
  curl -s -b "$(ck_file "$1")" -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json"
}

echo "══ 1인당 한도 ══"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"ONCE","name":"1인 1회","discount_type":"fixed","discount_value":1000,"per_user_limit":1}' >/dev/null
check "1인당 한도 저장" "$(psql_q "SELECT per_user_limit FROM shop_coupons WHERE code='ONCE'")" "1"
check "0 이하 한도는 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
      -d '{"code":"BADLIM","name":"x","discount_type":"fixed","discount_value":1000,"per_user_limit":0}')" "400"

contains "비회원은 로그인 안내 (신원을 셀 수 없다)" "$(order_with - "ONCE")" "로그인 후 사용할 수 있는 쿠폰"
O1="$(order_with "$C1" "ONCE" | jq_get "['orderNo']")"
[[ -n "$O1" ]] && ok "첫 사용 성공 ($O1)" || bad "첫 사용"
contains "두 번째는 거절 (같은 회원)" "$(order_with "$C1" "ONCE")" "1인당 사용 한도"
O2="$(order_with "$C2" "ONCE" | jq_get "['orderNo']")"
[[ -n "$O2" ]] && ok "다른 회원은 사용 가능" || bad "다른 회원 사용"

echo "── 취소된 주문은 사용으로 치지 않는다"
psql_q "UPDATE shop_orders SET status='cancelled' WHERE order_no='$O1'" >/dev/null
O1B="$(order_with "$C1" "ONCE" | jq_get "['orderNo']")"
[[ -n "$O1B" ]] && ok "취소 후 다시 사용 가능 (결제 실패가 쿠폰을 먹으면 안 된다)" || bad "취소 후 재사용"

echo "══ 첫 구매 전용 ══"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"WELCOME","name":"신규 환영","discount_type":"percent","discount_value":20,"first_purchase_only":true}' >/dev/null
# c2 는 미결제 주문(O2)만 있다 — 결제 이력이 기준이므로 아직 첫 구매다
Q2="$(quote_with "$C2" "WELCOME")"
check "미결제 주문만 있으면 아직 첫 구매 (20% = 2000)" "$(echo "$Q2" | jq_get "['couponDiscount']")" "2000"
# 결제하면 더는 첫 구매가 아니다
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at=now() WHERE order_no='$O2'" >/dev/null
contains "결제 이력이 생기면 거절" "$(order_with "$C2" "WELCOME")" "첫 구매 고객만"
Q1W="$(quote_with "$C1" "WELCOME")"
check "결제 이력 없는 c1 은 사용 가능" "$(echo "$Q1W" | jq_get "['couponDiscount']")" "2000"
contains "비회원은 로그인 안내" "$(order_with - "WELCOME")" "로그인 후"

echo "══ 등급 전용 ══"
curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
  -d '{"name":"일반","min_amount":0,"discount_rate":0}' >/dev/null
GOLD="$(curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
  -d '{"name":"골드","min_amount":5000,"discount_rate":0}' | jq_get "['id']")"
printf '{"code":"GOLDONLY","name":"골드 전용","discount_type":"fixed","discount_value":3000,"grade_id":"%s"}' "$GOLD" > "$TMP/gc.json"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' --data-binary "@$TMP/gc.json" >/dev/null
curl -s -b "$CK" -X POST "$SHOP/admin/grades/recompute" >/dev/null
# c2 는 1만원 결제 이력 → 골드, c1 은 결제 이력 없음 → 일반
check "c2 골드 배정" "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='c2@cp.test'")" "골드"
contains "일반 등급은 거절 + 어느 등급 전용인지 알려준다" "$(order_with "$C1" "GOLDONLY")" "골드 등급 전용"
QG="$(quote_with "$C2" "GOLDONLY")"
check "골드는 사용 가능" "$(echo "$QG" | jq_get "['couponDiscount']")" "3000"

echo "── 쿠폰 폼이 등급 선택지를 라우트에서 받는다"
GOPT="$(curl -s -b "$CK" "$SHOP/admin/options/grades")"
contains "등급 선택지" "$GOPT" "골드"
CFIELDS="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/coupons")"
contains "폼에 등급 필드" "$CFIELDS" '"optionsFrom":"/admin/options/grades"'

echo "══ 발급형 (쿠폰함) ══"
ISSUED_ID="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"VIPGIFT","name":"VIP 선물","discount_type":"fixed","discount_value":5000,"requires_issue":true}' | jq_get "['id']")"
[[ -n "$ISSUED_ID" ]] && ok "발급형 쿠폰 생성" || bad "발급형 쿠폰 생성"

contains "지급받지 않으면 코드가 있어도 못 쓴다" "$(order_with "$C1" "VIPGIFT")" "지급받은 회원만"

echo "── 지급"
ISSUE="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/$ISSUED_ID/issue" -H 'content-type: application/json' \
  -d '{"emails":["c1@cp.test"]}')"
contains "1명 지급" "$ISSUE" '"issued":1'
ISSUE2="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/$ISSUED_ID/issue" -H 'content-type: application/json' \
  -d '{"emails":["c1@cp.test"]}')"
contains "다시 눌러도 중복 지급 없음 (빠진 사람만 채운다)" "$ISSUE2" '"issued":0'
check "쿠폰함에 한 장" "$(psql_q "SELECT count(*) FROM shop_user_coupons")" "1"

echo "── 쿠폰함 조회"
WALLET="$(curl -s -b "$C1" "$SHOP/me/coupons")"
contains "지급받은 쿠폰" "$WALLET" '"code":"VIPGIFT"'
contains "사용 가능 상태" "$WALLET" '"status":"usable"'
check "비로그인 401" "$(code "$SHOP/me/coupons")" "401"
EMPTY_WALLET="$(curl -s -b "$C2" "$SHOP/me/coupons")"
check "지급 안 받은 회원의 쿠폰함은 비어 있다" "$(echo "$EMPTY_WALLET" | python3 -c "
import sys,json; print(len(json.load(sys.stdin)['items']))")" "0"

echo "── 사용: 한 장이 한 번만"
OV="$(order_with "$C1" "VIPGIFT" | jq_get "['orderNo']")"
[[ -n "$OV" ]] && ok "지급받은 쿠폰으로 주문 ($OV)" || bad "발급형 사용"
USED="$(psql_q "SELECT used_at IS NOT NULL, used_order_no FROM shop_user_coupons LIMIT 1")"
check "쿠폰함에서 소진 + 주문번호 기록" "$USED" "true|$OV"
contains "같은 쿠폰을 또 쓰면 거절 (한 장뿐)" "$(order_with "$C1" "VIPGIFT")" "지급받은 회원만"
WALLET2="$(curl -s -b "$C1" "$SHOP/me/coupons")"
contains "쿠폰함에 사용됨 표시" "$WALLET2" '"status":"used"'

echo "── 주문 취소 → 쿠폰 반환"
OV_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$OV'")"
CANCEL_RES="$(curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OV_ID" -H 'content-type: application/json' \
  -d '{"status":"cancelled","note":"결제 실패"}')"
check "주문 취소됨" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$OV'")" "cancelled"
check "쿠폰이 쿠폰함으로 반환 (결제 실패가 쿠폰을 먹으면 안 된다)" \
  "$(psql_q "SELECT used_at IS NULL FROM shop_user_coupons LIMIT 1")" "true"

echo "── 환불에는 반환하지 않는다 (쿠폰으로 사고 반품하기 반복 차단)"
# 다시 쿠폰으로 주문 → 결제 → 환불
OR="$(order_with "$C1" "VIPGIFT" | jq_get "['orderNo']")"
[[ -n "$OR" ]] && ok "반환된 쿠폰으로 재주문" || bad "재주문"
psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at=now() WHERE order_no='$OR'" >/dev/null
OR_ID="$(psql_q "SELECT id FROM shop_orders WHERE order_no='$OR'")"
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OR_ID" -H 'content-type: application/json' \
  -d '{"status":"refunded","note":"환불"}' >/dev/null
check "주문 환불됨" "$(psql_q "SELECT status FROM shop_orders WHERE order_no='$OR'")" "refunded"
check "쿠폰은 소진된 채 남는다" \
  "$(psql_q "SELECT used_at IS NOT NULL FROM shop_user_coupons WHERE used_order_no='$OR'")" "true"

echo "── 등급 전체 지급"
GISSUE="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/$ISSUED_ID/issue" -H 'content-type: application/json' \
  -d "{\"gradeId\":\"$GOLD\"}")"
contains "골드 전체(c2) 지급" "$GISSUE" '"issued":1'
check "쿠폰함 2장 (c1 반환분 + c2 신규)" "$(psql_q "SELECT count(*) FROM shop_user_coupons")" "2"

echo "── 코드형 쿠폰에는 발급이 의미가 없다"
NORMAL_ID="$(psql_q "SELECT id FROM shop_coupons WHERE code='ONCE'")"
contains "발급형이 아니면 거절 + 안내" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/$NORMAL_ID/issue" -H 'content-type: application/json' \
      -d '{"all":true}')" "발급형 쿠폰이 아닙니다"
check "대상 없이 부르면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/coupons/$ISSUED_ID/issue" -H 'content-type: application/json' -d '{}')" "400"
check "비관리자는 지급 불가" \
  "$(code -b "$C1" -X POST "$SHOP/admin/coupons/$ISSUED_ID/issue" -H 'content-type: application/json' \
      -d '{"all":true}')" "403"

echo "── 탈퇴하면 쿠폰함이 지워진다"
WD="$(curl -s -b "$C1" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123","deletePosts":false,"reason":"검증"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
check "c1 쿠폰함 삭제 (c2 것만 남는다)" "$(psql_q "SELECT count(*) FROM shop_user_coupons")" "1"

echo "── 생일 쿠폰 (월·일만 — 연도는 최소수집 원칙으로 받지 않는다)"
# c2 가 생일을 등록한다 — 오늘(KST)로. 검증도 함께 본다.
check "잘못된 날짜는 400 (2월 30일)" \
  "$(code -b "$C2" -X PUT "$API/api/me" -H 'content-type: application/json' \
      -d '{"birthMonth":2,"birthDay":30}')" "400"
TODAY_MD="$(psql_q "SELECT EXTRACT(MONTH FROM now() AT TIME ZONE 'Asia/Seoul')::int || ',' || EXTRACT(DAY FROM now() AT TIME ZONE 'Asia/Seoul')::int")"
TM="${TODAY_MD%,*}"; TD="${TODAY_MD#*,}"
# 중첩 따옴표 JSON 은 bash 3.2 의 명령 치환 안에서 깨진다 — 파일로 보낸다
printf '{"birthMonth":%s,"birthDay":%s}' "$TM" "$TD" > "$TMP/bday.json"
contains "생일 등록" "$(curl -s -b "$C2" -X PUT "$API/api/me" -H 'content-type: application/json' \
  --data-binary "@$TMP/bday.json")" '"ok":true'
contains "프로필에서 보인다" "$(curl -s -b "$C2" "$API/api/me/profile")" "\"birth_month\":$TM"

BDAY="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"BDAY2026","name":"생일 축하","discount_type":"fixed","discount_value":3000,"birthday_auto":true}')"
check "생일 쿠폰은 발급형이 강제된다" \
  "$(psql_q "SELECT requires_issue || '|' || birthday_auto FROM shop_coupons WHERE code='BDAY2026'")" "true|true"

SWEEP1="$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/birthday-sweep")"
contains "오늘이 생일인 회원에게 지급" "$SWEEP1" '"issued":1'
contains "쿠폰함에 담겼다" "$(curl -s -b "$C2" "$SHOP/me/coupons")" "BDAY2026"
contains "다시 돌려도 두 장이 가지 않는다 (멱등)" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/birthday-sweep")" '"issued":0'

# 생일이 다른 회원은 못 받는다 — c3 을 어제 생일로
printf '{"email":"c3@cp.test","password":"password123",%s"displayName":"손님3"}' "$CONSENT" > "$TMP/r3.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r3.json" >/dev/null
curl -s -c "$TMP/c3.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"c3@cp.test","password":"password123"}' >/dev/null
YEST="$(psql_q "SELECT EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Seoul') - interval '1 day')::int || ',' || EXTRACT(DAY FROM (now() AT TIME ZONE 'Asia/Seoul') - interval '1 day')::int")"
curl -s -b "$TMP/c3.txt" -X PUT "$API/api/me" -H 'content-type: application/json' \
  -d "{\"birthMonth\":${YEST%,*},\"birthDay\":${YEST#*,}}" >/dev/null
contains "생일이 아닌 회원에게는 안 간다" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/coupons/birthday-sweep")" '"issued":0'

echo "── 생일 삭제권과 탈퇴 파기"
contains "회원이 스스로 지운다" "$(curl -s -b "$C2" -X PUT "$API/api/me" -H 'content-type: application/json' \
  -d '{"birthMonth":null,"birthDay":null}')" '"ok":true'
check "지워졌다" "$(psql_q "SELECT birth_month IS NULL FROM users WHERE email='c2@cp.test'")" "true"
curl -s -b "$TMP/c3.txt" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123"}' >/dev/null
check "탈퇴하면 생일도 파기된다" \
  "$(psql_q "SELECT birth_month IS NULL AND birth_day IS NULL FROM users WHERE display_name='탈퇴한 회원' ORDER BY updated_at DESC LIMIT 1" | head -1)" "true"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
