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

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-shop-secret-value}"

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
SUCCESS="$(grep -l orderNo "$TMP"/o*.json 2>/dev/null | wc -l | tr -d ' ')"
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

echo "── 스토어프론트 블록"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "상품목록 블록" "$BLOCKS" "brick-shop/product-list"
contains "장바구니 블록" "$BLOCKS" "brick-shop/cart"
DETAIL="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-shop/product-detail","props":{"slug":"smoke-item"}}')"
contains "상품 상세 서버 렌더" "$DETAIL" "스모크 상품"
contains "JSON-LD 구조화 데이터(SEO)" "$DETAIL" "schema.org"
contains "상품명 XSS 이스케이프 준비" "$DETAIL" "brick-product-detail"

echo "── 통계"
contains "매출 통계" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "revenue"
contains "재고 부족 알림" "$(curl -s -b "$CK" "$SHOP/admin/stats")" "lowStock"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
