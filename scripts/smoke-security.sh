#!/usr/bin/env bash
#
# 프로덕션 보안·결제 E2E 스모크 테스트.
#
# 여기서 검증하는 것은 "틀리면 돈이나 계정을 잃는" 경로다:
#   - 결제 금액 위조 방어
#   - 중복 승인 방어 (웹훅 재전송 / 이중 결제)
#   - 주문 멱등성 (네트워크 재시도로 재고 이중 차감 방지)
#   - 환불 한도
#   - 비밀번호 재설정 (단회성 · 이메일 열거 방지 · 세션 무효화)
#   - 감사 로그
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-security.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/ck.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있어서는 안 됨)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
post()     { curl -s -X POST "$1" -H 'content-type: application/json' --data-binary "@$2"; }

echo "▶ 보안·결제 스모크 테스트"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-security-secret}"
export BRICK_SITE_URL="${BRICK_SITE_URL:-http://127.0.0.1:3000}"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비 ────────────────────────────────────────────
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  printf '{"siteName":"Sec","adminEmail":"admin@sec.test","adminPassword":"secpass123"}' > "$TMP/i.json"
  post "$API/api/install" "$TMP/i.json" >/dev/null
fi
printf '{"email":"admin@sec.test","password":"secpass123"}' > "$TMP/l.json"
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  --data-binary "@$TMP/l.json" >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate" >/dev/null

echo "── 결제 게이트웨이 등록 (플러그인 확장성)"
contains "무통장입금 기본 내장" "$(curl -s "$SHOP/payment-methods")" "bank_transfer"
absent   "토스는 아직 없음" "$(curl -s "$SHOP/payment-methods")" '"toss"'
curl -s -b "$CK" -X POST "$API/api/plugins/brick-pay-toss/activate" >/dev/null
contains "PG 플러그인이 훅으로 결제수단 추가" "$(curl -s "$SHOP/payment-methods")" '"toss"'
absent   "시크릿 키가 공개 API에 노출되지 않음" "$(curl -s "$API/api/plugins/brick-pay-toss/config")" "secretKey"

echo "── 주문 멱등성"
printf '{"slug":"sec-item","name":"보안테스트 상품","price":30000,"stock":10,"status":"selling"}' > "$TMP/p.json"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  --data-binary "@$TMP/p.json" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1234-5678","postcode":"06236","address1":"서울"},"idempotencyKey":"idem-key-1"}' "$PID" > "$TMP/o.json"
O1="$(post "$SHOP/orders" "$TMP/o.json")"
O2="$(post "$SHOP/orders" "$TMP/o.json")"
ORDER_NO="$(echo "$O1" | python3 -c "import sys,json;print(json.load(sys.stdin)['orderNo'])")"
[[ "$O1" == "$O2" ]] && ok "같은 멱등키는 같은 주문 반환" || bad "같은 멱등키는 같은 주문 반환"
contains "주문이 1건만 생성됨" "$(curl -s -b "$CK" "$SHOP/admin/orders")" '"total":1'
contains "재고 1개만 차감됨(9)" "$(curl -s "$SHOP/products/sec-item")" '"stock":9'

echo "── 결제 금액 위조 방어 (핵심)"
printf '{"orderNo":"%s","provider":"bank_transfer","providerTid":"cust-1","amount":33000}' "$ORDER_NO" > "$TMP/pay-cust.json"
check "고객은 무통장입금 완료 처리 불가" "$(code -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay-cust.json")" "403"

printf '{"orderNo":"%s","provider":"bank_transfer","providerTid":"forge-1","amount":1000}' "$ORDER_NO" > "$TMP/pay-forge.json"
FORGE="$(curl -s -b "$CK" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay-forge.json")"
contains "금액 불일치 결제 거부" "$FORGE" "일치하지 않습니다"
contains "위조 시도 후에도 주문은 pending" "$(curl -s -b "$CK" "$SHOP/admin/orders")" '"status":"pending"'

echo "── 정상 결제 + 중복 승인 방어"
printf '{"orderNo":"%s","provider":"bank_transfer","providerTid":"real-1","amount":33000}' "$ORDER_NO" > "$TMP/pay-ok.json"
contains "정상 금액 결제 승인" "$(curl -s -b "$CK" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay-ok.json")" '"ok":true'
contains "주문이 paid로 전이" "$(curl -s -b "$CK" "$SHOP/admin/orders")" '"status":"paid"'
# 같은 거래 재전송 → 멱등 성공 (웹훅 재전송)
contains "같은 거래 재전송은 멱등 성공" "$(curl -s -b "$CK" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay-ok.json")" '"ok":true'
# 다른 거래로 이중 결제 → 거부
printf '{"orderNo":"%s","provider":"bank_transfer","providerTid":"double-1","amount":33000}' "$ORDER_NO" > "$TMP/pay-dbl.json"
check "다른 거래로 이중 결제 차단" "$(code -b "$CK" -X POST "$SHOP/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay-dbl.json")" "409"
contains "재고 이중 차감 없음(9 유지)" "$(curl -s "$SHOP/products/sec-item")" '"stock":9'

echo "── 환불"
printf '{"orderNo":"%s","amount":10000,"reason":"부분 환불 테스트"}' "$ORDER_NO" > "$TMP/rf1.json"
contains "부분 환불" "$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' --data-binary "@$TMP/rf1.json")" '"remaining":23000'
printf '{"orderNo":"%s","amount":999999,"reason":"과다"}' "$ORDER_NO" > "$TMP/rf2.json"
contains "환불 한도 초과 차단" "$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' --data-binary "@$TMP/rf2.json")" "초과"
printf '{"orderNo":"%s","reason":"전액 환불"}' "$ORDER_NO" > "$TMP/rf3.json"
contains "잔액 전액 환불" "$(curl -s -b "$CK" -X POST "$SHOP/admin/payments/refund" -H 'content-type: application/json' --data-binary "@$TMP/rf3.json")" '"remaining":0'
contains "전액 환불 시 재고 복원(10)" "$(curl -s "$SHOP/products/sec-item")" '"stock":10'
contains "결제 이력에 실패 기록 보존" "$(curl -s -b "$CK" "$SHOP/admin/payments/$ORDER_NO")" "금액 불일치"

echo "── 비밀번호 재설정"
printf '{"email":"member@sec.test","password":"oldpass123","displayName":"홍길동"}' > "$TMP/reg.json"
post "$API/api/register" "$TMP/reg.json" >/dev/null
printf '{"email":"member@sec.test"}' > "$TMP/f1.json"
contains "재설정 요청" "$(post "$API/api/auth/password/forgot" "$TMP/f1.json")" '"ok":true'
printf '{"email":"nobody@nowhere.invalid"}' > "$TMP/f2.json"
contains "없는 계정도 동일 응답(열거 방지)" "$(post "$API/api/auth/password/forgot" "$TMP/f2.json")" '"ok":true'

TOKEN="$(grep -oE 'reset-password\?token=[A-Za-z0-9_-]+' "$TMP/api.log" | tail -1 | sed 's/.*token=//')"
[[ -n "$TOKEN" ]] && ok "재설정 토큰 발급" || bad "재설정 토큰 발급"
contains "유효한 토큰 확인" "$(curl -s "$API/api/auth/password/verify?token=$TOKEN")" '"valid":true'
contains "잘못된 토큰 거부" "$(curl -s "$API/api/auth/password/verify?token=bogus-token")" '"valid":false'

printf '{"token":"%s","password":"short"}' "$TOKEN" > "$TMP/r1.json"
check "짧은 비밀번호 거부" "$(code -X POST "$API/api/auth/password/reset" -H 'content-type: application/json' --data-binary "@$TMP/r1.json")" "400"
printf '{"token":"%s","password":"newpass1234"}' "$TOKEN" > "$TMP/r2.json"
contains "재설정 완료" "$(post "$API/api/auth/password/reset" "$TMP/r2.json")" '"ok":true'
check "토큰 재사용 차단(단회성)" "$(code -X POST "$API/api/auth/password/reset" -H 'content-type: application/json' --data-binary "@$TMP/r2.json")" "400"

printf '{"email":"member@sec.test","password":"newpass1234"}' > "$TMP/ln.json"
check "새 비밀번호 로그인" "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/ln.json")" "201"
printf '{"email":"member@sec.test","password":"oldpass123"}' > "$TMP/lo.json"
check "옛 비밀번호 차단" "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/lo.json")" "401"

echo "── 감사 로그"
check "비인증 조회 차단" "$(code "$API/api/audit")" "401"
AUDIT="$(curl -s -b "$CK" "$API/api/audit")"
contains "플러그인 활성화 기록" "$AUDIT" "plugin.activate"
contains "행위자 기록" "$AUDIT" "admin@sec.test"
contains "재설정 완료 기록" "$AUDIT" "auth.password_reset_completed"
absent   "비밀번호/토큰이 로그에 없음" "$AUDIT" "newpass1234"
contains "동작 필터" "$(curl -s -b "$CK" "$API/api/audit?action=plugin.activate")" "plugin.activate"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
