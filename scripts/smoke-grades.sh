#!/usr/bin/env bash
#
# 회원 등급 E2E 스모크.
#
# 등급은 돈이 걸린 자동 할인이다. 못박는 것:
#   - 산정이 **순매출** 기준인가 (반품을 빼는가 — 안 빼면 사서 반품하기로
#     등급을 올릴 수 있다)
#   - 등급 할인이 장바구니 견적과 주문에서 **같은 금액**인가
#   - 쿠폰과 합쳐 상품 금액을 넘지 않는가
#   - 주문에 스냅샷이 남는가 (등급이 나중에 바뀌어도 주문 내역은 그대로)
#   - 부분 반품의 할인 안분이 등급 할인까지 포함해 정합한가
#   - 비회원에게 등급 할인이 없는가
#   - 등급 삭제 시 배정이 함께 사라지고 할인이 0이 되는가
#   - 탈퇴 시 배정이 지워지는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-grades.sh
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

recompute() { curl -s -b "$CK" -X POST "$SHOP/admin/grades/recompute"; }

echo "▶ 회원 등급 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-grades-secret-val}"
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
    -d '{"siteName":"등급","adminEmail":"admin@gr.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@gr.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

# 구매자 셋 — 실적이 다르게 만든다
for n in 1 2 3; do
  printf '{"email":"b%s@gr.test","password":"password123",%s"displayName":"구매자%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"b%s@gr.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/b$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
B1="$TMP/b1.txt"; B2="$TMP/b2.txt"; B3="$TMP/b3.txt"

P="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"g-item","name":"등급테스트 상품","price":10000,"stock":999,"status":"selling"}' | jq_get "['id']")"
[[ -n "$P" ]] && ok "상품 등록" || bad "상품 등록"

buy() {  # buy <쿠키> <수량> → orderNo (결제까지)
  printf '{"items":[{"productId":"%s","quantity":%s}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" "$2" > "$TMP/mk.json"
  local no
  no="$(curl -s -b "$1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/mk.json" | jq_get "['orderNo']")"
  psql_q "UPDATE shop_orders SET payment_status='paid', status='paid', paid_at=now() WHERE order_no='$no'" >/dev/null
  echo "$no"
}

echo "── 등급 정의: 검증"
check "이름 없으면 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"min_amount":0,"discount_rate":1}')" "400"
check "할인율 51% 는 400 (5% 를 50% 로 적는 실수 방지)" \
  "$(code -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"name":"X","min_amount":0,"discount_rate":51}')" "400"
check "음수 기준 금액 400" \
  "$(code -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"name":"X","min_amount":-1,"discount_rate":1}')" "400"
check "비관리자는 생성 불가" \
  "$(code -b "$B1" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"name":"X","min_amount":0}')" "403"

echo "── 등급 3단 만들기 (일반 0원 / 실버 3만 / 골드 10만)"
curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
  -d '{"name":"일반","min_amount":0,"discount_rate":0}' >/dev/null
curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
  -d '{"name":"실버","min_amount":30000,"discount_rate":3}' >/dev/null
GOLD_ID="$(curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
  -d '{"name":"골드","min_amount":100000,"discount_rate":10,"description":"10% 상시 할인"}' | jq_get "['id']")"
check "등급 3개" "$(psql_q "SELECT count(*) FROM shop_grades")" "3"
contains "같은 기준 금액은 409 (경계가 겹치면 어느 등급인지 정할 수 없다)" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"name":"중복","min_amount":30000,"discount_rate":5}')" "겹치면"
contains "같은 이름도 409" \
  "$(curl -s -b "$CK" -X POST "$SHOP/admin/grades" -H 'content-type: application/json' \
      -d '{"name":"골드","min_amount":999999,"discount_rate":5}')" "같은 이름"
contains "공개 목록 (얼마 사면 어떤 혜택인지 손님이 봐야 한다)" \
  "$(curl -s "$SHOP/grades")" '"name":"골드"'

echo "── 구매 실적 만들기: b1 = 12만, b2 = 4만, b3 = 0"
for i in 1 2 3 4; do buy "$B1" 3 >/dev/null; done   # (30,000+3,000배송)×4 = 결제 13.2만
buy "$B2" 4 >/dev/null                               # 40,000+3,000 = 4.3만
RECOMP="$(recompute)"
contains "재계산 실행" "$RECOMP" '"assigned":'
check "b1 은 골드" "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b1@gr.test'")" "골드"
check "b2 는 실버" "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b2@gr.test'")" "실버"
check "구매 없는 b3 도 기본 등급 (등급 없음과 구분해야 화면이 안내한다)" \
  "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b3@gr.test'")" "일반"

echo "── 마이페이지: 내 등급과 다음 등급까지"
MY2="$(curl -s -b "$B2" "$SHOP/me/grade")"
contains "내 등급" "$MY2" '"name":"실버"'
contains "산정 금액을 보여준다 (왜 이 등급인가)" "$MY2" '"baseAmount":43000'
contains "다음 등급" "$MY2" '"name":"골드"'
contains "남은 금액 (행동을 유도하는 값)" "$MY2" '"remaining":57000'
MY1="$(curl -s -b "$B1" "$SHOP/me/grade")"
check "최고 등급이면 다음이 없다" "$(echo "$MY1" | jq_get "['nextGrade']")" "None"
check "비로그인 401" "$(code "$SHOP/me/grade")" "401"

echo "══ 등급 할인: 견적과 주문이 같은 금액 ══"
# b1(골드 10%)이 10,000원 상품 2개 → 등급 할인 2,000
printf '{"items":[{"productId":"%s","quantity":2}],"postcode":"06236"}' "$P" > "$TMP/q.json"
Q1="$(curl -s -b "$B1" -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json")"
contains "견적에 등급 할인 2000" "$Q1" '"gradeDiscount":2000'
contains "등급 이름" "$Q1" '"gradeName":"골드"'
contains "총 할인에 포함" "$Q1" '"discount":2000'
check "총액 = 20000-2000+3000" "$(echo "$Q1" | jq_get "['total']")" "21000"

printf '{"items":[{"productId":"%s","quantity":2}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$P" > "$TMP/o.json"
O1="$(curl -s -b "$B1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json" | jq_get "['orderNo']")"
ROW="$(psql_q "SELECT subtotal, discount, grade_discount, grade_name, total FROM shop_orders WHERE order_no='$O1'")"
check "주문도 같은 금액 + 스냅샷" "$ROW" "20000|2000|2000|골드|21000"

echo "── 비회원·일반 등급에는 할인이 없다"
QG="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json")"
check "비회원 등급 할인 0" "$(echo "$QG" | jq_get "['gradeDiscount']")" "0"
Q3="$(curl -s -b "$B3" -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json")"
check "일반(0%) 등급 할인 0" "$(echo "$Q3" | jq_get "['gradeDiscount']")" "0"
contains "이름은 보여준다" "$Q3" '"gradeName":"일반"'

echo "── 쿠폰과 합산: 상품 금액을 넘지 않는다"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"gr19000","name":"1.9만","discount_type":"fixed","discount_value":19000}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":2}],"couponCode":"gr19000","postcode":"06236"}' "$P" > "$TMP/qc.json"
QC="$(curl -s -b "$B1" -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/qc.json")"
# 쿠폰 19,000 + 등급 10%(2,000) = 21,000 > 상품 20,000 → 등급 할인이 1,000 으로 잘린다
check "쿠폰 할인" "$(echo "$QC" | jq_get "['couponDiscount']")" "19000"
check "등급 할인이 잘린다 (합이 상품 금액을 넘지 않게)" "$(echo "$QC" | jq_get "['gradeDiscount']")" "1000"
check "총 할인 = 상품 금액" "$(echo "$QC" | jq_get "['discount']")" "20000"
check "총액은 배송비만" "$(echo "$QC" | jq_get "['total']")" "3000"

echo "── 부분 반품: 등급 할인 포함 안분이 정합하다"
psql_q "UPDATE shop_orders SET payment_status='paid', status='delivered', delivered_at=now(), paid_at=now() WHERE order_no='$O1'" >/dev/null
ITEM="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O1'")"
printf '{"kind":"return","reasonCode":"defect","items":[{"orderItemId":"%s","quantity":1}]}' "$ITEM" > "$TMP/ret.json"
RET="$(curl -s -b "$B1" -X POST "$SHOP/orders/$O1/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret.json")"
# 2개 중 1개: 실제 받은 상품값 18,000 의 절반 = 9,000
contains "환불액이 등급 할인을 안분한 9000 (10000이 아니다)" "$RET" '"refundAmount":9000'

echo "══ 산정: 반품이 실적에서 빠진다 ══"
# b2 를 골드 직전까지 만든 뒤 반품시켜 강등을 확인한다
O2="$(buy "$B2" 6)"   # +6.3만 → 누적 10.6만 (골드 기준 10만 초과)
recompute >/dev/null
check "b2 가 골드로 승급" "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b2@gr.test'")" "골드"

psql_q "UPDATE shop_orders SET status='delivered', delivered_at=now() WHERE order_no='$O2'" >/dev/null
ITEM2="$(psql_q "SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_no='$O2'")"
printf '{"kind":"return","reasonCode":"change_of_mind","items":[{"orderItemId":"%s","quantity":6}]}' "$ITEM2" > "$TMP/ret2.json"
RID2="$(curl -s -b "$B2" -X POST "$SHOP/orders/$O2/returns" -H 'content-type: application/json' --data-binary "@$TMP/ret2.json" | jq_get "['id']")"
for st in approved picked_up received completed; do
  curl -s -b "$CK" -X PUT "$SHOP/admin/returns/$RID2" -H 'content-type: application/json' -d "{\"status\":\"$st\"}" >/dev/null
done
recompute >/dev/null
check "전량 반품하면 실적에서 빠져 강등 (사서 반품하기 우회 차단)" \
  "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b2@gr.test'")" "실버"

echo "══ 등급 삭제 ══"
contains "관리자 목록에 인원 수" "$(curl -s -b "$CK" "$SHOP/admin/grades")" '"members":'
curl -s -b "$CK" -X DELETE "$SHOP/admin/grades/$GOLD_ID" >/dev/null
check "골드 삭제됨" "$(psql_q "SELECT count(*) FROM shop_grades WHERE name='골드'")" "0"
check "배정도 함께 사라짐 (CASCADE)" \
  "$(psql_q "SELECT count(*) FROM shop_user_grades ug JOIN users u ON u.id=ug.user_id WHERE u.email='b1@gr.test'")" "0"
QDEL="$(curl -s -b "$B1" -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json")"
check "삭제 직후 할인 0 (없는 등급으로 할인되면 안 된다)" "$(echo "$QDEL" | jq_get "['gradeDiscount']")" "0"
recompute >/dev/null
check "재계산하면 남은 등급으로 배정 (12만 → 실버)" \
  "$(psql_q "SELECT g.name FROM shop_user_grades ug JOIN shop_grades g ON g.id=ug.grade_id JOIN users u ON u.id=ug.user_id WHERE u.email='b1@gr.test'")" "실버"

echo "── 관리 화면 등록"
contains "등급 리소스" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"name":"grades"'

echo "── 탈퇴 시 배정 삭제"
WD="$(curl -s -b "$B3" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123","deletePosts":false,"reason":"검증"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
check "배정이 지워졌다" \
  "$(psql_q "SELECT count(*) FROM shop_user_grades ug JOIN users u ON u.id=ug.user_id WHERE u.email='b3@gr.test'")" "0"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
