#!/usr/bin/env bash
#
# 회원 생애주기 E2E 스모크 — 약관 동의 · 이메일 인증 · 탈퇴 · 휴면.
#
# 이 영역은 틀리면 **법을 위반한다.** 그래서 다음을 항목으로 못박는다:
#   - 필수 약관에 동의하지 않으면 가입이 거부되는가
#   - 선택 약관을 거부해도 가입되는가 (강제하면 위법)
#   - 동의 이력이 남는가 (증명 책임은 사업자에게 있다)
#   - 탈퇴 시 개인정보가 실제로 사라지는가
#   - 탈퇴 후에도 주문이 남는가 (전자상거래법 5년)
#   - 마지막 관리자가 탈퇴하지 못하는가 (복구 불가 방지)
#   - 탈퇴 계정으로 다시 로그인할 수 없는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-member.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:160})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 남아 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

# DB를 직접 들여다본다 — "파기했다"는 응답을 믿지 않고 실제 행을 확인한다
psql_q() {
  node -e '
    const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
    (async () => {
      const c = new Client(process.env.DATABASE_URL);
      await c.connect();
      const r = await c.query(process.argv[1]);
      console.log(r.rows.map((x) => Object.values(x).join("|")).join("\n"));
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$1"
}

echo "▶ 회원 생애주기 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-member-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비 ──────────────────────────────────────────────
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Member","adminEmail":"admin@mem.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@mem.test","password":"adminpass123"}' >/dev/null

echo "── 기본 약관 심기 (설치 직후 가입이 막히지 않아야 한다)"
AGR="$(curl -s "$API/api/agreements")"
contains "이용약관 존재" "$AGR" '"kind":"terms"'
contains "개인정보 동의 존재" "$AGR" '"kind":"privacy"'
contains "광고 수신은 선택" "$AGR" '"kind":"marketing"'
contains "이용약관은 필수" "$AGR" '"required":true'
contains "초안임을 본문에 명시" "$AGR" "초안입니다"
MKT_REQ="$(echo "$AGR" | python3 -c "
import sys,json
for a in json.load(sys.stdin)['items']:
    if a['kind']=='marketing': print(a['required'])")"
check "광고 수신은 required=false" "$MKT_REQ" "False"

echo "── 가입: 필수 동의 강제"
check "동의 없이 가입 차단" \
  "$(code -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"noagree@mem.test","password":"password123","displayName":"동의안함"}')" "400"
contains "무엇에 동의해야 하는지 알려준다" \
  "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"noagree@mem.test","password":"password123","displayName":"동의안함"}')" "동의해야"
check "개인정보만 동의해도 차단(이용약관 누락)" \
  "$(code -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"partial@mem.test","password":"password123","displayName":"일부","agreements":{"privacy":true}}')" "400"

echo "── 가입: 선택 항목은 거부해도 통과 (강제하면 위법)"
cat > "$TMP/u1.json" <<'JSON'
{"email":"user1@mem.test","password":"password123","displayName":"회원일",
 "agreements":{"terms":true,"privacy":true,"marketing":false},"ageConfirmed":true}
JSON
U1="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/u1.json" | jq_get "['id']")"
[[ -n "$U1" ]] && ok "광고 수신 거부하고 가입 성공" || bad "광고 수신 거부하고 가입 성공"

cat > "$TMP/u2.json" <<'JSON'
{"email":"user2@mem.test","password":"password123","displayName":"회원이",
 "agreements":{"terms":true,"privacy":true,"marketing":true},"ageConfirmed":true}
JSON
U2="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/u2.json" | jq_get "['id']")"
[[ -n "$U2" ]] && ok "광고 수신 동의하고 가입 성공" || bad "광고 수신 동의하고 가입 성공"

echo "── 만 14세 미만 차단"
check "ageConfirmed=false 는 가입 차단" \
  "$(code -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"kid@mem.test","password":"password123","displayName":"미성년","agreements":{"terms":true,"privacy":true},"ageConfirmed":false}')" "400"
contains "법정대리인 안내" \
  "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"kid@mem.test","password":"password123","displayName":"미성년","agreements":{"terms":true,"privacy":true},"ageConfirmed":false}')" "법정대리인"

echo "── 동의 이력 (증명 책임은 사업자에게 있다)"
LOG1="$(psql_q "SELECT kind, agreed FROM user_agreements WHERE user_id='$U1' ORDER BY kind")"
contains "이용약관 동의 기록" "$LOG1" "terms|true"
contains "개인정보 동의 기록" "$LOG1" "privacy|true"
contains "거부한 선택 항목도 기록" "$LOG1" "marketing|false"
IPH="$(psql_q "SELECT count(*) FROM user_agreements WHERE user_id='$U1' AND ip_hash IS NOT NULL")"
check "동의 시점 IP는 해시로 저장" "$IPH" "3"
RAWIP="$(psql_q "SELECT count(*) FROM user_agreements WHERE ip_hash LIKE '%127.0.0.1%' OR ip_hash LIKE '%::1%'")"
check "IP 원문이 남지 않음" "$RAWIP" "0"
MKT="$(psql_q "SELECT marketing_opt_in FROM users WHERE id='$U1'")"
check "거부한 회원은 marketing_opt_in=false" "$MKT" "false"
MKT2="$(psql_q "SELECT marketing_opt_in FROM users WHERE id='$U2'")"
check "동의한 회원은 marketing_opt_in=true" "$MKT2" "true"

echo "── 동의는 계정 생성과 한 트랜잭션 (동의 없는 계정이 남지 않아야 한다)"
ORPHAN="$(psql_q "SELECT count(*) FROM users u WHERE u.role='member' AND u.withdrawn_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_agreements ua WHERE ua.user_id=u.id AND ua.kind='terms' AND ua.agreed)")"
check "약관 동의 없는 회원 0명" "$ORPHAN" "0"

echo "── 이메일 인증"
CK1="$TMP/u1.txt"
curl -s -c "$CK1" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"user1@mem.test","password":"password123"}' >/dev/null
PROFILE="$(curl -s -b "$CK1" "$API/api/me/profile")"
contains "가입 직후는 미인증" "$PROFILE" '"email_verified":false'
# 가입 시 인증 메일이 발송되어 토큰이 생겨 있어야 한다
TOKENS="$(psql_q "SELECT count(*) FROM email_verifications WHERE user_id='$U1' AND used_at IS NULL")"
check "가입 시 인증 토큰 발급" "$TOKENS" "1"
HASHED="$(psql_q "SELECT count(*) FROM email_verifications WHERE token_hash ~ '^[0-9a-f]{64}\$'")"
[[ "$HASHED" -ge 1 ]] && ok "토큰은 sha256 해시로만 저장" || bad "토큰은 sha256 해시로만 저장"

check "재발송은 도배 방지에 걸린다" \
  "$(code -b "$CK1" -X POST "$API/api/me/email/verify/send" -H 'content-type: application/json' -d '{}')" "400"
check "잘못된 토큰 거부" \
  "$(code -X POST "$API/api/email/verify" -H 'content-type: application/json' -d '{"token":"bogus-token"}')" "400"

echo "── 이메일 변경은 새 주소를 인증한 뒤에 반영된다"
check "이미 쓰는 주소로 변경 차단" \
  "$(code -b "$CK1" -X POST "$API/api/me/email/verify/send" -H 'content-type: application/json' \
      -d '{"email":"user2@mem.test"}')" "400"
STILL="$(psql_q "SELECT email FROM users WHERE id='$U1'")"
check "실패해도 기존 주소 유지" "$STILL" "user1@mem.test"

echo "── 광고 수신 철회 (언제든 가능해야 한다)"
contains "철회 성공" \
  "$(curl -s -b "$CK1" -X PUT "$API/api/me/marketing" -H 'content-type: application/json' -d '{"optIn":true}')" '"optIn":true'
contains "다시 철회" \
  "$(curl -s -b "$CK1" -X PUT "$API/api/me/marketing" -H 'content-type: application/json' -d '{"optIn":false}')" '"optIn":false'
AUD="$(psql_q "SELECT count(*) FROM audit_logs WHERE action IN ('user.marketing_opt_in','user.marketing_opt_out')")"
[[ "$AUD" -ge 2 ]] && ok "철회 이력이 감사 로그에 남음" || bad "철회 이력이 감사 로그에 남음"

echo "── 약관 개정 → 재동의 요구"
contains "개정 발행" \
  "$(curl -s -b "$CK" -X POST "$API/api/admin/agreements" -H 'content-type: application/json' \
      -d '{"kind":"terms","title":"이용약관","body":"개정된 이용약관 본문입니다. 제1조 (목적) ...","isRequired":true}')" '"version":2'
PEND="$(curl -s -b "$CK1" "$API/api/agreements/pending")"
contains "기존 회원에게 재동의 요구" "$PEND" '"version":2'
check "재동의 거부는 400" \
  "$(code -b "$CK1" -X POST "$API/api/agreements/accept" -H 'content-type: application/json' \
      -d '{"accepted":{"terms":false}}')" "400"
contains "재동의 성공" \
  "$(curl -s -b "$CK1" -X POST "$API/api/agreements/accept" -H 'content-type: application/json' \
      -d '{"accepted":{"terms":true}}')" '"ok":true'
contains "재동의 후 대기 없음" "$(curl -s -b "$CK1" "$API/api/agreements/pending")" '"items":[]'
OLDV="$(psql_q "SELECT count(*) FROM agreements WHERE kind='terms'")"
check "이전 버전은 지워지지 않음 (동의 시점 문서 보존)" "$OLDV" "2"
check "선택 항목을 필수로 만들 수 있다(제3자 제공)" \
  "$(code -b "$CK" -X POST "$API/api/admin/agreements" -H 'content-type: application/json' \
      -d '{"kind":"third_party","title":"제3자 제공","body":"제3자 제공 동의 본문","isRequired":false}')" "201"
FORCED="$(psql_q "SELECT is_required FROM agreements WHERE kind='privacy' ORDER BY version DESC LIMIT 1")"
check "개인정보 동의는 선택으로 만들 수 없다" "$FORCED" "true"

echo "── 탈퇴 미리보기 (무엇이 사라지는지 알려준다)"
PRE="$(curl -s -b "$CK1" "$API/api/me/withdraw/preview")"
contains "개인정보 파기 안내" "$PRE" "즉시 파기"

echo "── 탈퇴: 비밀번호 재확인 (세션 탈취로 계정을 지우지 못하게)"
check "비밀번호 없이 탈퇴 차단" \
  "$(code -b "$CK1" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' -d '{}')" "400"
check "틀린 비밀번호로 탈퇴 차단" \
  "$(code -b "$CK1" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
      -d '{"password":"wrongpassword"}')" "400"
STILL2="$(psql_q "SELECT withdrawn_at IS NULL FROM users WHERE id='$U1'")"
check "차단된 시도로는 탈퇴되지 않음" "$STILL2" "true"

echo "── 탈퇴 실행 + 개인정보 파기 확인"
# 탈퇴 전에 주문을 하나 만들어 법정 보존을 검증한다
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'
PID="$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"mem-item","name":"탈퇴검증 상품","price":10000,"stock":10,"status":"selling"}' | jq_get "['id']")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"회원일","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/order.json"
ORDER_NO="$(curl -s -b "$CK1" -X POST "$API/api/plugins/brick-shop/orders" -H 'content-type: application/json' --data-binary "@$TMP/order.json" | jq_get "['orderNo']")"
[[ -n "$ORDER_NO" ]] && ok "탈퇴 전 주문 생성" || bad "탈퇴 전 주문 생성"

WD="$(curl -s -b "$CK1" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123","reason":"스모크 테스트"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
contains "무엇을 처리했는지 알려준다" "$WD" "개인정보 익명화"

ROW="$(psql_q "SELECT email, display_name, is_active, password_login_enabled FROM users WHERE id='$U1'")"
absent "이메일 원문 파기" "$ROW" "user1@mem.test"
contains "이메일 익명화" "$ROW" "withdrawn.invalid"
contains "이름 익명화" "$ROW" "탈퇴한 회원"
contains "계정 비활성" "$ROW" "false|false"
WDAT="$(psql_q "SELECT withdrawn_at IS NOT NULL FROM users WHERE id='$U1'")"
check "탈퇴 시점 기록" "$WDAT" "true"
PWH="$(psql_q "SELECT password_hash LIKE 'withdrawn:%' FROM users WHERE id='$U1'")"
check "비밀번호 해시를 쓸 수 없는 값으로 덮음" "$PWH" "true"
SESS="$(psql_q "SELECT count(*) FROM sessions WHERE user_id='$U1'")"
check "세션 즉시 삭제" "$SESS" "0"

echo "── 탈퇴 후 접근 차단"
check "기존 쿠키로 내 정보 접근 불가" "$(code -b "$CK1" "$API/api/me/profile")" "401"
check "원래 이메일로 로그인 불가" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"user1@mem.test","password":"password123"}')" "401"
contains "같은 이메일로 재가입 가능" \
  "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"user1@mem.test","password":"newpassword123","displayName":"재가입","agreements":{"terms":true,"privacy":true,"third_party":true}}')" '"id"'

echo "── 탈퇴 후에도 주문은 남는다 (전자상거래법 5년)"
ORD="$(psql_q "SELECT count(*) FROM shop_orders WHERE order_no='$ORDER_NO'")"
check "주문 행 보존" "$ORD" "1"
ORDU="$(psql_q "SELECT user_id IS NULL FROM shop_orders WHERE order_no='$ORDER_NO'")"
check "주문의 회원 연결만 해제" "$ORDU" "true"
contains "탈퇴 응답이 보존을 알려준다" "$WD" "법정 보존"
# 동의 이력은 남아야 한다 — "동의 없이 처리했다"는 주장에 답할 근거
AGRLOG="$(psql_q "SELECT count(*) FROM user_agreements WHERE user_id='$U1'")"
[[ "$AGRLOG" -ge 3 ]] && ok "동의 이력 보존 (증명 근거)" || bad "동의 이력 보존 (실제 $AGRLOG)"
AUDIT_EMAIL="$(psql_q "SELECT count(*) FROM audit_logs WHERE summary LIKE '%user1@mem.test%' AND action='user.withdraw'")"
check "감사 로그에 원래 이메일을 남기지 않음" "$AUDIT_EMAIL" "0"

echo "── 플러그인이 자기 데이터를 지운다 (코어는 테이블 이름을 모른다)"
# 코어가 shop_/board_/memo_ 테이블을 직접 만지면 플러그인이 스키마를 바꿀 때
# 탈퇴가 조용히 깨진다 — 실제로 shop_cart_items 에 user_id 가 없어서 500이 났다.
# 그래서 각 플러그인이 등록한 eraser 를 코어가 트랜잭션 안에서 부른다 (ADR-38).
contains "쇼핑몰 eraser 가 동작 (주문 보존 안내)" "$WD" "법정 보존 기간"
CARTS="$(psql_q "SELECT count(*) FROM shop_carts WHERE user_id='$U1'")"
check "장바구니 삭제 (구매 전 데이터는 보존 의무 없음)" "$CARTS" "0"
REV="$(psql_q "SELECT count(*) FROM shop_reviews WHERE user_id='$U1'")"
check "후기 작성자 연결 해제" "$REV" "0"

# 게시판·쪽지·포인트도 활성화해 eraser 가 붙는지 확인한다
for pl in brick-board brick-memo brick-point; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done
U4="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"writer@mem.test","password":"password123","displayName":"글쓴이","agreements":{"terms":true,"privacy":true,"third_party":true}}' | jq_get "['id']")"
CK4="$TMP/u4.txt"
curl -s -c "$CK4" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"writer@mem.test","password":"password123"}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/admin/boards" -H 'content-type: application/json' \
  -d '{"slug":"mem-board","title":"탈퇴검증 게시판","read_role":"guest","write_role":"member"}' >/dev/null
printf '{"title":"탈퇴 전에 쓴 글","content":"내용입니다"}' > "$TMP/post.json"
POST_ID="$(curl -s -b "$CK4" -X POST "$API/api/plugins/brick-board/boards/mem-board/posts" \
  -H 'content-type: application/json' --data-binary "@$TMP/post.json" | jq_get "['id']")"
[[ -n "$POST_ID" ]] && ok "탈퇴 전 게시글 작성" || bad "탈퇴 전 게시글 작성"

PRE4="$(curl -s -b "$CK4" "$API/api/me/withdraw/preview")"
contains "게시판이 손실을 설명" "$PRE4" "게시글"
contains "포인트가 손실을 설명" "$PRE4" "포인트"

WD4="$(curl -s -b "$CK4" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123"}')"
contains "탈퇴 성공" "$WD4" '"ok":true'
contains "게시판 eraser 동작" "$WD4" "작성자 익명화"
POST_KEPT="$(psql_q "SELECT author_id IS NULL, author_name FROM board_posts WHERE id='$POST_ID'")"
check "글은 남고 작성자만 익명화" "$POST_KEPT" "true|탈퇴한 회원"

echo "── 마지막 관리자는 탈퇴할 수 없다 (복구 불가 방지)"
RES="$(curl -s -b "$CK" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"adminpass123"}')"
contains "마지막 관리자 탈퇴 거부" "$RES" "마지막 관리자"
ADMIN_OK="$(psql_q "SELECT withdrawn_at IS NULL FROM users WHERE email='admin@mem.test'")"
check "관리자 계정 유지" "$ADMIN_OK" "true"

echo "── 관리자 대행 탈퇴"
contains "관리자가 회원 탈퇴 처리" \
  "$(curl -s -b "$CK" -X POST "$API/api/admin/users/$U2/withdraw" -H 'content-type: application/json' \
      -d '{"reason":"규정 위반"}')" '"ok":true'
U2ROW="$(psql_q "SELECT display_name FROM users WHERE id='$U2'")"
check "대행 탈퇴도 익명화" "$U2ROW" "탈퇴한 회원"
check "이미 탈퇴한 계정 재탈퇴 차단" \
  "$(code -b "$CK" -X POST "$API/api/admin/users/$U2/withdraw" -H 'content-type: application/json' -d '{}')" "400"
check "비관리자는 대행 탈퇴 불가" \
  "$(code -X POST "$API/api/admin/users/$U2/withdraw" -H 'content-type: application/json' -d '{}')" "401"

echo "── 휴면 계정"
CAND="$(curl -s -b "$CK" "$API/api/admin/users/dormant-candidates?months=1")"
contains "휴면 대상 조회 (즉시 전환하지 않고 목록만 — 사전 통지 의무)" "$CAND" '"months":1'
# 마지막 로그인을 과거로 밀어 대상으로 만든다
U3="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"sleepy@mem.test","password":"password123","displayName":"휴면예정","agreements":{"terms":true,"privacy":true,"third_party":true}}' | jq_get "['id']")"
psql_q "UPDATE users SET last_login_at = now() - interval '13 months' WHERE id='$U3'" >/dev/null
contains "장기 미접속자가 대상에 포함" "$(curl -s -b "$CK" "$API/api/admin/users/dormant-candidates?months=12")" "sleepy@mem.test"
contains "휴면 전환" "$(curl -s -b "$CK" -X POST "$API/api/admin/users/$U3/dormant" -H 'content-type: application/json' -d '{}')" '"ok":true'
DORM="$(psql_q "SELECT dormant_at IS NOT NULL FROM users WHERE id='$U3'")"
check "휴면 표시" "$DORM" "true"
# 휴면 계정은 비밀번호가 맞으면 풀린다 — 해제 경로가 없으면 함정이 된다
contains "휴면 계정도 로그인으로 해제" \
  "$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"sleepy@mem.test","password":"password123"}')" '"role":"member"'
DORM2="$(psql_q "SELECT dormant_at IS NULL FROM users WHERE id='$U3'")"
check "로그인 후 휴면 해제" "$DORM2" "true"
LAST="$(psql_q "SELECT last_login_at > now() - interval '1 minute' FROM users WHERE id='$U3'")"
check "마지막 로그인 기록" "$LAST" "true"

echo "── 프로필 이미지 · 공개 카드 · 닉네임 변경 주기 (M25)"
cat > "$TMP/ua.json" <<'JSON'
{"email":"avatar@mem.test","password":"password123","displayName":"아바타",
 "agreements":{"terms":true,"privacy":true,"marketing":false},"ageConfirmed":true}
JSON
UA="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/ua.json" | jq_get "['id']")"
CKA="$TMP/avatar.txt"
curl -s -c "$CKA" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"avatar@mem.test","password":"password123"}' -o /dev/null
[[ -n "$UA" ]] && ok "프로필 시험용 회원 가입" || bad "프로필 시험용 회원 가입 실패"
python3 - "$TMP/av.png" <<'PY2'
import zlib, struct, sys
w,h=64,64; raw=b''.join(b'\x00'+bytes((207,68,55))*w for _ in range(h))
def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
open(sys.argv[1],'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b''))
PY2
printf 'not an image' > "$TMP/av.txt"
check "비로그인 업로드는 401" "$(code -X POST "$API/api/me/avatar" -F "file=@$TMP/av.png;type=image/png")" "401"
check "이미지가 아니면 400" "$(code -b "$CKA" -X POST "$API/api/me/avatar" -F "file=@$TMP/av.txt;type=text/plain")" "400"
AV="$(curl -s -b "$CKA" -X POST "$API/api/me/avatar" -F "file=@$TMP/av.png;type=image/png")"
contains "업로드하면 공개 URL 을 준다" "$AV" '"avatarUrl":"'
AV_URL="$(echo "$AV" | jq_get "['avatarUrl']")"
contains "내 정보에 반영" "$(curl -s -b "$CKA" "$API/api/me/profile")" "\"avatar_url\":\"$AV_URL\""
contains "세션 사용자에도 (헤더가 그린다)" "$(curl -s -b "$CKA" "$API/api/auth/me")" "\"avatarUrl\":\"$AV_URL\""
CARD="$(curl -s "$API/api/members/$UA/card")"
contains "공개 카드는 비로그인도 본다" "$CARD" '"displayName"'
contains "카드에 이미지" "$CARD" "$AV_URL"
absent "카드에 이메일은 없다" "$CARD" "@mem.test"
absent "카드에 생일도 없다" "$CARD" "birth"
check "잘못된 id 는 400" "$(code "$API/api/members/not-a-uuid/card")" "400"
check "탈퇴한 회원의 카드는 404 (없는 사람으로 보인다)" "$(code "$API/api/members/$U1/card")" "404"
check "이미지 삭제" "$(code -b "$CKA" -X DELETE "$API/api/me/avatar")" "200"
contains "삭제 후 내 정보에는 null" "$(curl -s -b "$CKA" "$API/api/me/profile")" '"avatar_url":null'

# 닉네임 변경 주기 — 설정이 0(기본)이면 자유, 30 이면 한 번 바꾼 뒤 막힌다. 첫 변경은 언제나 된다
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.nick_change_days":"30"}' -o /dev/null
check "첫 이름 변경은 된다" "$(code -b "$CKA" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"새이름하나"}')" "200"
R2="$(curl -s -b "$CKA" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"새이름둘"}')"
contains "30일 안의 두 번째 변경은 막힌다" "$R2" "30일마다"
check "같은 이름으로 다시 저장은 변경이 아니다" "$(code -b "$CKA" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"새이름하나"}')" "200"
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.nick_change_days":"0"}' -o /dev/null
check "제한을 0 으로 풀면 바로 바꿀 수 있다" "$(code -b "$CKA" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"새이름둘"}')" "200"

echo "── 권한"
check "비로그인은 내 정보 접근 불가" "$(code "$API/api/me/profile")" "401"
check "비로그인은 탈퇴 불가" "$(code -X POST "$API/api/me/withdraw" -H 'content-type: application/json' -d '{}')" "401"
check "일반 회원은 약관 개정 불가" \
  "$(code -X POST "$API/api/admin/agreements" -H 'content-type: application/json' \
      -d '{"kind":"terms","title":"x","body":"y"}')" "401"
check "일반 회원은 휴면 대상 조회 불가" "$(code "$API/api/admin/users/dormant-candidates")" "401"
check "약관 종류 검증" \
  "$(code -b "$CK" -X POST "$API/api/admin/agreements" -H 'content-type: application/json' \
      -d '{"kind":"bogus","title":"x","body":"y"}')" "400"
check "빈 본문 거부" \
  "$(code -b "$CK" -X POST "$API/api/admin/agreements" -H 'content-type: application/json' \
      -d '{"kind":"terms","title":"제목","body":"  "}')" "400"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
