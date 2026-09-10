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
# 캡차 발급 → 토큰과 정답.
#
# 정답은 서버가 BRICK_CAPTCHA=test 일 때만 응답에 실어준다(아래 export 참고).
# 예전에는 SVG 의 <text> 를 정규식으로 긁어 읽으면서 "실제 봇에게는 이 정보가 없다"고
# 적어두었는데, 봇에게도 똑같이 있었다 — 캡차가 아무도 막지 못하고 있었다.
# 스모크가 정답을 알 수 있는 유일한 길이 서버의 명시적 테스트 설정이어야 한다.
captcha_issue() {
  curl -s "$API/api/captcha" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(d["token"] + "|" + d.get("answer", ""))'
}
# 캡차를 풀어 회원가입한다
register_with_captcha() { # <email> <password> <displayName> <파일경로>
  local tk an
  IFS='|' read -r tk an <<< "$(captcha_issue)"
  printf '{"email":"%s","password":"%s","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"%s","captchaToken":"%s","captchaAnswer":"%s"}' \
    "$1" "$2" "$3" "$tk" "$an" > "$4"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$4"
}


echo "▶ 보안·결제 스모크 테스트"

# 매번 빈 DB에서 시작한다 — 스모크 테스트는 "설치 전" 상태를 전제로 한다.
# (로컬 반복 실행 시 이전 데이터가 남아 실패하는 것을 막는다)
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi


# 캡차를 켠 채로 돈다. 다른 스모크는 전부 off 로 도는데, 그 탓에 "서버는 캡차를
# 요구하는데 화면에 칸이 없다"를 아무도 보지 못한 적이 있다. test 는 진짜 캡차에
# 정답만 얹어주는 모드다 — 컨트롤러가 실제로 검증하는 경로를 그대로 지난다.
export BRICK_CAPTCHA=test

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
# 활성화만으로는 노출되지 않는다 — 키를 넣지 않은 PG 를 손님에게 보여주면
# 고르는 순간 실패하고, 사이트가 고장난 것처럼 보인다 (ADR-58)
absent "활성화만으로는 노출되지 않는다 (설정 전)" "$(curl -s "$SHOP/payment-methods")" '"toss"'
curl -s -b "$CK" -X PUT "$API/api/plugins/brick-pay-toss/admin/config" -H 'content-type: application/json' \
  -d '{"secretKey":"test_sk_dummy","clientKey":"test_ck_dummy","enabled":true}' >/dev/null
contains "PG 플러그인이 훅으로 결제수단 추가 (설정 후)" "$(curl -s "$SHOP/payment-methods")" '"toss"'
# 껐다 켤 수 있어야 한다 — 점검 중에 결제를 막는 흔한 운영 작업이다
curl -s -b "$CK" -X PUT "$API/api/plugins/brick-pay-toss/admin/config" -H 'content-type: application/json' \
  -d '{"secretKey":"test_sk_dummy","clientKey":"test_ck_dummy","enabled":false}' >/dev/null
absent "끄면 다시 사라진다" "$(curl -s "$SHOP/payment-methods")" '"toss"'
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
register_with_captcha "member@sec.test" "oldpass123" "홍길동" "$TMP/reg.json" >/dev/null
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

echo "── 캡차 (스팸 방지)"
CAP="$(curl -s "$API/api/captcha")"
contains "SVG 이미지 발급" "$CAP" "<svg"
contains "provider 표시" "$CAP" '"provider":"svg'
contains "활성 상태" "$CAP" '"enabled":true'
contains "캐시 금지 헤더" "$(curl -sI "$API/api/captcha")" "no-store"
# 글자는 선으로 그린다. <text> 로 그리면 정답이 마크업에 평문으로 박혀 봇이 그냥 읽는다.
# (암호적 성질 전체는 scripts/check-captcha-secrecy.mjs 가 본다)
absent "정답이 마크업에 남지 않는다" "$CAP" "<text"
# 두 번 발급하면 다른 문제여야 한다
A1="$(captcha_issue | cut -d'|' -f2)"
A2="$(captcha_issue | cut -d'|' -f2)"
[[ "$A1" != "$A2" ]] && ok "발급마다 다른 문제" || bad "발급마다 다른 문제"
[[ ${#A1} -eq 5 ]] && ok "문자 5자" || bad "문자 5자 (실제 ${#A1})"

# 회원가입에 캡차 강제
printf '{"email":"nocap@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"봇"}' > "$TMP/nocap.json"
check "캡차 없는 가입 차단" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/nocap.json")" "400"
# 어느 칸을 고쳐야 하는지 알려준다 — 캡차는 손님이 가장 자주 틀리는 칸이다
contains "캡차 오류도 어느 칸인지" \
  "$(post "$API/api/register" "$TMP/nocap.json")" '"field":"captchaAnswer"'

IFS='|' read -r CTK CAN <<< "$(captcha_issue)"
printf '{"email":"wrongcap@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"봇","captchaToken":"%s","captchaAnswer":"ZZZZZ"}' "$CTK" > "$TMP/wrongcap.json"
check "틀린 답 차단" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/wrongcap.json")" "400"

IFS='|' read -r CTK CAN <<< "$(captcha_issue)"
printf '{"email":"okcap@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"사람","captchaToken":"%s","captchaAnswer":"%s"}' "$CTK" "$CAN" > "$TMP/okcap.json"
check "맞는 답으로 가입 성공" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/okcap.json")" "201"
# 같은 토큰 재사용 — 봇이 한 번 풀고 무한 재사용하는 것을 막아야 한다
printf '{"email":"reuse@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"봇","captchaToken":"%s","captchaAnswer":"%s"}' "$CTK" "$CAN" > "$TMP/reuse.json"
check "토큰 재사용 차단 (1회용)" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reuse.json")" "400"

# 대소문자 무시 (사용자가 틀리면 캡차가 아니라 장벽이 된다)
IFS='|' read -r CTK CAN <<< "$(captcha_issue)"
LOWER="$(echo "$CAN" | tr 'A-Z' 'a-z')"
printf '{"email":"lower@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"사람","captchaToken":"%s","captchaAnswer":"%s"}' "$CTK" "$LOWER" > "$TMP/lower.json"
check "소문자 입력도 통과" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/lower.json")" "201"

# 위조 토큰 — HMAC 서명이 막아야 한다
FORGED="$(python3 -c '
import base64, json, time
p = json.dumps({"a": "AAAAA", "e": int(time.time()*1000)+60000, "n": "fake"}).encode()
print(base64.urlsafe_b64encode(p).decode().rstrip("=") + ".badsignature")')"
printf '{"email":"forged@sec.test","password":"passok1234","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"봇","captchaToken":"%s","captchaAnswer":"AAAAA"}' "$FORGED" > "$TMP/forged.json"
check "위조 토큰 차단 (서명 검증)" "$(code -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/forged.json")" "400"

echo "── 감사 로그"
check "비인증 조회 차단" "$(code "$API/api/audit")" "401"
AUDIT="$(curl -s -b "$CK" "$API/api/audit")"
contains "플러그인 활성화 기록" "$AUDIT" "plugin.activate"
contains "행위자 기록" "$AUDIT" "admin@sec.test"
contains "재설정 완료 기록" "$AUDIT" "auth.password_reset_completed"
absent   "비밀번호/토큰이 로그에 없음" "$AUDIT" "newpass1234"
contains "동작 필터" "$(curl -s -b "$CK" "$API/api/audit?action=plugin.activate")" "plugin.activate"

echo
echo "── 콘텐츠 보안 정책 (CSP) — 저장형 XSS 의 두 번째 방어선"
CSP="$(curl -s -D - -o /dev/null "$API/api/render/page?path=" | grep -i '^content-security-policy:' | tr -d '\r')"
contains "공개 화면에 CSP 가 붙는다" "$CSP" "default-src 'self'"
contains "외부 스크립트를 막는다" "$CSP" "script-src 'self' 'unsafe-inline';"
contains "플러그인·객체 삽입 차단" "$CSP" "object-src 'none'"
contains "base 태그 하이재킹 차단" "$CSP" "base-uri 'self'"
contains "폼 액션 탈취 차단" "$CSP" "form-action 'self'"
contains "클릭재킹 차단" "$CSP" "frame-ancestors 'self'"
# 테마가 선언한 출처만 열린다 (기본 테마는 웹폰트 CDN)
contains "테마 선언이 정책에 들어간다" "$CSP" "https://cdn.jsdelivr.net"
absent "선언하지 않은 곳은 열리지 않는다" "$CSP" "https://fonts.gstatic.com"
# 정적 자산에도 붙는다 — 테마 SVG 를 직접 열었을 때가 사각지대다
contains "정적 자산에도 붙는다" "$(curl -s -o /dev/null -w '%header{content-security-policy}' "$API/themes/default/assets/style.css")" "object-src 'none'"

echo "── CSP 모드 (운영자가 관찰만 하거나 끌 수 있다)"
check "report-only 로 전환" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.csp":"report-only"}')" "200"
RO="$(curl -s -D - -o /dev/null "$API/api/render/page?path=" | tr -d '\r')"
contains "관찰 전용 헤더로 나간다" "$RO" "content-security-policy-report-only:"
absent "그때 강제 헤더는 없다" "$(echo "$RO" | grep -i '^content-security-policy:')" "default-src"
check "끄면 헤더가 없다" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.csp":"off"}' -o /dev/null; curl -s -o /dev/null -w '%header{content-security-policy}%header{content-security-policy-report-only}' "$API/api/render/page?path=")" ""
check "오타는 거부한다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.csp":"yes"}')" "400"
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.csp":"on"}' -o /dev/null

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
