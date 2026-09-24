#!/usr/bin/env bash
#
# 본인인증 — 성인 상품과 한 사람 한 계정.
#
# 스텁 포트원(scripts/portone-stub.mjs)을 세우고 **실제 HTTP** 로 본다:
#   - 인증 ID 는 서버가 만들고 회원에게 묶는다(남의 인증 ID 로 내 계정을 인증할 수 없다)
#   - 결과는 공급자에게 직접 묻는다 — 상태가 VERIFIED 이고 상점이 맞고 CI·생년월일이 있을 때만
#   - 저장하는 것은 출생 연도와 CI 의 HMAC 뿐이다(이름·CI 원문·전화번호는 남지 않는다)
#   - 성인 판정은 청소년보호법의 연 나이(19세가 되는 해의 1월 1일부터 성인)
#   - 한 계정의 명의는 바뀌지 않고, 설정을 켜면 한 사람이 두 계정에서 인증할 수 없다
#   - 성인 상품은 확인 전에 보이지도 팔리지도 않는다
#   - 탈퇴하면 인증 기록이 지워진다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-identity.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
PO="$API/api/plugins/brick-pay-portone"
PO_PORT=42650
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
POLOG="$TMP/portone.jsonl"
SECRET="portone_ID_SECRET_DO_NOT_LEAK"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${PO_PID:-}" ]]; then kill "$PO_PID" 2>/dev/null || true; wait "$PO_PID" 2>/dev/null || true; fi
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
po_count() { python3 -c "
import json
print(sum(1 for l in open('$POLOG', encoding='utf-8') if json.loads(l).get('kind') == '$1'))"; }
render() {  # render <쿠키|-> <경로> [쿼리] → html
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  curl -s ${jar[@]+"${jar[@]}"} "$API/api/render/page?path=$2${3:+&$3}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'
}
signup() {  # signup <이메일> → 쿠키 파일
  curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\",\"agreements\":{\"terms\":true,\"privacy\":true},\"displayName\":\"회원\"}"
  curl -s -o /dev/null -c "$TMP/$1.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}"
  echo "$TMP/$1.txt"
}
start() {  # start <쿠키> → requestId
  curl -s -b "$1" -X POST "$API/api/me/identity/start" -H 'content-type: application/json' \
    -d '{"provider":"portone"}' | jq_get "['requestId']"
}
# 손님이 인증창에서 인증을 마쳤다 — verified <id> <ci> <생년월일> [상태] [storeId]
verified() {
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/identity" -H 'content-type: application/json' \
    -d "{\"id\":\"$1\",\"status\":\"${4:-VERIFIED}\",\"storeId\":\"${5:-store-brick-test}\",\"customer\":{\"ci\":\"$2\",\"di\":\"DI-$2\",\"name\":\"김인증\",\"gender\":\"FEMALE\",\"birthDate\":\"$3\",\"phoneNumber\":\"01099998888\",\"isForeigner\":false}}"
}
complete() {  # complete <쿠키> <requestId> → "상태코드 본문"
  curl -s -b "$1" -w ' %{http_code}' -X POST "$API/api/me/identity/complete" -H 'content-type: application/json' \
    -d "{\"requestId\":\"$2\"}"
}
YEAR="$(python3 -c 'import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(hours=9)).year)')"

echo "▶ 본인인증 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

PO_INFO="$(start_stub scripts/portone-stub.mjs "$PO_PORT" "$TMP/po.log" --out "$POLOG" --secret "$SECRET")" \
  || { bad "포트원 스텁 시작 실패: $(tail -5 "$TMP/po.log" 2>/dev/null)"; exit 1; }
PO_PORT="${PO_INFO% *}"; PO_PID="${PO_INFO#* }"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-identity-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_PORTONE_API_BASE="http://127.0.0.1:${PO_PORT}"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"본인인증","adminEmail":"admin@id.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@id.test","password":"adminpass123"}' >/dev/null
for pl in brick-shop brick-pay-portone; do
  curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/$pl/activate"
done
A="$(signup a@id.test)"      # 성인
M="$(signup m@id.test)"      # 미성년
C="$(signup c@id.test)"      # A 와 같은 사람의 두 번째 계정
U="$(signup u@id.test)"      # 인증하지 않은 회원

echo "── 설정 전에는 인증 수단이 없다"
check "인증 수단 목록이 비어 있다" "$(curl -s "$API/api/identity/providers")" '{"items":[]}'
contains "인증 화면이 수단이 없다고 말한다" "$(render "$A" identity)" "본인인증 수단이 설정되지 않았습니다"

echo "── 설정 (결제와 따로 켠다)"
check "본인인증 채널 키 형식이 틀리면 거절" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' -d '{"identityChannelKey":"danal"}')" "400"
check "채널 키 없이 켤 수 없다" \
  "$(code -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' \
      -d "{\"storeId\":\"store-brick-test\",\"apiSecret\":\"$SECRET\",\"identityEnabled\":true}")" "400"
PUT="$(curl -s -b "$CK" -X PUT "$PO/admin/config" -H 'content-type: application/json' \
  -d "{\"storeId\":\"store-brick-test\",\"apiSecret\":\"$SECRET\",\"identityEnabled\":true,\"identityChannelKey\":\"channel-key-danal-test\"}")"
contains "결제를 켜지 않아도 본인인증만 켤 수 있다" "$PUT" '"identityEnabled":true'
check "인증 수단 목록에 뜬다" "$(curl -s "$API/api/identity/providers")" '{"items":[{"name":"portone","displayName":"휴대폰 본인인증"}]}'
PUB="$(curl -s "$PO/config")"
contains "공개 설정에 본인인증 채널 키가 있다 (인증창이 쓴다)" "$PUB" "channel-key-danal-test"
absent "공개 설정에 시크릿은 없다" "$PUB" "SECRET_DO_NOT_LEAK"

echo "── 인증 화면 (테마 안 — 공급자 SDK 에 CSP 가 필요하다)"
contains "비회원에게는 로그인 길을 준다 (돌아올 곳을 붙여서)" "$(render - identity 'next=%2Fshop%2Fx')" "/login?next="
ID_HTML="$(render "$A" identity)"
contains "포트원 SDK 를 불러온다" "$ID_HTML" "cdn.portone.io/v2/browser-sdk.js"
contains "포트원 본인인증을 부른다" "$ID_HTML" "requestIdentityVerification"
contains "인증 버튼이 있다" "$ID_HTML" 'data-provider="portone"'
CSP="$(curl -s -D - -o /dev/null "$API/api/render/page?path=identity" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
contains "CSP 가 포트원 SDK 출처를 허용한다" "$CSP" "https://cdn.portone.io"
READ_RETURN="$(node -e '
  const html = process.argv[1];
  const i = html.indexOf("window.brickIdentity[\x27portone\x27].readReturn");
  const j = html.indexOf("};", i) + 2;
  const vm = require("node:vm");
  const window = { brickIdentity: { portone: {} } };
  vm.runInNewContext(html.slice(i, j), { window, URLSearchParams });
  const r = window.brickIdentity.portone.readReturn;
  console.log(JSON.stringify([
    r(new URLSearchParams("provider=portone&identityVerificationId=bid123")),
    r(new URLSearchParams("provider=portone&identityVerificationId=bid123&code=IDENTITY_VERIFICATION_FAILED&message=x")),
  ]));
' "$ID_HTML")"
check "돌아온 주소 읽기 — 성공은 인증 ID, 실패·취소는 null" "$READ_RETURN" '["bid123",null]'
# 돌아갈 곳은 사이트 안 경로만 — //evil.com 은 브라우저가 다른 사이트로 읽는다
absent "돌아갈 곳이 다른 사이트면 버린다" "$(render "$A" identity 'next=%2F%2Fevil.example')" "evil.example"

echo "── 시작 — 인증 ID 는 서버가 만들고 회원에게 묶는다"
check "로그인 없이는 시작할 수 없다" "$(code -X POST "$API/api/me/identity/start" -H 'content-type: application/json' -d '{"provider":"portone"}')" "401"
check "모르는 수단은 거절" "$(code -b "$A" -X POST "$API/api/me/identity/start" -H 'content-type: application/json' -d '{"provider":"nice"}')" "400"
R1="$(start "$A")"
[[ "$R1" =~ ^bid[0-9a-f]{32}$ ]] && ok "영문·숫자 40자 이내의 인증 ID (KCP 규칙)" || bad "인증 ID 형식 ($R1)"
check "이 회원에게 묶인 대기 요청" "$(psql_q "SELECT u.email, v.status FROM identity_verifications v JOIN users u ON u.id = v.user_id WHERE request_id='$R1'")" "a@id.test|pending"

echo "── 확인 — 공급자에게 직접 묻는다"
check "없는 인증 ID 는 찾을 수 없다" "$(complete "$A" bidnotexisting | tail -c 3)" "404"
verified "$R1" "CI-ALICE" "1990-05-05"
check "남의 인증 ID 로는 내 계정을 인증할 수 없다" "$(complete "$M" "$R1" | tail -c 3)" "404"
check "남이 시도했다고 요청이 망가지지 않는다" "$(psql_q "SELECT status FROM identity_verifications WHERE request_id='$R1'")" "pending"
check "그때까지 포트원에 묻지 않았다" "$(po_count identity-get)" "0"

R2="$(start "$A")"
contains "인증창을 닫고 돌아오면(포트원에 결과 없음) 완료가 아니다" "$(complete "$A" "$R2")" "본인인증이 완료되지 않았습니다"
R3="$(start "$A")"; verified "$R3" "CI-ALICE" "1990-05-05" FAILED
contains "실패한 인증은 거절하고 이유를 말한다" "$(complete "$A" "$R3")" "본인인증에 실패했습니다"
R4="$(start "$A")"; verified "$R4" "CI-ALICE" "1990-05-05" VERIFIED store-someone-else
check "다른 상점의 인증은 받지 않는다" "$(complete "$A" "$R4" | tail -c 3)" "402"
R5="$(start "$A")"
curl -s -o /dev/null -X POST "http://127.0.0.1:$PO_PORT/__control/identity" -H 'content-type: application/json' \
  -d "{\"id\":\"$R5\",\"status\":\"VERIFIED\",\"storeId\":\"store-brick-test\",\"customer\":{\"name\":\"김인증\",\"birthDate\":\"1990-05-05\"}}"
check "CI·DI 가 없으면 한 사람을 가릴 수 없어 받지 않는다" "$(complete "$A" "$R5" | tail -c 3)" "502"
check "여기까지 인증된 것으로 기록되지 않았다" "$(psql_q "SELECT count(*) FROM user_certifications")" "0"

R6="$(start "$A")"; verified "$R6" "CI-ALICE" "1990-05-05"
OK6="$(complete "$A" "$R6")"
contains "인증 완료 — 성인" "$OK6" '"verified":true,"adult":true'
check "포트원에 시크릿으로 물었다" "$(python3 -c "
import json
got = [json.loads(l) for l in open('$POLOG', encoding='utf-8') if json.loads(l).get('kind') == 'identity-get']
print(len(got) > 0 and all(m.get('authOk') for m in got))")" "True"
check "새로고침해 다시 보내도 같은 답 (한 번 쓴 요청)" "$(complete "$A" "$R6" | tail -c 3)" "200"
check "출생 연도만 남는다" "$(psql_q "SELECT birth_year, length(person_hash) FROM user_certifications c JOIN users u ON u.id = c.user_id WHERE u.email='a@id.test'")" "1990|64"
DUMP="$(psql_q "SELECT row_to_json(c)::text FROM user_certifications c")$(psql_q "SELECT row_to_json(v)::text FROM identity_verifications v")"
absent "CI 원문은 어디에도 없다" "$DUMP" "CI-ALICE"
absent "이름은 저장하지 않는다" "$DUMP" "김인증"
absent "전화번호는 저장하지 않는다" "$DUMP" "01099998888"
contains "내 인증 상태" "$(curl -s -b "$A" "$API/api/me/identity")" '"verified":true,"adult":true'
AFTER="$(render "$A" identity)"
contains "인증을 마친 화면" "$AFTER" "본인인증을 마쳤습니다"
absent "이미 인증했으면 인증창을 다시 열지 않는다 (건당 요금)" "$AFTER" 'data-provider="portone"'

R7="$(start "$A")"; verified "$R7" "CI-ALICE" "1990-05-05"
psql_q "UPDATE identity_verifications SET created_at = now() - interval '31 minutes' WHERE request_id='$R7'" >/dev/null
check "30분이 지난 요청은 받지 않는다" "$(complete "$A" "$R7" | tail -c 3)" "410"

echo "── 명의는 바뀌지 않는다"
R8="$(start "$A")"; verified "$R8" "CI-SOMEONE-ELSE" "1960-01-01"
contains "다른 사람으로 다시 인증하면 거절" "$(complete "$A" "$R8")" "이미 다른 명의로"
check "원래 인증 그대로 (출생 연도)" "$(psql_q "SELECT birth_year FROM user_certifications c JOIN users u ON u.id = c.user_id WHERE u.email='a@id.test'")" "1990"

echo "── 성인 판정 — 청소년보호법의 연 나이"
RM="$(start "$M")"; verified "$RM" "CI-MINOR" "$((YEAR - 18))-01-01"
contains "올해 18세가 되는 사람은 미성년" "$(complete "$M" "$RM")" '"verified":true,"adult":false'
Y="$(signup y@id.test)"
RY="$(start "$Y")"; verified "$RY" "CI-BOUNDARY" "$((YEAR - 19))-12-31"
# 만 나이로는 아직 18세지만, 19세가 되는 해의 1월 1일부터 성인이다(제2조)
contains "올해 19세가 되는 사람은 생일 전이라도 성인" "$(complete "$Y" "$RY")" '"verified":true,"adult":true'

echo "── 한 사람 한 계정"
check "설정을 켠다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.one_person_one_account":true}')" "200"
RC="$(start "$C")"; verified "$RC" "CI-ALICE" "1990-05-05"
contains "같은 사람의 두 번째 계정은 거절" "$(complete "$C" "$RC")" "한 사람이 한 계정만"
check "두 번째 계정은 인증되지 않았다" "$(curl -s -b "$C" "$API/api/me/identity" | jq_get "['verified']")" "False"
# 동시에 여러 계정에서 끝내도 하나만 — 모두 "다른 계정 없음" 을 보고 모두 저장하면 안 된다.
RACE_IDS=()
for i in $(seq 1 8); do
  J="$(signup "twin$i@id.test")"; R="$(start "$J")"; verified "$R" "CI-TWIN" "1985-03-03"
  RACE_IDS+=("$J ${R:-없음}")
done
RACE_PIDS=()
for i in $(seq 0 7); do
  set -- ${RACE_IDS[$i]}
  complete "$1" "$2" > "$TMP/race-$i" &
  RACE_PIDS+=($!)
done
for pid in "${RACE_PIDS[@]}"; do wait "$pid" || true; done
WON=0; LOST=0
for i in $(seq 0 7); do
  case "$(tail -c 3 "$TMP/race-$i")" in 200) WON=$((WON+1));; 409) LOST=$((LOST+1));; esac
done
check "여덟 계정이 동시에 끝내도 한 계정만 인증된다" "$WON/$LOST" "1/7"
# HTTP 로는 요청이 앞단에서 줄지어 들어와 몇 ms 짜리 틈이 좀처럼 겹치지 않는다(사람 단위 잠금을
# 빼도 세 번에 한 번만 잡혔다). 서비스를 직접 같은 순간에 스무 번 부른다 — 잠금이 없으면 6~7.
check "스무 계정이 같은 순간에 끝내도 한 계정만 (서비스 직접)" "$(node "$ROOT/scripts/identity-race-probe.mjs")" "concurrent=1"
check "끄면 두 번째 계정도 인증할 수 있다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.one_person_one_account":false}')" "200"
RC2="$(start "$C")"; verified "$RC2" "CI-ALICE" "1990-05-05"
contains "설정이 꺼지면 같은 사람도 인증된다" "$(complete "$C" "$RC2")" '"verified":true'

echo "── 비용 — 인증창을 무한히 열 수 없다"
G="$(signup g@id.test)"
N=0
for i in $(seq 1 11); do [[ "$(code -b "$G" -X POST "$API/api/me/identity/start" -H 'content-type: application/json' -d '{"provider":"portone"}')" == "200" ]] && N=$((N+1)); done
check "한 시간에 10번까지 (11번째는 막힌다)" "$N" "10"

echo "── 성인 상품"
ADULT="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"whisky","name":"싱글몰트 위스키","price":90000,"stock":10,"status":"selling","adult_only":true,"image_url":"https://img.example/whisky.jpg","description":"스모키한 피트향 설명문"}' | jq_get "['id']")"
curl -s -o /dev/null -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"mug","name":"머그컵","price":9000,"stock":10,"status":"selling","image_url":"https://img.example/mug.jpg"}'
check "관리 화면에 성인 상품 표시가 저장된다" "$(curl -s -b "$CK" "$SHOP/admin/products/$ADULT" | jq_get "['adult_only']")" "True"
curl -s -o /dev/null -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"shop","title":"쇼핑몰","status":"published","blocks":[{"block":"brick-shop/storefront","props":{}}]}'
LIST="$(render "$A" shop)"
contains "목록에 19 표시" "$LIST" "brick-adult-mark"
absent "목록에 성인 상품 사진이 없다 (확인한 성인에게도 — 목록은 캐시된다)" "$LIST" "whisky.jpg"
contains "일반 상품 사진은 그대로" "$LIST" "mug.jpg"
GUEST="$(render - shop/whisky)"
contains "비회원 — 성인 인증 안내" "$GUEST" "성인 인증이 필요한 상품입니다"
absent "비회원 — 설명이 보이지 않는다" "$GUEST" "스모키한 피트향"
absent "비회원 — 사진이 보이지 않는다" "$GUEST" "whisky.jpg"
contains "비회원 — 로그인 뒤 본인인증으로 돌아오는 길" "$GUEST" "/login?next=%2Fidentity%3Fnext%3D%252Fshop%252Fwhisky"
contains "인증하지 않은 회원 — 본인인증 길" "$(render "$U" shop/whisky)" "/identity?next=%2Fshop%2Fwhisky"
contains "미성년 — 볼 수 없다고 말한다" "$(render "$M" shop/whisky)" "19세 미만이라"
ADULT_HTML="$(render "$A" shop/whisky)"
contains "성인 — 상세가 보인다" "$ADULT_HTML" "스모키한 피트향"
SEARCH="$(render - search 'q=%EC%9C%84%EC%8A%A4%ED%82%A4')"
contains "검색은 성인 상품을 찾는다 (이름으로 — 상세에서 확인)" "$SEARCH" "싱글몰트 위스키"
absent "검색 결과에 성인 상품 사진이 없다" "$SEARCH" "whisky.jpg"
absent "검색 결과에 성인 상품 설명이 없다" "$SEARCH" "스모키한 피트향"

order() {  # order <쿠키|-> → 상태코드
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"구매자","ordererPhone":"010-1111-2222","ordererEmail":"o@id.test","postcode":"06236","address1":"서울","paymentMethod":"bank_transfer"}}' "$ADULT" > "$TMP/o.json"
  curl -s ${jar[@]+"${jar[@]}"} -o "$TMP/o.out" -w "%{http_code}" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json"
}
check "비회원은 성인 상품을 주문할 수 없다" "$(order -)" "403"
check "인증하지 않은 회원도" "$(order "$U")" "403"
contains "주문서가 본인인증 화면으로 데려갈 수 있다 (field)" "$(cat "$TMP/o.out")" '"field":"identity"'
check "미성년은 인증했어도 주문할 수 없다" "$(order "$M")" "403"
check "성인은 주문한다" "$(order "$A")" "200"
curl -s -o /dev/null -b "$U" -X POST "$SHOP/cart" -H 'content-type: application/json' -d "{\"productId\":\"$ADULT\",\"quantity\":1}"
CART="$(curl -s -b "$U" "$SHOP/cart")"
contains "장바구니에는 담기지만" "$CART" "싱글몰트"
absent "사진은 싣지 않는다" "$CART" "whisky.jpg"

echo "── 회원 본인인증 필수 (사이트 설정)"
cart_add() {  # cart_add <쿠키|-> → 상태코드
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  code ${jar[@]+"${jar[@]}"} -X POST "$SHOP/cart" -H 'content-type: application/json' -d "$(printf '{"productId":"%s","quantity":1}' "$MUG")"
}
MUG="$(psql_q "SELECT id FROM shop_products WHERE slug='mug'")"
check "끈 상태 — 인증 안 한 회원도 담는다" "$(cart_add "$U")" "200"
check "설정을 켠다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.identity_required":true}')" "200"
contains "로그인 화면이 인증 화면으로 보낼지 안다" "$(curl -s -b "$U" "$API/api/me/identity")" '"verified":false,"adult":false,"verifiedAt":null,"required":true'
check "인증 안 한 회원 — 쓰기(장바구니)는 막힌다" "$(cart_add "$U")" "403"
REQ="$(curl -s -b "$U" -X POST "$SHOP/cart" -H 'content-type: application/json' -d "$(printf '{"productId":"%s","quantity":1}' "$MUG")")"
contains "이유와 함께 본인인증 길 (field)" "$REQ" '"field":"identity"'
check "읽기는 막지 않는다 (둘러보고 인증하러 간다)" "$(code -b "$U" "$SHOP/products")" "200"
check "인증한 회원은 쓴다" "$(cart_add "$M")" "200"
check "비회원은 대상이 아니다" "$(cart_add -)" "200"
check "운영진도 아니다" "$(cart_add "$CK")" "200"
check "끄면 다시 쓴다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.identity_required":false}'; cart_add "$U")" "200200"

echo "── 가입 전 본인인증 (사이트 설정)"
gjar() { local f="$TMP/guest-$1.txt"; : > "$f"; echo "$f"; }
gstate() { curl -s -b "$1" "$API/api/identity/signup"; }
gstart() {  # gstart <손님 쿠키> → requestId
  curl -s -b "$1" -c "$1" -X POST "$API/api/identity/signup/start" -H 'content-type: application/json' \
    -d '{"provider":"portone"}' | jq_get "['requestId']"
}
gcomplete() {  # gcomplete <손님 쿠키> <requestId> → "본문 상태"
  local body; body="$(printf '{"requestId":"%s"}' "$2")"
  curl -s -b "$1" -c "$1" -w ' %{http_code}' -X POST "$API/api/identity/signup/complete" -H 'content-type: application/json' -d "$body"
}
reg() {  # reg <손님 쿠키> <이메일> → "본문 상태"
  local body; body="$(printf '{"email":"%s","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"가입자","ageConfirmed":true}' "$2")"
  curl -s -b "$1" -c "$1" -w ' %{http_code}' -X POST "$API/api/register" -H 'content-type: application/json' -d "$body"
}
users_with() { psql_q "SELECT count(*) FROM users WHERE email='$1'"; }
# 오늘(한국 시간)에서 n 년 전의 날짜 (+d 일) — 만 14세 경계를 만든다
ago() { python3 -c "
import datetime, sys
t = (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).date() + datetime.timedelta(days=int(sys.argv[2]))
for shift in range(0, 3):
    try: print(t.replace(year=t.year - int(sys.argv[1])).isoformat()); break
    except ValueError: t = t + datetime.timedelta(days=1)
" "$1" "${2:-0}"; }

G0="$(gjar off)"
contains "끈 상태 — 가입 화면에 요구하지 않는다" "$(gstate "$G0")" '"required":false'
R="$(reg "$G0" "free@id.test")"
[[ "$R" == *" 201" ]] && ok "끈 상태 — 인증 없이 가입한다" || bad "끈 상태 가입 (${R:0:160})"
check "설정을 켠다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.identity_at_signup":true}')" "200"
G1="$(gjar one)"
contains "가입 화면이 인증을 요구한다는 것을 안다" "$(gstate "$G1")" '"required":true,"verified":false'
R="$(reg "$G1" "noverify@id.test")"
[[ "$R" == *" 403" && "$R" == *'"field":"identity"'* ]] && ok "인증하지 않은 브라우저는 가입할 수 없다 (본인인증 칸으로)" || bad "인증 없는 가입 (${R:0:160})"
check "계정이 만들어지지 않았다" "$(users_with noverify@id.test)" "0"
check "로그인한 회원은 가입 전 인증을 열 수 없다 (회원 인증으로)" \
  "$(code -b "$M" -X POST "$API/api/identity/signup/start" -H 'content-type: application/json' -d '{"provider":"portone"}')" "409"
RID1="$(gstart "$G1")"
[[ "$RID1" == bid* ]] && ok "손님 인증 시작 — 인증 ID 는 서버가 만든다" || bad "손님 인증 시작 ($RID1)"
check "이 브라우저에 묶는 쿠키는 스크립트가 읽지 못한다 (HttpOnly)" "$(grep -c '^#HttpOnly_.*brick_idv' "$G1")" "1"
verified "$RID1" "CI-SIGNUP-1" "1990-05-05"
GX="$(gjar other)"
# 다른 브라우저도 자기 인증을 시작해 제 쿠키를 가진 상태 — 쿠키가 없어서 막히는 것과 구별한다
gstart "$GX" >/dev/null
R="$(gcomplete "$GX" "$RID1")"
[[ "$R" == *" 404" ]] && ok "다른 브라우저는 (제 쿠키가 있어도) 남의 인증을 가져갈 수 없다" || bad "다른 브라우저 (${R:0:120})"
R="$(complete "$U" "$RID1")"
[[ "$R" == *" 404" ]] && ok "회원 인증 경로로도 손님의 인증을 가져갈 수 없다" || bad "회원 경로 (${R:0:120})"
R="$(gcomplete "$G1" "$RID1")"
[[ "$R" == *" 200" && "$R" == *'"adult":true'* ]] && ok "인증을 마친다 (성인)" || bad "손님 인증 확인 (${R:0:160})"
contains "가입 화면이 인증을 마친 것을 안다" "$(gstate "$G1")" '"required":true,"verified":true'
cp "$G1" "$TMP/guest-one-copy.txt"
R="$(reg "$G1" "verified@id.test")"
[[ "$R" == *" 201" ]] && ok "인증을 마친 브라우저는 가입한다" || bad "인증 뒤 가입 (${R:0:160})"
NEW_ID="$(psql_q "SELECT id FROM users WHERE email='verified@id.test'")"
check "가입한 계정에 인증 결과가 붙는다 (출생 연도)" "$(psql_q "SELECT birth_year FROM user_certifications WHERE user_id='$NEW_ID'")" "1990"
check "요청에 남았던 결과는 지운다 (사람 해시·출생 연도)" \
  "$(psql_q "SELECT (consumed_at IS NOT NULL) AS used, (person_hash IS NULL) AS no_hash, (birth_year IS NULL) AS no_year, (user_id = '$NEW_ID') AS owner FROM identity_verifications WHERE request_id='$RID1'")" "true|true|true|true"
check "가입이 쿠키를 치운다" "$(grep -c 'brick_idv' "$G1")" "0"
R="$(reg "$TMP/guest-one-copy.txt" "replay@id.test")"
[[ "$R" == *" 403" ]] && ok "쿠키를 복사해 두어도 한 번 가져간 인증으로 또 가입할 수 없다" || bad "인증 재사용 (${R:0:160})"
check "두 번째 계정은 없다" "$(users_with replay@id.test)" "0"
NEWCK="$TMP/verified.txt"
printf '{"email":"verified@id.test","password":"password123"}' > "$TMP/vlogin.json"
curl -s -o /dev/null -c "$NEWCK" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/vlogin.json"
contains "새 회원은 인증된 상태로 시작한다" "$(curl -s -b "$NEWCK" "$API/api/me/identity")" '"verified":true'
check "새 회원은 쓸 수 있다" "$(cart_add "$NEWCK")" "200"
check "인증하지 않은 기존 회원(소셜 가입과 같은 처지)은 쓰기가 막힌다" "$(cart_add "$U")" "403"

echo "── 가입 전 본인인증 — 만 14세 미만"
GK="$(gjar kid)"
RIDK="$(gstart "$GK")"; verified "$RIDK" "CI-KID-1" "$(ago 14 1)"
R="$(gcomplete "$GK" "$RIDK")"
[[ "$R" == *" 403" && "$R" == *"만 14세 미만"* ]] && ok "내일 만 14세가 되는 사람은 아직 가입할 수 없다" || bad "만 14세 경계 (${R:0:160})"
contains "그 브라우저는 인증을 마친 것이 아니다" "$(gstate "$GK")" '"verified":false'
check "가입도 막힌다" "$(reg "$GK" "kid@id.test" | tail -c 3)" "403"
GB="$(gjar birthday)"
RIDB="$(gstart "$GB")"; verified "$RIDB" "CI-TEEN-1" "$(ago 14 0)"
R="$(gcomplete "$GB" "$RIDB")"
[[ "$R" == *" 200" && "$R" == *'"adult":false'* ]] && ok "오늘 만 14세가 된 사람은 가입할 수 있다 (성인은 아니다)" || bad "만 14세 생일 (${R:0:160})"
check "생년월일은 남기지 않는다 (판정만)" "$(psql_q "SELECT over14 FROM identity_verifications WHERE request_id='$RIDB'")" "true"

echo "── 가입 전 본인인증 — 한 사람 한 계정"
# 이 절에서 가입을 여러 번 한다 — 같은 주소의 가입 한도(시간당 20회)는 시험의 사정이라 여기서 비운다
psql_q "DELETE FROM rate_limit_hits WHERE key LIKE 'register-ip:%'" >/dev/null
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.one_person_one_account":true}'
G3="$(gjar same)"
RID3="$(gstart "$G3")"; verified "$RID3" "CI-SIGNUP-1" "1990-05-05"
R="$(gcomplete "$G3" "$RID3")"
[[ "$R" == *" 409" && "$R" == *"이미 이 사이트에 가입한 계정"* ]] && ok "이미 가입한 사람은 계정을 만들기 전에 거절한다" || bad "이미 가입한 사람 (${R:0:160})"
G4="$(gjar race-a)"; G5="$(gjar race-b)"
RID4="$(gstart "$G4")"; verified "$RID4" "CI-SIGNUP-2" "1985-01-01"
RID5="$(gstart "$G5")"; verified "$RID5" "CI-SIGNUP-2" "1985-01-01"
R4="$(gcomplete "$G4" "$RID4")"; R5="$(gcomplete "$G5" "$RID5")"
[[ "$R4" == *" 200" && "$R5" == *" 200" ]] && ok "같은 사람이 두 창에서 인증을 마쳤다 (둘 다 아직 가입 전)" || bad "두 창 인증 (${R4:0:80} / ${R5:0:80})"
check "첫 창은 가입한다" "$(reg "$G4" "race-a@id.test" | tail -c 3)" "201"
R="$(reg "$G5" "race-b@id.test")"
[[ "$R" == *" 409" ]] && ok "둘째 창은 가입할 때 다시 보고 거절한다" || bad "둘째 창 가입 (${R:0:160})"
check "둘째 계정은 만들어지지 않았다 (트랜잭션이 되돌린다)" "$(users_with race-b@id.test)" "0"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.one_person_one_account":false}'

echo "── 가입 전 본인인증 — 30분이 지나면 다시"
G6="$(gjar late)"
RID6="$(gstart "$G6")"; verified "$RID6" "CI-LATE-1" "1995-03-03"; gcomplete "$G6" "$RID6" >/dev/null
psql_q "UPDATE identity_verifications SET completed_at = now() - interval '31 minutes' WHERE request_id='$RID6'" >/dev/null
contains "오래된 인증은 마친 것으로 치지 않는다" "$(gstate "$G6")" '"verified":false'
check "가입도 막힌다" "$(reg "$G6" "late@id.test" | tail -c 3)" "403"

echo "── 가입 전 본인인증 — 인증 화면"
SIGNUP_HTML="$(render - identity "signup=1&next=%2Fregister")"
contains "손님에게 가입 전 인증 안내를 보여 준다" "$SIGNUP_HTML" "가입하기 전에 본인인증을 합니다"
contains "손님용 경로로 인증을 시작한다" "$SIGNUP_HTML" "/api/identity/signup/start"
contains "인증 수단 버튼이 있다" "$SIGNUP_HTML" 'data-provider="portone"'
absent "로그인하라고 하지 않는다" "$SIGNUP_HTML" "로그인한 뒤 할 수 있습니다"
contains "가입 표시가 없으면 손님에게는 여전히 로그인 안내" "$(render - identity)" "로그인한 뒤 할 수 있습니다"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.identity_at_signup":false}'
check "끄면 인증 안 한 회원도 다시 쓴다" "$(cart_add "$U")" "200"

echo "── 탈퇴하면 인증 기록이 지워진다"
AID="$(psql_q "SELECT id FROM users WHERE email='a@id.test'")"
ID_ROWS="SELECT (SELECT count(*) FROM user_certifications WHERE user_id='$AID') || '|' || (SELECT count(*) FROM identity_verifications WHERE user_id='$AID')"
check "탈퇴 전에는 인증 결과 1건과 요청 기록 8건" "$(psql_q "$ID_ROWS")" "1|8"
contains "탈퇴" "$(curl -s -b "$A" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' -d '{"password":"password123","deletePosts":false}')" '"ok":true'
check "인증 결과·요청 기록이 남지 않는다" "$(psql_q "$ID_ROWS")" "0|0"

echo "── 영어 사이트"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.locale":"en"}'
sleep 2
contains "인증 수단 이름이 사이트 언어를 따른다" "$(curl -s "$API/api/identity/providers")" "Mobile identity verification"
contains "오류 문장도 번역된다" "$(complete "$U" bidnotexisting)" "The verification request was not found."
contains "성인 상품 주문 거절도 번역된다" "$(order "$U" >/dev/null; cat "$TMP/o.out")" "adults-only product"

echo "── 플러그인을 끄면 인증 수단도 사라진다"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"member.identity_required":true}'
check "켜 둔 필수 설정 — 수단이 있을 때는 막는다" "$(cart_add "$U")" "403"
curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/brick-pay-portone/deactivate"
check "목록에서 빠진다" "$(curl -s "$API/api/identity/providers")" '{"items":[]}'
check "인증 수단이 없으면 필수 설정을 강제하지 않는다 (아무도 인증할 수 없다)" "$(cart_add "$U")" "200"
contains "로그인 화면도 보내지 않는다" "$(curl -s -b "$U" "$API/api/me/identity")" '"required":false'
check "시작할 수 없다 (꺼진 확장이 요금을 쓰지 않는다)" "$(code -b "$U" -X POST "$API/api/me/identity/start" -H 'content-type: application/json' -d '{"provider":"portone"}')" "400"

echo "── 시크릿이 새지 않는다"
absent "서버 로그에 시크릿이 없다" "$(cat "$TMP/api.log")" "SECRET_DO_NOT_LEAK"
absent "서버 로그에 CI 가 없다" "$(cat "$TMP/api.log")" "CI-ALICE"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 포트원으로 나간 요청 ──"; cat "$POLOG"; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
