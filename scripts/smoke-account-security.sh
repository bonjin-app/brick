#!/usr/bin/env bash
#
# 계정 보안 E2E 스모크 — 2단계 인증 · 세션 관리 · 감사 로그 필터.
#
# **관리자 계정이 뚫리면 사이트 전체를 잃는다.** 회원 개인정보, 주문 내역,
# 결제 정보 접근 권한이 한 계정에 몰려 있다.
#
# 못박는 것:
#   - 비밀번호만으로 세션이 나가지 않는가 (2FA 가 켜진 계정)
#   - 도전 토큰으로 아무것도 할 수 없는가 (그것이 세션이 되면 2FA 가 무의미하다)
#   - 같은 코드를 두 번 쓸 수 없는가 (가로챈 코드의 재사용)
#   - 시도 횟수를 제한하는가 (6자리는 100만분의 1이다)
#   - 코드를 검증하기 전에 켜지지 않는가 (잘못된 비밀 → 영구 잠금)
#   - 복구 코드가 한 번만 쓰이는가
#   - 비밀번호 없이 해제할 수 없는가 (훔친 세션으로 2FA 무력화)
#   - 강제 설정에서 관리자가 스스로 끌 수 없는가
#   - 강제 설정을 켜도 사이트가 잠기지 않는가 (등록 경로는 열려 있어야 한다)
#   - 남의 세션을 끊을 수 없는가
#   - 감사 로그를 사람과 기간으로 좁힐 수 있는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-account-security.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  # 진입 시점의 종료 코드를 보존한다.
  #
  # kill 한 백그라운드 프로세스를 `wait` 하면 그 종료 코드(143 = SIGTERM)가
  # **스크립트의 종료 코드가 된다** — 항목이 전부 통과했는데도 CI 가 실패로 본다.
  # 놀랍게도 뒤에서 `exit 0` 을 해도 덮이지 않으므로 `|| true` 로 흡수해야 한다.
  #
  # 앞의 "스모크가 자기 실패를 숨겼다"와 짝을 이루는 반대 방향의 버그다.
  # 하네스는 양쪽 다 정확해야 한다.
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
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

# TOTP 코드를 만든다 — 인증 앱이 하는 일을 테스트가 대신한다.
# 구현이 RFC 6238 표준 벡터와 맞는지는 아래 "표준 벡터" 절에서 따로 검증한다.
totp_code() {  # totp_code <base32 비밀> [스텝 오프셋]
  node -e '
    const { createHmac } = require("node:crypto");
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    function dec(input) {
      const clean = String(input).toUpperCase().replace(/[\s=]/g, "");
      let bits = 0, value = 0; const out = [];
      for (const ch of clean) { const i = A.indexOf(ch); if (i < 0) throw new Error(ch);
        value = (value << 5) | i; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
      return Buffer.from(out);
    }
    const secret = process.argv[1];
    const offset = Number(process.argv[2] ?? 0);
    const step = Math.floor(Date.now() / 30000) + offset;
    const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
    const d = createHmac("sha1", dec(secret)).update(c).digest();
    const o = d[d.length - 1] & 0x0f;
    const bin = ((d[o] & 0x7f) << 24) | ((d[o+1] & 0xff) << 16) | ((d[o+2] & 0xff) << 8) | (d[o+3] & 0xff);
    console.log(String(bin % 1000000).padStart(6, "0"));
  ' "$1" "${2:-0}"
}

echo "▶ 계정 보안 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-sec-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_TIMEZONE="Asia/Seoul"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

echo "── RFC 6238 표준 벡터 (구현이 표준과 맞는가)"
# 맞지 않으면 인증 앱이 만든 코드를 거절한다 — 아무도 로그인할 수 없다
VEC="$(node -e '
  const { createHmac } = require("node:crypto");
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function enc(buf) { let bits=0,v=0,o=""; for (const b of buf) { v=(v<<8)|b; bits+=8;
    while (bits>=5) { o+=A[(v>>>(bits-5))&31]; bits-=5; } } if (bits>0) o+=A[(v<<(5-bits))&31]; return o; }
  function dec(s) { const c=String(s).toUpperCase().replace(/[\s=]/g,""); let bits=0,v=0; const o=[];
    for (const ch of c) { const i=A.indexOf(ch); v=(v<<5)|i; bits+=5;
      if (bits>=8) { o.push((v>>>(bits-8))&255); bits-=8; } } return Buffer.from(o); }
  function codeAt(secret, step) { const c=Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
    const d=createHmac("sha1", dec(secret)).update(c).digest(); const off=d[d.length-1]&0x0f;
    const bin=((d[off]&0x7f)<<24)|((d[off+1]&0xff)<<16)|((d[off+2]&0xff)<<8)|(d[off+3]&0xff);
    return String(bin%1000000).padStart(6,"0"); }
  const secret = enc(Buffer.from("12345678901234567890","ascii"));
  const vectors = [[59,"287082"],[1111111109,"081804"],[1111111111,"050471"],
                   [1234567890,"005924"],[2000000000,"279037"],[20000000000,"353130"]];
  const bad = vectors.filter(([t,e]) => codeAt(secret, Math.floor(t/30)) !== e);
  console.log(bad.length === 0 ? "모두 일치" : `불일치 ${bad.length}건`);
')"
check "RFC 6238 테스트 벡터 6개" "$VEC" "모두 일치"

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"보안테스트","adminEmail":"admin@sec.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}' >/dev/null

CONSENT='"agreements":{"terms":true,"privacy":true},'
printf '{"email":"m@sec.test","password":"password123",%s"displayName":"회원"}' "$CONSENT" > "$TMP/reg.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
curl -s -c "$TMP/m.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"m@sec.test","password":"password123"}' >/dev/null
M="$TMP/m.txt"

echo "── 초기 상태"
ST="$(curl -s -b "$CK" "$API/api/me/security")"
contains "2FA 꺼진 상태" "$ST" '"enabled":false'
contains "복구 코드 0개" "$ST" '"recoveryCodesLeft":0'
contains "세션 목록을 준다" "$ST" '"sessions"'
contains "현재 기기를 표시한다" "$ST" '"isCurrent":true'
contains "기기를 사람이 읽게 보여준다" "$ST" '"device"'
check "비로그인은 401" "$(code "$API/api/me/security")" "401"

echo "── 등록에는 비밀번호가 필요하다 (훔친 세션으로 등록하면 계정을 빼앗긴다)"
check "비밀번호 없으면 401" \
  "$(code -b "$CK" -X POST "$API/api/me/security/2fa/begin" -H 'content-type: application/json' -d '{}')" "401"
check "틀린 비밀번호도 401" \
  "$(code -b "$CK" -X POST "$API/api/me/security/2fa/begin" -H 'content-type: application/json' \
      -d '{"password":"wrong"}')" "401"

BEGIN="$(curl -s -b "$CK" -X POST "$API/api/me/security/2fa/begin" -H 'content-type: application/json' \
  -d '{"password":"adminpass123"}')"
SECRET="$(echo "$BEGIN" | jq_get "['secret']")"
[[ -n "$SECRET" ]] && ok "비밀 발급 (${#SECRET}자)" || bad "비밀 발급 ($BEGIN)"
contains "otpauth URI (인증 앱이 읽는다)" "$BEGIN" "otpauth://totp/"
contains "사이트 이름이 들어간다" "$BEGIN" "issuer=%EB%B3%B4%EC%95%88%ED%85%8C%EC%8A%A4%ED%8A%B8"
contains "표준값 SHA1" "$BEGIN" "algorithm=SHA1"
contains "6자리" "$BEGIN" "digits=6"
contains "30초" "$BEGIN" "period=30"
contains "안내 문구" "$BEGIN" "코드를 확인하기 전에는 켜지지 않습니다"
check "비밀 길이 32자 (20바이트 base32)" "${#SECRET}" "32"

echo "── 코드를 검증하기 전에는 켜지지 않는다 (잘못된 비밀 → 영구 잠금)"
check "아직 꺼져 있다" "$(psql_q "SELECT is_enabled FROM user_totp WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "false"
ST="$(curl -s -b "$CK" "$API/api/me/security")"
contains "상태도 꺼짐" "$ST" '"enabled":false'
check "여전히 관리 작업 가능 (강제가 아니므로)" "$(code -b "$CK" "$API/api/audit")" "200"

echo "── 틀린 코드로는 켜지지 않는다"
check "000000 은 400" \
  "$(code -b "$CK" -X POST "$API/api/me/security/2fa/complete" -H 'content-type: application/json' \
      -d '{"code":"000000"}')" "400"
check "자리수가 틀리면 400" \
  "$(code -b "$CK" -X POST "$API/api/me/security/2fa/complete" -H 'content-type: application/json' \
      -d '{"code":"123"}')" "400"
contains "인증 앱 시간을 확인하라고 안내" \
  "$(curl -s -b "$CK" -X POST "$API/api/me/security/2fa/complete" -H 'content-type: application/json' \
      -d '{"code":"111111"}')" "시간이 정확한지"

echo "── 맞는 코드로 켠다"
CODE="$(totp_code "$SECRET")"
COMPLETE="$(curl -s -b "$CK" -X POST "$API/api/me/security/2fa/complete" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\"}")"
contains "복구 코드를 준다" "$COMPLETE" '"recoveryCodes"'
contains "한 번만 보여준다고 경고" "$COMPLETE" "지금 한 번만 표시됩니다"
RC_COUNT="$(echo "$COMPLETE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['recoveryCodes']))")"
check "복구 코드 10개" "$RC_COUNT" "10"
RC1="$(echo "$COMPLETE" | python3 -c "import sys,json;print(json.load(sys.stdin)['recoveryCodes'][0])")"
RC2="$(echo "$COMPLETE" | python3 -c "import sys,json;print(json.load(sys.stdin)['recoveryCodes'][1])")"
contains "복구 코드가 읽기 쉽게 나뉜다" "$RC1" "-"
check "켜졌다" "$(psql_q "SELECT is_enabled FROM user_totp WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "true"
# 복구 코드는 평문으로 저장하지 않는다
RC_STORED="$(psql_q "SELECT count(*) FROM user_recovery_codes WHERE code_hash = '$(python3 -c "print('$RC1'.replace('-',''))")'")"
check "복구 코드를 평문으로 저장하지 않는다" "$RC_STORED" "0"
check "해시로 10개 저장" "$(psql_q "SELECT count(*) FROM user_recovery_codes WHERE used_at IS NULL")" "10"

echo "── 이미 켜져 있으면 다시 등록할 수 없다 (기존 인증 앱이 조용히 무효가 된다)"
check "재등록은 400" \
  "$(code -b "$CK" -X POST "$API/api/me/security/2fa/begin" -H 'content-type: application/json' \
      -d '{"password":"adminpass123"}')" "400"

echo "══ 로그인: 비밀번호만으로 세션이 나가지 않는다 ══"
LOGIN="$(curl -s -c "$TMP/try.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
contains "2단계 인증이 필요하다고 알린다" "$LOGIN" '"twoFactorRequired":true'
contains "도전 토큰을 준다" "$LOGIN" '"challengeToken"'
absent "사용자 정보를 주지 않는다" "$LOGIN" '"email"'
CHAL="$(echo "$LOGIN" | jq_get "['challengeToken']")"
# 세션 쿠키가 심어지지 않았어야 한다 — 이게 새면 2FA 가 완전히 무의미하다
absent "세션 쿠키가 심어지지 않았다" "$(cat "$TMP/try.txt")" "brick_session"
check "그 쿠키로는 아무것도 못 한다" "$(code -b "$TMP/try.txt" "$API/api/me/security")" "401"

echo "── 도전 토큰은 세션이 아니다"
printf '{"challengeToken":"%s"}' "$CHAL" > "$TMP/ch.json"
check "도전 토큰을 세션 쿠키로 써도 401" \
  "$(code -H "Cookie: brick_session=$CHAL" "$API/api/me/security")" "401"
check "Bearer 로 써도 401" \
  "$(code -H "Authorization: Bearer $CHAL" "$API/api/me/security")" "401"

echo "── 틀린 코드는 거절하고 시도를 센다"
for i in 1 2 3 4; do
  printf '{"challengeToken":"%s","code":"000000"}' "$CHAL" > "$TMP/bad.json"
  RC="$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/bad.json")"
  [[ "$RC" == "401" ]] || bad "틀린 코드 $i 회 거절 (실제 $RC)"
done
ok "틀린 코드 4회 모두 401"
check "시도 횟수가 기록된다" "$(psql_q "SELECT attempts FROM totp_challenges WHERE token_hash = encode(digest('$CHAL','sha256'),'hex')" 2>/dev/null || psql_q "SELECT max(attempts) FROM totp_challenges")" "4"
# 5회를 넘기면 도전이 폐기된다
printf '{"challengeToken":"%s","code":"000000"}' "$CHAL" > "$TMP/bad.json"
curl -s -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/bad.json" >/dev/null
LAST="$(curl -s -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/bad.json")"
contains "한계를 넘으면 다시 로그인하라고 한다" "$LAST" "다시 로그인"
check "도전이 폐기되었다" "$(psql_q "SELECT count(*) FROM totp_challenges")" "0"
# 맞는 코드라도 폐기된 도전으로는 안 된다
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL" "$(totp_code "$SECRET")" > "$TMP/ok.json"
check "폐기된 도전은 맞는 코드도 401" \
  "$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/ok.json")" "401"

echo "── 맞는 코드로 로그인한다"
LOGIN="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL="$(echo "$LOGIN" | jq_get "['challengeToken']")"
# 등록에 쓴 코드는 재사용으로 거절된다(정상 동작) — 다음 스텝 코드를 쓴다.
# 허용 창이 ±1 이므로 +1 은 받아들여진다.
CODE="$(totp_code "$SECRET" 1)"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL" "$CODE" > "$TMP/ok.json"
VERIFY="$(curl -s -c "$TMP/tfa.txt" -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' \
  --data-binary "@$TMP/ok.json")"
contains "사용자 정보를 준다" "$VERIFY" '"email":"admin@sec.test"'
absent "복구 코드를 쓰지 않았다" "$VERIFY" '"usedRecoveryCode":true'
contains "세션 쿠키가 심어졌다" "$(cat "$TMP/tfa.txt")" "brick_session"
check "이제 접근된다" "$(code -b "$TMP/tfa.txt" "$API/api/me/security")" "200"
TFA="$TMP/tfa.txt"

echo "── 같은 코드를 두 번 쓸 수 없다 (가로챈 코드의 재사용)"
LOGIN2="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL2="$(echo "$LOGIN2" | jq_get "['challengeToken']")"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL2" "$CODE" > "$TMP/reuse.json"
REUSE="$(curl -s -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/reuse.json")"
contains "이미 쓴 코드는 거절한다" "$REUSE" "이미 사용한 코드"

echo "── 시간 오차는 흡수하지만 넓게 열지 않는다"
LOGIN3="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL3="$(echo "$LOGIN3" | jq_get "['challengeToken']")"
# +2 스텝(1분 뒤)은 창(±1) 밖이므로 거절해야 한다.
# 앞서 +1 로 로그인했으므로 last_step 이 올라가 있고, 지금 스텝과 -1 스텝은
# 모두 재사용으로 막힌다 — 이것도 의도된 동작이다.
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL3" "$(totp_code "$SECRET" 2)" > "$TMP/next.json"
check "+2 스텝은 거절한다 (허용 창은 ±1 이다)" \
  "$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/next.json")" "401"
# +5 스텝(2분 30초 뒤)은 거절한다
LOGIN4="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL4="$(echo "$LOGIN4" | jq_get "['challengeToken']")"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL4" "$(totp_code "$SECRET" 5)" > "$TMP/far.json"
check "+5 스텝은 거절한다 (창을 넓히면 가로챈 코드가 오래 산다)" \
  "$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/far.json")" "401"

echo "── 복구 코드로 로그인 (휴대폰을 잃었을 때)"
LOGIN5="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL5="$(echo "$LOGIN5" | jq_get "['challengeToken']")"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL5" "$RC1" > "$TMP/rc.json"
RCLOGIN="$(curl -s -c "$TMP/rc.txt" -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' \
  --data-binary "@$TMP/rc.json")"
contains "복구 코드로 로그인됨" "$RCLOGIN" '"usedRecoveryCode":true'
contains "남은 개수를 알려준다 (다 쓰면 잠긴다)" "$RCLOGIN" '"recoveryCodesLeft":9'
check "9개 남음" "$(psql_q "SELECT count(*) FROM user_recovery_codes WHERE used_at IS NULL")" "9"

echo "── 복구 코드는 한 번만 쓰인다"
LOGIN6="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL6="$(echo "$LOGIN6" | jq_get "['challengeToken']")"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL6" "$RC1" > "$TMP/rc2.json"
check "쓴 코드를 다시 쓰면 401" \
  "$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/rc2.json")" "401"
# 하이픈 없이 소문자로 입력해도 받아준다 (손으로 옮겨 적는다)
LOGIN7="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
CHAL7="$(echo "$LOGIN7" | jq_get "['challengeToken']")"
RC2_MESSY="$(python3 -c "print('$RC2'.replace('-','').lower())")"
printf '{"challengeToken":"%s","code":"%s"}' "$CHAL7" "$RC2_MESSY" > "$TMP/rc3.json"
check "하이픈·대소문자를 무시한다" \
  "$(code -X POST "$API/api/auth/login/2fa" -H 'content-type: application/json' --data-binary "@$TMP/rc3.json")" "201"

echo "── 복구 코드 재발급 (이전 코드는 무효)"
REGEN="$(curl -s -b "$TFA" -X POST "$API/api/me/security/2fa/recovery-codes" -H 'content-type: application/json' \
  -d '{"password":"adminpass123"}')"
contains "새 코드 10개" "$REGEN" '"recoveryCodes"'
contains "이전 코드 무효를 알린다" "$REGEN" "이전 복구 코드는 모두 무효"
check "다시 10개" "$(psql_q "SELECT count(*) FROM user_recovery_codes WHERE used_at IS NULL")" "10"
check "비밀번호 없이는 재발급 불가" \
  "$(code -b "$TFA" -X POST "$API/api/me/security/2fa/recovery-codes" -H 'content-type: application/json' -d '{}')" "401"

echo "══ 세션 관리 ══"
SESS="$(curl -s -b "$TFA" "$API/api/me/security/sessions")"
N_SESS="$(echo "$SESS" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")"
[[ "$N_SESS" -ge 2 ]] && ok "세션이 여러 개 보인다 ($N_SESS개)" || bad "세션 목록 ($N_SESS개)"
contains "기기 이름" "$SESS" '"device"'
CURRENT_N="$(echo "$SESS" | python3 -c "
import sys,json
print(sum(1 for s in json.load(sys.stdin)['items'] if s['isCurrent']))")"
check "현재 기기는 정확히 하나" "$CURRENT_N" "1"
# 접속 정보가 기록되어야 목록이 의미가 있다
check "User-Agent 가 기록된다" \
  "$(psql_q "SELECT count(*) > 0 FROM sessions WHERE user_agent IS NOT NULL")" "true"
check "IP 는 해시로만 저장한다" \
  "$(psql_q "SELECT count(*) FROM sessions WHERE ip_hash = '127.0.0.1'")" "0"
check "IP 해시가 기록된다" \
  "$(psql_q "SELECT count(*) > 0 FROM sessions WHERE ip_hash IS NOT NULL")" "true"

echo "── 남의 세션은 끊을 수 없다"
M_SESSION="$(psql_q "SELECT id FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='m@sec.test') LIMIT 1")"
[[ -n "$M_SESSION" ]] && ok "회원 세션 확인" || bad "회원 세션 확인"
check "남의 세션 id 로 삭제하면 400" \
  "$(code -b "$TFA" -X DELETE "$API/api/me/security/sessions/$M_SESSION")" "400"
check "회원 세션은 살아 있다" "$(code -b "$M" "$API/api/me/security")" "200"

echo "── 다른 기기 끊기"
OTHER="$(echo "$SESS" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
print(next(s['id'] for s in items if not s['isCurrent']))")"
contains "하나 끊기" "$(curl -s -b "$TFA" -X DELETE "$API/api/me/security/sessions/$OTHER")" '"ok":true'
check "지금 세션은 그대로" "$(code -b "$TFA" "$API/api/me/security")" "200"

echo "── 지금 기기만 남기고 전부 끊기 (계정이 뚫렸다고 의심할 때)"
REVOKE="$(curl -s -b "$TFA" -X POST "$API/api/me/security/sessions/revoke-others")"
contains "끊은 개수를 알려준다" "$REVOKE" '"revoked"'
check "지금 세션은 살아 있다 (자기까지 끊으면 공격자가 먼저 들어온다)" \
  "$(code -b "$TFA" "$API/api/me/security")" "200"
LEFT="$(psql_q "SELECT count(*) FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")"
check "관리자 세션 하나만 남음" "$LEFT" "1"
check "다른 회원 세션은 영향 없음" "$(code -b "$M" "$API/api/me/security")" "200"

echo "══ 2FA 강제 ══"
echo "── 비밀번호 없이 해제할 수 없다 (훔친 세션으로 2FA 무력화)"
check "비밀번호 없으면 401" \
  "$(code -b "$TFA" -X POST "$API/api/me/security/2fa/disable" -H 'content-type: application/json' -d '{}')" "401"
check "여전히 켜져 있다" "$(psql_q "SELECT is_enabled FROM user_totp WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "true"

echo "── 강제 설정을 켜면 관리자가 스스로 끌 수 없다"
contains "설정 저장" "$(curl -s -b "$TFA" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"security.require_2fa_for_staff":true}')" '"ok":true'
DISABLE="$(curl -s -b "$TFA" -X POST "$API/api/me/security/2fa/disable" -H 'content-type: application/json' \
  -d '{"password":"adminpass123"}')"
contains "해제를 거부한다 (끌 수 있으면 강제가 아니다)" "$DISABLE" "해제할 수 없습니다"
check "여전히 켜져 있다" "$(psql_q "SELECT is_enabled FROM user_totp WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "true"
contains "강제 상태를 알려준다" "$(curl -s -b "$TFA" "$API/api/me/security")" '"requiredForStaff":true'

echo "── 강제 설정에서 2FA 없는 관리자는 관리 작업을 못 하지만 잠기지도 않는다"
# 2FA 를 켜지 않은 관리자를 만든다
psql_q "UPDATE users SET role='admin' WHERE email='m@sec.test'" >/dev/null
check "관리 작업은 막힌다" "$(code -b "$M" "$API/api/audit")" "403"
contains "무엇을 해야 하는지 알려준다" "$(curl -s -b "$M" "$API/api/audit")" "계정 보안 설정에서 먼저 등록"
# 등록 경로는 열려 있어야 한다 — 아니면 사이트가 영구히 잠긴다
check "등록 경로는 열려 있다" "$(code -b "$M" "$API/api/me/security")" "200"
BEGIN_M="$(curl -s -b "$M" -X POST "$API/api/me/security/2fa/begin" -H 'content-type: application/json' \
  -d '{"password":"password123"}')"
SECRET_M="$(echo "$BEGIN_M" | jq_get "['secret']")"
[[ -n "$SECRET_M" ]] && ok "등록을 시작할 수 있다 (사이트가 잠기지 않는다)" || bad "등록 시작 ($BEGIN_M)"
curl -s -b "$M" -X POST "$API/api/me/security/2fa/complete" -H 'content-type: application/json' \
  -d "{\"code\":\"$(totp_code "$SECRET_M")\"}" >/dev/null
check "등록을 마치면 관리 작업이 열린다" "$(code -b "$M" "$API/api/audit")" "200"

# 되돌린다
curl -s -b "$TFA" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"security.require_2fa_for_staff":false}' >/dev/null

echo "── 해제"
contains "비밀번호를 주면 해제된다" \
  "$(curl -s -b "$TFA" -X POST "$API/api/me/security/2fa/disable" -H 'content-type: application/json' \
      -d '{"password":"adminpass123"}')" '"ok":true'
check "비밀이 지워졌다" "$(psql_q "SELECT count(*) FROM user_totp WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "0"
check "복구 코드도 지워졌다" \
  "$(psql_q "SELECT count(*) FROM user_recovery_codes WHERE user_id=(SELECT id FROM users WHERE email='admin@sec.test')")" "0"
LOGIN8="$(curl -s -c "$TMP/plain.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@sec.test","password":"adminpass123"}')"
absent "이제 비밀번호만으로 로그인된다" "$LOGIN8" '"twoFactorRequired"'
contains "사용자 정보를 준다" "$LOGIN8" '"email":"admin@sec.test"'

echo "══ 감사 로그 필터 ══"
AD="$(curl -s -b "$TMP/plain.txt" "$API/api/audit")"
contains "시간대를 알려준다" "$AD" '"timezone":"Asia/Seoul"'
contains "2FA 활성화가 기록됨" "$AD" "auth.totp_enabled"
ACTIONS="$(curl -s -b "$TMP/plain.txt" "$API/api/audit/actions")"
contains "동작 목록 (화면 필터를 채운다)" "$ACTIONS" '"action"'
contains "건수도 준다" "$ACTIONS" '"count"'

echo "── 사람으로 좁힌다 (감사 로그의 본래 용도)"
BY_ACTOR="$(curl -s -b "$TMP/plain.txt" -G "$API/api/audit" --data-urlencode "actor=admin@sec.test")"
N_ADMIN="$(echo "$BY_ACTOR" | jq_get "['total']")"
[[ "$N_ADMIN" -ge 1 ]] && ok "관리자 기록만 ($N_ADMIN건)" || bad "행위자 필터 ($N_ADMIN)"
absent "다른 사람 기록은 안 나온다" \
  "$(echo "$BY_ACTOR" | python3 -c "
import sys,json
print(' '.join(str(i.get('actorEmail')) for i in json.load(sys.stdin)['items']))")" "m@sec.test"
# 부분 일치로도 찾을 수 있어야 한다 (정확한 주소를 모를 수 있다)
PARTIAL="$(curl -s -b "$TMP/plain.txt" -G "$API/api/audit" --data-urlencode "actor=sec.test")"
[[ "$(echo "$PARTIAL" | jq_get "['total']")" -ge "$N_ADMIN" ]] && ok "부분 일치로 찾는다" || bad "부분 일치"
# 와일드카드를 주입할 수 없어야 한다
INJECT="$(curl -s -b "$TMP/plain.txt" -G "$API/api/audit" --data-urlencode "actor=%")"
check "% 를 와일드카드로 쓸 수 없다" "$(echo "$INJECT" | jq_get "['total']")" "0"

echo "── 기간으로 좁힌다"
TODAY="$(psql_q "SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')")"
TOD="$(curl -s -b "$TMP/plain.txt" "$API/api/audit?from=$TODAY&to=$TODAY")"
[[ "$(echo "$TOD" | jq_get "['total']")" -ge 1 ]] && ok "오늘 기록이 나온다 (to 가 그날 끝까지)" || bad "오늘 기록"
PAST="$(curl -s -b "$TMP/plain.txt" "$API/api/audit?from=2020-01-01&to=2020-12-31")"
check "과거 기간은 0건" "$(echo "$PAST" | jq_get "['total']")" "0"
BADDATE="$(curl -s -b "$TMP/plain.txt" "$API/api/audit?from=nonsense")"
[[ "$(echo "$BADDATE" | jq_get "['total']")" -ge 1 ]] && ok "잘못된 날짜는 무시한다 (500 이 아니다)" || bad "잘못된 날짜 처리"
check "비관리자는 감사 로그를 볼 수 없다" "$(code "$API/api/audit")" "401"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
