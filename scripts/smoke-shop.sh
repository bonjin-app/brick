#!/usr/bin/env bash
#
# brick-shop 커머스 E2E 스모크 테스트.
#
# 커머스는 틀리면 돈이 새는 영역이므로 다음을 반드시 검증한다:
#   - 가격 조작 방어 (클라이언트 금액을 신뢰하지 않는가)
#   - 재고 동시성 (초과판매가 없는가)
#   - 취소/환불 시 재고 복원
#   - 주문 상태 전이 규칙
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-shop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/cookies.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

echo "▶ brick-shop 커머스 스모크 테스트"

# 매번 빈 DB에서 시작한다 — 스모크 테스트는 "설치 전" 상태를 전제로 한다.
# (로컬 반복 실행 시 이전 데이터가 남아 실패하는 것을 막는다)
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi


export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-shop-secret-value}"
# 후기 작성자를 회원으로 등록해야 하므로 캡차는 끈다 (캡차 자체는 보안 스모크가 검증)
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비: 설치 · 로그인 · 플러그인 활성화 ──────────────
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Shop","adminEmail":"admin@shop.test","adminPassword":"shoppass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@shop.test","password":"shoppass123"}' >/dev/null
contains "쇼핑몰 플러그인 활성화" \
  "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

echo "── 관리자 리소스 자동 등록"
NAV="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "주문 리소스" "$NAV" '"name":"orders"'
contains "상품 리소스" "$NAV" '"name":"products"'
contains "쿠폰 리소스" "$NAV" '"name":"coupons"'
contains "리소스 스키마 조회" \
  "$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/products")" '"basePath":"/admin/products"'

echo "── 상품"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"smoke-item","name":"스모크 상품","price":20000,"list_price":25000,"stock":3,"status":"selling"}' \
  | jq_get "['id']")"
[[ -n "$PID" ]] && ok "상품 등록" || bad "상품 등록"
check "slug 중복 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"smoke-item","name":"중복","price":100,"status":"selling"}')" "409"
check "음수 가격 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"neg","name":"음수","price":-1,"status":"selling"}')" "400"
check "비관리자 상품 등록 차단" \
  "$(code -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"x","name":"x","price":100}')" "403"
contains "공개 상품 목록" "$(curl -s "$SHOP/products")" "스모크 상품"
contains "상품 상세(조회수 증가)" "$(curl -s "$SHOP/products/smoke-item")" '"view_count"'

echo "── 금액 계산 (서버 재계산)"
printf '{"items":[{"productId":"%s","quantity":2}]}' "$PID" > "$TMP/q2.json"
Q="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q2.json")"
contains "상품금액 40000" "$Q" '"subtotal":40000'
contains "배송비 3000" "$Q" '"shippingFee":3000'
# 무료배송 기준(50000) 초과
printf '{"items":[{"productId":"%s","quantity":3}]}' "$PID" > "$TMP/q3.json"
Q3="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q3.json")"
contains "기준 초과 시 무료배송" "$Q3" '"shippingFee":0'

echo "── 쿠폰"
curl -s -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
  -d '{"code":"smoke10","name":"10%","discount_type":"percent","discount_value":10,"max_discount":3000}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":2}],"couponCode":"smoke10"}' "$PID" > "$TMP/qc.json"
contains "정률 할인 상한 적용(4000→3000)" \
  "$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/qc.json")" '"discount":3000'
printf '{"items":[{"productId":"%s","quantity":1}],"couponCode":"NOPE"}' "$PID" > "$TMP/qn.json"
check "없는 쿠폰 차단" \
  "$(code -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/qn.json")" "400"
check "100% 초과 정률 쿠폰 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/coupons" -H 'content-type: application/json' \
      -d '{"code":"bad999","name":"x","discount_type":"percent","discount_value":999}')" "400"

echo "── 장바구니 (비회원)"
printf '{"productId":"%s","quantity":1}' "$PID" > "$TMP/c1.json"
CART="$(curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/c1.json")"
GT="$(echo "$CART" | jq_get "['guestToken']")"
[[ -n "$GT" ]] && ok "비회원 토큰 발급" || bad "비회원 토큰 발급"
printf '{"productId":"%s","quantity":1,"guestToken":"%s"}' "$PID" "$GT" > "$TMP/c2.json"
curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/c2.json" >/dev/null
contains "같은 상품 수량 합산" "$(curl -s "$SHOP/cart?guest=$GT")" '"quantity":2'

echo "── 재고 동시성 (핵심)"
# 재고 3개에 동시 주문 6건 → 정확히 3건만 성공해야 한다
ORDER_BODY_FILE="$TMP/order-body.json"
PIDS=()
for i in $(seq 1 6); do
  printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"손님%s","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울시"}}' "$PID" "$i" > "$ORDER_BODY_FILE.$i"
  curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' \
    --data-binary "@$ORDER_BODY_FILE.$i" -o "$TMP/o$i.json" &
  PIDS+=($!)
done
# API 서버도 백그라운드 작업이므로 bare `wait` 는 영원히 멈춘다 — curl PID만 기다린다
for pid in "${PIDS[@]}"; do wait "$pid" || true; done
# grep 은 매칭이 없으면 1을 반환한다 — pipefail 아래에서 스크립트가 죽어
# "0건 성공"이라는 회귀를 보고하지 못하고 조용히 중단된다
SUCCESS="$( { grep -l orderNo "$TMP"/o*.json 2>/dev/null | wc -l | tr -d ' '; } || true )"
check "동시 주문 6건 중 3건만 성공 (초과판매 없음)" "$SUCCESS" "3"
contains "실패는 명확한 재고 메시지" "$(cat "$TMP"/o*.json)" "재고가"
contains "주문번호 중복 없음(시퀀스)" "$(curl -s -b "$CK" "$SHOP/admin/orders")" '"total":3'

echo "── 재고 소진 후"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"늦은손님","ordererPhone":"010-0000-0000","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/late.json"
check "품절 상품 주문 차단" \
  "$(code -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/late.json")" "409"
# 장바구니는 여전히 조회 가능해야 한다 (재고 부족을 표시만)
LENIENT="$(curl -s "$SHOP/cart?guest=$GT")"
contains "품절이어도 장바구니 조회 가능" "$LENIENT" '"available":false'
contains "품절 사유 표시" "$LENIENT" '"issue"'

echo "── 주문 상태 전이"
OID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
print(json.load(sys.stdin)['items'][0]['id'])")"
check "잘못된 전이 차단(pending→delivered)" \
  "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' \
      -d '{"status":"delivered"}')" "400"
contains "정상 전이(pending→paid)" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID" -H 'content-type: application/json' \
      -d '{"status":"paid"}')" '"ok":true'

echo "── 취소 시 재고 복원"
OID2="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['status'] == 'pending': print(o['id']); break")"
if [[ -n "$OID2" ]]; then
  curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$OID2" -H 'content-type: application/json' \
    -d '{"status":"cancelled","note":"스모크 취소"}' >/dev/null
  contains "취소 후 재고 복원(1개)" "$(curl -s "$SHOP/products/smoke-item")" '"stock":1'
  check "취소된 주문은 전이 불가" \
    "$(code -b "$CK" -X PUT "$SHOP/admin/orders/$OID2" -H 'content-type: application/json' \
        -d '{"status":"paid"}')" "400"
else
  bad "취소 대상 주문 없음"
fi

echo "── 옵션·다중 이미지 (관리 텍스트 편집)"
cat > "$TMP/optprod.json" <<'JSON'
{"slug":"opt-item","name":"옵션 상품","price":10000,"status":"selling","stock":100,
 "images_text":"/uploads/a.jpg\n/uploads/b.jpg",
 "options_text":"색상: 빨강|1000|5\n색상: 파랑||3\n무광"}
JSON
OPID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  --data-binary "@$TMP/optprod.json" | jq_get "['id']")"
[[ -n "$OPID" ]] && ok "옵션·이미지 포함 상품 등록" || bad "옵션·이미지 포함 상품 등록"
OPDETAIL="$(curl -s "$SHOP/products/opt-item")"
contains "옵션 3개 생성" "$OPDETAIL" '"무광"'
contains "옵션 추가금 반영" "$OPDETAIL" '"extra_price":1000'
contains "다중 이미지 저장" "$OPDETAIL" '/uploads/b.jpg'
contains "대표 이미지 자동 지정(첫 줄)" "$OPDETAIL" '"image_url":"/uploads/a.jpg"'

# 관리 목록은 배열을 텍스트로 되돌려 준다 (선언적 폼이 편집할 수 있는 형태)
ADMIN_LIST="$(curl -s -b "$CK" "$SHOP/admin/products")"
contains "옵션 텍스트 역변환" "$ADMIN_LIST" '색상: 빨강|1000|5'
contains "이미지 텍스트 역변환" "$ADMIN_LIST" '/uploads/a.jpg'

check "옵션 이름 중복 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"dup-opt","name":"x","price":100,"status":"selling","options_text":"빨강|0|1\n빨강|0|2"}')" "400"
check "옵션 재고 음수 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"neg-opt","name":"x","price":100,"status":"selling","options_text":"빨강|0|-5"}')" "400"
check "javascript: 이미지 주소 차단" \
  "$(code -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
      -d '{"slug":"js-img","name":"x","price":100,"status":"selling","images_text":"javascript:alert(1)"}')" "400"

# 옵션 id 유지: 장바구니가 조용히 망가지지 않아야 한다
RED_ID="$(echo "$OPDETAIL" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['options']:
    if '빨강' in o['name']: print(o['id']); break")"
printf '{"productId":"%s","optionId":"%s","quantity":1}' "$OPID" "$RED_ID" > "$TMP/optcart.json"
OGT="$(curl -s -X POST "$SHOP/cart" -H 'content-type: application/json' --data-binary "@$TMP/optcart.json" | jq_get "['guestToken']")"
contains "옵션 담기(추가금 11000원)" "$(curl -s "$SHOP/cart?guest=$OGT")" '"unitPrice":11000'
# 이름을 그대로 두고 하나만 지운 뒤에도 빨강의 id는 살아 있어야 한다
cat > "$TMP/optprod2.json" <<'JSON'
{"slug":"opt-item","name":"옵션 상품","price":10000,"status":"selling","stock":100,
 "images_text":"/uploads/a.jpg",
 "options_text":"색상: 빨강|2000|5\n색상: 파랑||3"}
JSON
curl -s -b "$CK" -X PUT "$SHOP/admin/products/$OPID" -H 'content-type: application/json' \
  --data-binary "@$TMP/optprod2.json" >/dev/null
NEW_RED="$(curl -s "$SHOP/products/opt-item" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['options']:
    if '빨강' in o['name']: print(o['id']); break")"
check "옵션 수정 후 id 유지(장바구니 보존)" "$NEW_RED" "$RED_ID"
OPT_NAMES="$(curl -s "$SHOP/products/opt-item")"
[[ "$OPT_NAMES" != *"무광"* ]] && ok "목록에서 뺀 옵션 삭제" || bad "목록에서 뺀 옵션 삭제"
contains "수정된 추가금 반영" "$(curl -s "$SHOP/cart?guest=$OGT")" '"unitPrice":12000'

echo "── 상품 후기 (구매 검증)"
BCK="$TMP/buyer.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"buyer@shop.test","password":"buyerpass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"구매자"}' >/dev/null
curl -s -c "$BCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"buyer@shop.test","password":"buyerpass123"}' >/dev/null

check "비로그인 후기 작성 차단" \
  "$(code -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"좋아요 정말 좋아요"}')" "401"
contains "미구매 회원은 자격 없음" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"not_purchased"'
check "미구매 회원 후기 작성 차단(핵심)" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"안 사고 쓰는 후기"}')" "403"

# 회원 주문 → 결제 확인까지
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-2222-3333","postcode":"06236","address1":"서울"}}' "$OPID" > "$TMP/border.json"
BORDER="$(curl -s -b "$BCK" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/border.json")"
BORDER_NO="$(echo "$BORDER" | jq_get "['orderNo']")"
[[ -n "$BORDER_NO" ]] && ok "회원 주문 생성" || bad "회원 주문 생성"
BOID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['order_no'] == '$BORDER_NO': print(o['id']); break")"
contains "입금대기 상태에서는 자격 없음" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"not_purchased"'
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$BOID" -H 'content-type: application/json' \
  -d '{"status":"paid"}' >/dev/null
contains "결제 확인 후 자격 획득" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"canWrite":true'

check "짧은 후기 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"굿"}')" "400"
check "범위 밖 별점 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":9,"content":"별점 조작 시도입니다"}')" "400"
RID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
  -d '{"rating":4,"content":"배송이 빠르고 품질이 좋았습니다."}' | jq_get "['id']")"
[[ -n "$RID" ]] && ok "구매자 후기 작성" || bad "구매자 후기 작성"
check "같은 상품 재작성 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
      -d '{"rating":1,"content":"두 번째 후기 시도입니다"}')" "409"
contains "이미 작성 상태 안내" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/reviews/eligibility")" '"reason":"already_written"'

REVIEWS="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "후기 목록 공개" "$REVIEWS" "배송이 빠르고"
contains "구매확인 배지" "$REVIEWS" '"verified":true'
[[ "$REVIEWS" != *'"order_no"'* ]] && ok "주문번호 비노출" || bad "주문번호가 노출됨"
contains "평균 별점 집계" "$REVIEWS" '"average":4'
contains "별점 분포" "$REVIEWS" '"distribution"'
contains "상품에 후기 수 반영" "$(curl -s "$SHOP/products/opt-item")" '"review_count":1'
contains "상품 평점 반영" "$(curl -s "$SHOP/products/opt-item")" '"rating_avg":4'

echo "── 후기 관리 (판매자)"
contains "관리 목록에 후기" "$(curl -s -b "$CK" "$SHOP/admin/reviews")" '"verified":true'
contains "판매자 답변 저장" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
      -d '{"admin_reply":"이용해 주셔서 감사합니다.","is_visible":true}')" '"ok":true'
contains "답변이 고객에게 보임" "$(curl -s "$SHOP/products/$OPID/reviews")" "감사합니다"
curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
  -d '{"admin_reply":"이용해 주셔서 감사합니다.","is_visible":false}' >/dev/null
HIDDEN="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "숨긴 후기는 목록에서 제외" "$HIDDEN" '"total":0'
contains "숨김 시 평점에서 제외" "$(curl -s "$SHOP/products/opt-item")" '"review_count":0'
contains "관리자는 숨긴 후기도 조회" \
  "$(curl -s -b "$CK" "$SHOP/products/$OPID/reviews")" '"is_visible":false'
curl -s -b "$CK" -X PUT "$SHOP/admin/reviews/$RID" -H 'content-type: application/json' \
  -d '{"admin_reply":"","is_visible":true}' >/dev/null
contains "표시 복구 후 평점 재계산" "$(curl -s "$SHOP/products/opt-item")" '"review_count":1'

echo "── 상품 문의"
check "비로그인 문의 차단" \
  "$(code -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
      -d '{"title":"질문","content":"내용"}')" "401"
check "제목 없는 문의 차단" \
  "$(code -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
      -d '{"title":"","content":"내용만 있음"}')" "400"
QID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
  -d '{"title":"배송 기간 문의","content":"언제 도착하나요?"}' | jq_get "['id']")"
[[ -n "$QID" ]] && ok "공개 문의 작성" || bad "공개 문의 작성"
SQID="$(curl -s -b "$BCK" -X POST "$SHOP/products/$OPID/inquiries" -H 'content-type: application/json' \
  -d '{"title":"주소 변경","content":"연락처 010-9999-8888로 변경해주세요","isSecret":true}' | jq_get "['id']")"
[[ -n "$SQID" ]] && ok "비밀 문의 작성" || bad "비밀 문의 작성"

PUBQ="$(curl -s "$SHOP/products/$OPID/inquiries")"
contains "공개 문의는 누구나 봄" "$PUBQ" "언제 도착하나요"
contains "비밀 문의 제목 가림" "$PUBQ" "비밀 문의입니다"
[[ "$PUBQ" != *"010-9999-8888"* ]] && ok "비밀 문의 내용 비노출(개인정보)" || bad "비밀 문의 내용 노출"
contains "작성자는 자기 비밀 문의 열람" \
  "$(curl -s -b "$BCK" "$SHOP/products/$OPID/inquiries")" "010-9999-8888"
contains "관리자는 비밀 문의 열람" \
  "$(curl -s -b "$CK" "$SHOP/products/$OPID/inquiries")" "010-9999-8888"
contains "상품에 문의 수 반영" "$(curl -s "$SHOP/products/opt-item")" '"inquiry_count":2'

contains "관리 목록에 미답변 표시" "$(curl -s -b "$CK" "$SHOP/admin/inquiries")" '"status_label":"미답변"'
contains "문의 답변 저장" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/inquiries/$QID" -H 'content-type: application/json' \
      -d '{"admin_reply":"주문 후 2~3일 내 도착합니다."}')" '"ok":true'
contains "답변 후 상태 변경" "$(curl -s "$SHOP/products/$OPID/inquiries")" '"status":"answered"'
contains "답변 내용 공개" "$(curl -s "$SHOP/products/$OPID/inquiries")" "2~3일"

echo "── 후기·문의 권한"
CCK="$TMP/other.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"other@shop.test","password":"otherpass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"제3자"}' >/dev/null
curl -s -c "$CCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"other@shop.test","password":"otherpass123"}' >/dev/null
check "남의 후기 수정 차단" \
  "$(code -b "$CCK" -X PUT "$SHOP/reviews/$RID" -H 'content-type: application/json' \
      -d '{"rating":1,"content":"남의 후기를 조작합니다"}')" "403"
check "남의 후기 삭제 차단" "$(code -b "$CCK" -X DELETE "$SHOP/reviews/$RID")" "403"
check "남의 문의 삭제 차단" "$(code -b "$CCK" -X DELETE "$SHOP/inquiries/$QID")" "403"
contains "본인 후기 수정" \
  "$(curl -s -b "$BCK" -X PUT "$SHOP/reviews/$RID" -H 'content-type: application/json' \
      -d '{"rating":5,"content":"다시 써보니 더 좋습니다."}')" '"ok":true'
contains "수정 후 평점 재계산" "$(curl -s "$SHOP/products/opt-item")" '"rating_avg":5'

echo "── 후기 XSS (저장형)"
XCK="$TMP/xss.txt"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"xss@shop.test","password":"xsspass123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"<img src=x onerror=alert(1)>"}' >/dev/null
curl -s -c "$XCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"xss@shop.test","password":"xsspass123"}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"엑","ordererPhone":"010-3333-4444","postcode":"06236","address1":"서울"}}' "$OPID" > "$TMP/xorder.json"
XNO="$(curl -s -b "$XCK" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/xorder.json" | jq_get "['orderNo']")"
XOID="$(curl -s -b "$CK" "$SHOP/admin/orders" | python3 -c "
import sys,json
for o in json.load(sys.stdin)['items']:
    if o['order_no'] == '$XNO': print(o['id']); break")"
curl -s -b "$CK" -X PUT "$SHOP/admin/orders/$XOID" -H 'content-type: application/json' -d '{"status":"paid"}' >/dev/null
curl -s -b "$XCK" -X POST "$SHOP/products/$OPID/reviews" -H 'content-type: application/json' \
  -d '{"rating":3,"content":"<script>alert(1)</script>","images":["javascript:alert(1)","/uploads/ok.jpg"]}' >/dev/null
XREV="$(curl -s "$SHOP/products/$OPID/reviews")"
contains "후기 이미지 스킴 필터" "$XREV" '/uploads/ok.jpg'
[[ "$XREV" != *"javascript:alert"* ]] && ok "javascript: 이미지 제거" || bad "javascript: 이미지 통과"
# 렌더 시점 이스케이프 — 상세 블록 안의 클라이언트 스크립트가 esc()를 통과시킨다
contains "후기 영역 서버 렌더 포함" \
  "$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
      -d '{"name":"brick-shop/product-detail","props":{"slug":"opt-item"}}')" "brick-pd-tabs"

echo "── 스토어프론트 블록"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "상품목록 블록" "$BLOCKS" "brick-shop/product-list"
contains "장바구니 블록" "$BLOCKS" "brick-shop/cart"
DETAIL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"smoke-item"}}')"
contains "상품 상세 서버 렌더" "$DETAIL" "스모크 상품"
contains "JSON-LD 구조화 데이터(SEO)" "$DETAIL" "schema.org"
contains "상품명 XSS 이스케이프 준비" "$DETAIL" "brick-product-detail"
contains "후기·문의 탭 렌더" "$DETAIL" "상품후기"
GAL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"opt-item"}}')"
contains "평점 별 표시" "$GAL" "brick-detail-rating"
contains "aggregateRating(SEO)" "$GAL" "AggregateRating"

echo "── 통계"
contains "매출 통계" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "revenue"
contains "재고 부족 알림" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "lowStock"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
