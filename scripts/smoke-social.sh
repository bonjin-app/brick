#!/usr/bin/env bash
#
# 소셜 로그인 E2E 스모크 테스트.
#
# 실제 공급자 대신 표준 OIDC 스텁(scripts/oidc-stub.mjs)에 붙어
# 흐름 전체를 검증한다: 인증 리다이렉트 → state 쿠키 결속 → 코드 교환
# → 프로필 조회 → 계정 생성/연결 → 세션 발급.
#
# 특히 다음 공격을 명시적으로 막는지 본다:
#   - 로그인 CSRF (남의 브라우저에 내 state를 심어 내 계정으로 로그인시키기)
#   - state 위조·만료
#   - 열린 리다이렉트 (next=//evil.com)
#   - 검증되지 않은 이메일로 남의 계정 가져가기
#   - 소셜 전용 계정에 비밀번호 로그인·재설정으로 우회 진입
#   - Client Secret 유출
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-social.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
STUB_PORT="${BRICK_STUB_PORT:-45999}"
API="http://127.0.0.1:${API_PORT}"
STUB="http://127.0.0.1:${STUB_PORT}"
OA="$API/api/auth/oauth"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:160})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 노출됨)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }
psql_one() {
  node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(\`$1\`);
  console.log(r.rows[0] ? String(Object.values(r.rows[0])[0]) : '');
  await c.end();
})();
"
}
# 프로필을 바꿔 다음 로그인 사용자를 지정한다
set_profile() {
  curl -s -X PUT "$STUB/_profile" -H 'content-type: application/json' -d "$1" >/dev/null
}

echo "▶ 소셜 로그인 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

node "$ROOT/scripts/oidc-stub.mjs" --port "$STUB_PORT" > "$TMP/stub.log" 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do
  curl -fsS -X PUT "$STUB/_profile" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.3
done

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-social-secret-value}"
export BRICK_CAPTCHA=off
# 콜백 주소는 siteUrl 기준으로 만들어진다 — 테스트에서는 API를 직접 부르므로
# API 포트를 사이트 주소로 둔다
export BRICK_SITE_URL="$API"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Social","adminEmail":"admin@social.test","adminPassword":"socialpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@social.test","password":"socialpass123"}' >/dev/null

echo "── 설정 전 상태"
contains "설정되지 않으면 공급자 목록이 비어 있다" "$(curl -s "$OA/providers")" '"items":[]'
check "설정되지 않은 공급자는 503" "$(code "$OA/google")" "503"
check "없는 공급자는 400" "$(code "$OA/nope")" "400"

echo "── 관리자 설정"
# 비로그인은 401 (권한 부족이 아니라 신원 미확인)
check "비로그인 설정 조회 차단" "$(code "$OA/admin/providers")" "401"
ADMIN_LIST="$(curl -s -b "$CK" "$OA/admin/providers")"
contains "공급자 목록에 구글" "$ADMIN_LIST" '"name":"google"'
contains "공급자 목록에 카카오" "$ADMIN_LIST" '"name":"kakao"'
contains "공급자 목록에 네이버" "$ADMIN_LIST" '"name":"naver"'
contains "공급자 목록에 사내 SSO" "$ADMIN_LIST" '"name":"oidc"'
contains "Redirect URI 안내" "$ADMIN_LIST" "/api/auth/oauth/google/callback"
absent "clientSecret 미노출" "$ADMIN_LIST" "clientSecret"

check "ID만 있고 비밀키 없이 사용 시도는 400" \
  "$(code -b "$CK" -X PUT "$OA/admin/providers/google" -H 'content-type: application/json' \
      -d '{"enabled":true,"clientId":"only-id"}')" "400"
check "사내 SSO는 주소 없이 사용 불가" \
  "$(code -b "$CK" -X PUT "$OA/admin/providers/oidc" -H 'content-type: application/json' \
      -d '{"enabled":true,"clientId":"c","clientSecret":"s"}')" "400"
check "http(s) 아닌 주소 차단" \
  "$(code -b "$CK" -X PUT "$OA/admin/providers/oidc" -H 'content-type: application/json' \
      -d '{"enabled":true,"clientId":"c","clientSecret":"s","authUrl":"file:///etc/passwd","tokenUrl":"http://x/t","profileUrl":"http://x/p"}')" "400"

cat > "$TMP/oidc.json" <<JSON
{"enabled":true,"clientId":"stub-client","clientSecret":"stub-secret",
 "authUrl":"$STUB/authorize","tokenUrl":"$STUB/token","profileUrl":"$STUB/userinfo"}
JSON
contains "사내 SSO 설정 저장" \
  "$(curl -s -b "$CK" -X PUT "$OA/admin/providers/oidc" -H 'content-type: application/json' \
      --data-binary "@$TMP/oidc.json")" '"ok":true'
contains "저장 후 비밀키 보유 표시" "$(curl -s -b "$CK" "$OA/admin/providers")" '"hasSecret":true'
contains "설정된 공급자가 로그인 화면에 노출" "$(curl -s "$OA/providers")" '"name":"oidc"'
absent "공개 목록에 비밀키 없음" "$(curl -s "$OA/providers")" "Secret"

# 비밀키를 비운 채 저장하면 유지되어야 한다 (사용 여부만 바꾸는 경우)
curl -s -b "$CK" -X PUT "$OA/admin/providers/oidc" -H 'content-type: application/json' \
  -d "{\"enabled\":true,\"clientId\":\"stub-client\",\"authUrl\":\"$STUB/authorize\",\"tokenUrl\":\"$STUB/token\",\"profileUrl\":\"$STUB/userinfo\"}" >/dev/null
contains "비밀키를 비워 저장하면 기존 값 유지" "$(curl -s -b "$CK" "$OA/admin/providers")" '"hasSecret":true'

echo "── 인증 시작"
START="$(curl -s -D "$TMP/h1.txt" -o /dev/null -w "%{http_code} %{redirect_url}" "$OA/oidc?next=/mypage")"
check "302로 공급자에 보낸다" "${START%% *}" "302"
LOCATION="${START#* }"
contains "공급자 인증 주소" "$LOCATION" "$STUB/authorize"
contains "response_type=code" "$LOCATION" "response_type=code"
contains "redirect_uri 전달" "$LOCATION" "callback"
contains "state 전달" "$LOCATION" "state="
contains "state 쿠키 설정" "$(cat "$TMP/h1.txt")" "brick_oauth_state="
contains "state 쿠키는 HttpOnly" "$(cat "$TMP/h1.txt")" "HttpOnly"
contains "state 쿠키 경로는 콜백으로 한정" "$(cat "$TMP/h1.txt")" "Path=/api/auth/oauth"

echo "── 열린 리다이렉트 방어"
# next 는 state 안에 서명되어 들어가므로, 외부 주소는 시작 단계에서 / 로 접힌다
EVIL="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc?next=//evil.example.com/x")"
STATE_EVIL="$(LOC="$EVIL" python3 -c "
import urllib.parse, base64, json, os
q = urllib.parse.parse_qs(urllib.parse.urlparse(os.environ['LOC']).query)
p = q['state'][0].split('.')[0]
p += '=' * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p))['r'])
")"
check "//로 시작하는 next는 /로 접힘" "$STATE_EVIL" "/"

echo "── 첫 로그인 (계정 자동 생성)"
set_profile '{"sub":"sso-1","email":"first@sso.test","email_verified":true,"name":"첫 사용자"}'
# 브라우저처럼 동작한다: 쿠키 항아리를 공유하며 리다이렉트를 따라간다
U1="$TMP/u1.txt"
curl -s -c "$U1" -b "$U1" -L -o /dev/null -D "$TMP/h2.txt" "$OA/oidc?next=/mypage"
contains "세션 쿠키 발급" "$(cat "$TMP/h2.txt")" "brick_session="
contains "요청한 경로로 되돌림" "$(cat "$TMP/h2.txt")" "location: /mypage"
ME="$(curl -s -b "$U1" "$API/api/auth/me")"
contains "로그인 상태 확인" "$ME" "first@sso.test"
contains "표시 이름 반영" "$ME" "첫 사용자"
check "회원이 1명 생성됨" "$(psql_one "SELECT count(*) FROM users WHERE email='first@sso.test'")" "1"
check "신원이 연결됨" \
  "$(psql_one "SELECT count(*) FROM user_identities WHERE provider='oidc' AND provider_uid='sso-1'")" "1"
check "소셜 전용 계정은 비밀번호 로그인 불가 표시" \
  "$(psql_one "SELECT password_login_enabled FROM users WHERE email='first@sso.test'")" "false"
check "이메일 검증 시각 기록" \
  "$(psql_one "SELECT (email_verified_at IS NOT NULL) FROM users WHERE email='first@sso.test'")" "true"

echo "── 재로그인 (같은 계정)"
U2="$TMP/u2.txt"
curl -s -c "$U2" -b "$U2" -L -o /dev/null "$OA/oidc?next=/"
contains "같은 사람으로 로그인" "$(curl -s -b "$U2" "$API/api/auth/me")" "first@sso.test"
check "회원이 늘지 않음" "$(psql_one "SELECT count(*) FROM users WHERE email='first@sso.test'")" "1"
check "신원도 늘지 않음" "$(psql_one "SELECT count(*) FROM user_identities")" "1"
check "마지막 로그인 시각 갱신" \
  "$(psql_one "SELECT (last_login_at IS NOT NULL) FROM user_identities WHERE provider_uid='sso-1'")" "true"

echo "── 소셜 전용 계정 우회 차단"
check "비밀번호 로그인 거부(401)" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"first@sso.test","password":"anything12345"}')" "401"
# 재설정 요청은 계정 존재를 노출하지 않기 위해 항상 200이지만, 메일이 나가면 안 된다
curl -s -X POST "$API/api/auth/password/forgot" -H 'content-type: application/json' \
  -d '{"email":"first@sso.test"}' >/dev/null
check "재설정 토큰이 발급되지 않음" \
  "$(psql_one "SELECT count(*) FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email='first@sso.test'")" "0"

echo "── 이메일 없는 공급자 (카카오식 선택 동의)"
set_profile '{"sub":"sso-noemail","email":null,"email_verified":false,"name":"이메일없음"}'
U3="$TMP/u3.txt"
curl -s -c "$U3" -b "$U3" -L -o /dev/null "$OA/oidc?next=/"
contains "이메일 없이도 로그인 성공" "$(curl -s -b "$U3" "$API/api/auth/me")" "이메일없음"
contains "내부 주소로 계정 생성" \
  "$(psql_one "SELECT email FROM users WHERE display_name='이메일없음'")" "@social.invalid"
check "검증 안 된 계정은 이메일 미검증" \
  "$(psql_one "SELECT (email_verified_at IS NULL) FROM users WHERE display_name='이메일없음'")" "true"

echo "── 검증된 이메일은 기존 계정에 연결"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"local@sso.test","password":"localpass123","displayName":"로컬 회원"}' >/dev/null
set_profile '{"sub":"sso-linked","email":"local@sso.test","email_verified":true,"name":"로컬 회원"}'
U4="$TMP/u4.txt"
curl -s -c "$U4" -b "$U4" -L -o /dev/null "$OA/oidc?next=/"
contains "기존 계정으로 로그인됨" "$(curl -s -b "$U4" "$API/api/auth/me")" "local@sso.test"
check "새 회원이 만들어지지 않음" "$(psql_one "SELECT count(*) FROM users WHERE email='local@sso.test'")" "1"
check "기존 계정의 비밀번호 로그인은 유지" \
  "$(psql_one "SELECT password_login_enabled FROM users WHERE email='local@sso.test'")" "true"
check "비밀번호로도 여전히 로그인 가능" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"local@sso.test","password":"localpass123"}')" "201"

echo "── 검증되지 않은 이메일은 연결하지 않는다 (계정 탈취 방어)"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
  -d '{"email":"victim@sso.test","password":"victimpass123","displayName":"피해자"}' >/dev/null
set_profile '{"sub":"sso-attacker","email":"victim@sso.test","email_verified":false,"name":"공격자"}'
U5="$TMP/u5.txt"
curl -s -c "$U5" -b "$U5" -L -o /dev/null -D "$TMP/h5.txt" "$OA/oidc?next=/"
contains "로그인 화면으로 오류와 함께 되돌림" "$(cat "$TMP/h5.txt")" "location: /login?error="
ME5="$(curl -s -b "$U5" "$API/api/auth/me")"
absent "피해자 계정으로 로그인되지 않음" "$ME5" "victim@sso.test"
check "신원이 연결되지 않음" \
  "$(psql_one "SELECT count(*) FROM user_identities WHERE provider_uid='sso-attacker'")" "0"

echo "── state 검증"
# 쿠키 없이 콜백에 도착 = 남의 브라우저에 심어진 state (로그인 CSRF)
LOC6="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc?next=/")"
STATE6="$(LOC="$LOC6" python3 -c "
import urllib.parse, os
print(urllib.parse.parse_qs(urllib.parse.urlparse(os.environ['LOC']).query)['state'][0])
")"
CB="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc/callback?code=x&state=$STATE6")"
contains "state 쿠키 없으면 거부" "$CB" "/login?error="
absent "거부 시 세션을 주지 않는다" \
  "$(curl -s -D - -o /dev/null "$OA/oidc/callback?code=x&state=$STATE6")" "brick_session="

# 서명이 깨진 state
FORGED="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc/callback?code=x&state=abc.def")"
contains "위조된 state 거부" "$FORGED" "/login?error="
NOSTATE="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc/callback?code=x")"
contains "state 없으면 거부" "$NOSTATE" "/login?error="

# 공급자가 취소를 알려온 경우
DENY="$(curl -s -o /dev/null -w "%{redirect_url}" "$OA/oidc/callback?error=access_denied&state=$STATE6")"
contains "취소는 안내 메시지로" "$DENY" "%EC%B7%A8%EC%86%8C"

# 코드 재사용 — 스텁이 1회용으로 발급하므로 두 번째는 실패해야 한다
U7="$TMP/u7.txt"
set_profile '{"sub":"sso-1","email":"first@sso.test","email_verified":true,"name":"첫 사용자"}'
LOC7="$(curl -s -c "$U7" -b "$U7" -o /dev/null -w "%{redirect_url}" "$OA/oidc?next=/")"
CBURL7="$(curl -s -o /dev/null -w "%{redirect_url}" "$LOC7")"
curl -s -c "$U7" -b "$U7" -o /dev/null "$CBURL7"
REPLAY="$(curl -s -c "$U7" -b "$U7" -o /dev/null -w "%{redirect_url}" "$CBURL7")"
contains "코드 재사용 거부" "$REPLAY" "/login?error="

echo "── 연결 · 해제 (내 계정)"
check "비로그인 연결 목록 차단" "$(code "$OA/my/identities")" "401"
# 로컬 회원으로 로그인해 소셜을 추가 연결한다
LK="$TMP/link.txt"
curl -s -c "$LK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"local@sso.test","password":"localpass123"}' >/dev/null
contains "연결 목록 조회" "$(curl -s -b "$LK" "$OA/my/identities")" '"provider":"oidc"'
contains "공급자 이름 표시" "$(curl -s -b "$LK" "$OA/my/identities")" '"label":"SSO"'
check "비로그인 연결 시작 차단" "$(code "$OA/oidc?link=1")" "401"

# 다른 사람의 신원을 내 계정에 붙이려는 시도
set_profile '{"sub":"sso-1","email":"first@sso.test","email_verified":true,"name":"첫 사용자"}'
CLASH="$(curl -s -c "$LK" -b "$LK" -L -o /dev/null -w "%{url_effective}" "$OA/oidc?link=1&next=/mypage")"
contains "남의 신원 연결 거부" "$CLASH" "/login?error="
check "연결 수가 늘지 않음" \
  "$(psql_one "SELECT count(*) FROM user_identities WHERE provider_uid='sso-1'")" "1"

# 소셜 전용 계정은 마지막 수단을 해제할 수 없다
S1="$TMP/s1.txt"
set_profile '{"sub":"sso-1","email":"first@sso.test","email_verified":true,"name":"첫 사용자"}'
curl -s -c "$S1" -b "$S1" -L -o /dev/null "$OA/oidc?next=/"
check "마지막 로그인 수단 해제 거부(409)" \
  "$(code -b "$S1" -X DELETE "$OA/my/identities/oidc")" "409"
# 비밀번호가 있는 계정은 해제할 수 있다
contains "비밀번호 있는 계정은 해제 가능" \
  "$(curl -s -b "$LK" -X DELETE "$OA/my/identities/oidc")" '"ok":true'
check "해제되면 연결이 사라짐" \
  "$(psql_one "SELECT count(*) FROM user_identities WHERE provider_uid='sso-linked'")" "0"
check "연결되지 않은 공급자 해제는 400" \
  "$(code -b "$LK" -X DELETE "$OA/my/identities/oidc")" "400"

echo "── 정지된 계정"
node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(\"UPDATE users SET is_active = false WHERE email = 'first@sso.test'\");
  await c.end();
})();
"
U8="$TMP/u8.txt"
BANNED="$(curl -s -c "$U8" -b "$U8" -L -o /dev/null -w "%{url_effective}" "$OA/oidc?next=/")"
contains "정지된 계정은 소셜로도 못 들어온다" "$BANNED" "/login?error="
absent "정지 계정에 세션을 주지 않는다" "$(curl -s -b "$U8" "$API/api/auth/me")" "first@sso.test"

echo "── 공급자 사용 해제"
curl -s -b "$CK" -X PUT "$OA/admin/providers/oidc" -H 'content-type: application/json' \
  -d '{"enabled":false,"clientId":"stub-client"}' >/dev/null
contains "해제하면 공개 목록에서 사라짐" "$(curl -s "$OA/providers")" '"items":[]'
check "해제된 공급자로 시작 불가" "$(code "$OA/oidc")" "503"

echo "── 감사 로그"
for action in auth.oauth_signup auth.oauth_login auth.oauth_failed auth.oauth_config auth.oauth_unlink; do
  contains "감사 기록: $action" "$(curl -s -b "$CK" "$API/api/audit?action=$action")" "$action"
done

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || {
  echo; echo "── 서버 로그 ──"; tail -30 "$TMP/api.log"
  echo; echo "── 스텁 로그 ──"; tail -10 "$TMP/stub.log"
  exit 1
}
