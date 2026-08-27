#!/usr/bin/env bash
#
# brick-memo 쪽지 + 게시판 스크랩 E2E 스모크 테스트.
#
# 검증하는 것:
#   - 프라이버시 (제3자·관리자도 남의 쪽지 내용을 볼 수 없다)
#   - 각자 삭제 (받는 사람이 지워도 보낸함에는 남는다)
#   - 차단 · 도배 방지 · 하루 한도
#   - 포인트 차감 원자성 (부족하면 쪽지도 저장되지 않는다)
#   - 스크랩 토글과 권한
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-memo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="${DATABASE_URL:?DATABASE_URL이 필요합니다}"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
MM="$API/api/plugins/brick-memo"
PT="$API/api/plugins/brick-point"
BD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
U1="$TMP/u1.txt"
U2="$TMP/u2.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있어서는 안 됨)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jpost()    { curl -s -X POST "$1" -H 'content-type: application/json' --data-binary "@$2"; }
balance()  { curl -s -b "$1" "$PT/my" | python3 -c 'import sys,json;print(json.load(sys.stdin)["balance"])'; }
uid_of()   { node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query('SELECT id FROM users WHERE email = \$1', [process.argv[1]]);
  console.log(rows[0] ? rows[0].id : '');
  await c.end();
})();
" "$1"; }

echo "▶ brick-memo 쪽지 · 스크랩 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-memo-secret-value}"
# 이 스위트는 캡차를 시험하지 않는다 (smoke-security.sh 가 담당)
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비 ────────────────────────────────────────────
printf '{"siteName":"Memo","adminEmail":"admin@mm.test","adminPassword":"mmpass1234"}' > "$TMP/i.json"
jpost "$API/api/install" "$TMP/i.json" >/dev/null
printf '{"email":"admin@mm.test","password":"mmpass1234"}' > "$TMP/la.json"
curl -s -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/la.json" >/dev/null
for p in brick-point brick-memo brick-board; do
  curl -s -b "$ADMIN" -X POST "$API/api/plugins/$p/activate" >/dev/null
done
contains "쪽지 플러그인 활성화" "$(curl -s -b "$ADMIN" "$API/api/plugins")" "brick-memo"

for n in 1 2; do
  printf '{"email":"u%s@mm.test","password":"upass12345","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"회원%s"}' "$n" "$n" > "$TMP/r$n.json"
  jpost "$API/api/register" "$TMP/r$n.json" >/dev/null
  printf '{"email":"u%s@mm.test","password":"upass12345"}' "$n" > "$TMP/l$n.json"
done
curl -s -c "$U1" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l1.json" >/dev/null
curl -s -c "$U2" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l2.json" >/dev/null
U1ID="$(uid_of "u1@mm.test")"
U2ID="$(uid_of "u2@mm.test")"

echo "── 라우트 구체성 (구체 경로가 :param 보다 우선)"
# "/cost" 가 "/:id" 로 빨려 들어가면 uuid 파싱 오류가 난다 (실제로 발생했던 버그)
check "/cost 정상 응답" "$(code -b "$U1" "$MM/cost")" "200"
check "/inbox 정상 응답" "$(code -b "$U1" "$MM/inbox")" "200"
check "/blocks/list 정상 응답" "$(code -b "$U1" "$MM/blocks/list")" "200"
check "없는 uuid는 404" "$(code -b "$U1" "$MM/01a040ba-0000-0000-0000-000000000000")" "404"

echo "── 발송"
check "비로그인 발송 차단" "$(code -X POST "$MM/" -H 'content-type: application/json' -d '{"receiverEmail":"u2@mm.test","content":"x"}')" "401"
printf '{"receiverEmail":"u2@mm.test","content":"안녕하세요, 반갑습니다!"}' > "$TMP/s1.json"
SENT="$(curl -s -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s1.json")"
MID="$(echo "$SENT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
[[ -n "$MID" ]] && ok "쪽지 발송" || bad "쪽지 발송"
contains "받는 사람 이름 반환" "$SENT" "회원2"
printf '{"receiverEmail":"nobody@nowhere.invalid","content":"x"}' > "$TMP/s404.json"
check "없는 회원에게 발송 404" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s404.json")" "404"
printf '{"receiverEmail":"u1@mm.test","content":"나에게"}' > "$TMP/sself.json"
check "자신에게 발송 차단" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/sself.json")" "400"
printf '{"receiverEmail":"u2@mm.test","content":""}' > "$TMP/sempty.json"
check "빈 내용 차단" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/sempty.json")" "400"

echo "── 받은함 · 보낸함"
INBOX="$(curl -s -b "$U2" "$MM/inbox")"
contains "받은함에 표시" "$INBOX" "회원1"
contains "안읽음 1건" "$INBOX" '"unread":1'
contains "보낸함에 표시" "$(curl -s -b "$U1" "$MM/sent")" "회원2"
contains "안읽은 개수 API" "$(curl -s -b "$U2" "$MM/unread-count")" '"count":1'

echo "── 프라이버시 (당사자만 열람)"
check "제3자 열람 403" "$(code -b "$ADMIN" "$MM/$MID")" "403"
check "비로그인 열람 401" "$(code "$MM/$MID")" "401"
READ="$(curl -s -b "$U2" "$MM/$MID")"
contains "받는 사람은 열람 가능" "$READ" "반갑습니다"
contains "역할 표시" "$READ" '"role":"receiver"'
contains "읽으면 읽음 처리" "$(curl -s -b "$U1" "$MM/sent")" '"is_read":true'
# 관리자 목록은 내용을 담지 않는다
ADMIN_LIST="$(curl -s -b "$ADMIN" "$MM/admin/messages")"
contains "관리자 목록 조회" "$ADMIN_LIST" "회원1"
absent   "관리자 목록에 내용 없음" "$ADMIN_LIST" "반갑습니다"
contains "관리자 목록에 글자수만" "$ADMIN_LIST" '"length"'
check "비관리자 목록 차단" "$(code -b "$U1" "$MM/admin/messages")" "403"

echo "── 각자 삭제 (받는 사람이 지워도 보낸함에 남는다)"
check "받는 사람 삭제" "$(code -b "$U2" -X DELETE "$MM/$MID")" "200"
contains "받은함에서 사라짐" "$(curl -s -b "$U2" "$MM/inbox")" '"total":0'
contains "보낸함에는 남아 있음" "$(curl -s -b "$U1" "$MM/sent")" '"total":1'
# 양쪽 다 지우면 실제로 제거된다
curl -s -b "$U1" -X DELETE "$MM/$MID" >/dev/null
check "양쪽 삭제 후 조회 404" "$(code -b "$U1" "$MM/$MID")" "404"

echo "── 도배 방지 · 하루 한도"
printf '{"sendPoint":0,"sendInterval":300,"dailyLimit":50,"maxLength":2000}' > "$TMP/set1.json"
curl -s -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/set1.json" >/dev/null
printf '{"receiverEmail":"u2@mm.test","content":"연속 테스트"}' > "$TMP/s2.json"
check "첫 발송 성공" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s2.json")" "200"
check "같은 사람 연속 발송 429" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s2.json")" "429"
# 하루 한도 0건으로 두면 즉시 막혀야 한다
printf '{"sendPoint":0,"sendInterval":0,"dailyLimit":1,"maxLength":2000}' > "$TMP/set2.json"
curl -s -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/set2.json" >/dev/null
check "하루 한도 초과 429" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s2.json")" "429"
printf '{"sendPoint":0,"sendInterval":0,"dailyLimit":0,"maxLength":2000}' > "$TMP/set3.json"
curl -s -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/set3.json" >/dev/null

echo "── 차단"
check "자신 차단 불가" "$(code -b "$U2" -X POST "$MM/blocks/$U2ID")" "400"
check "차단 등록" "$(code -b "$U2" -X POST "$MM/blocks/$U1ID")" "200"
contains "차단 목록에 표시" "$(curl -s -b "$U2" "$MM/blocks/list")" "회원1"
check "차단된 사람은 발송 불가" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s2.json")" "403"
# 차단은 한 방향이다 — 차단한 쪽은 여전히 보낼 수 있다
printf '{"receiverEmail":"u1@mm.test","content":"차단했지만 보냄"}' > "$TMP/s3.json"
check "차단한 쪽은 발송 가능 (단방향)" "$(code -b "$U2" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s3.json")" "200"
curl -s -b "$U2" -X DELETE "$MM/blocks/$U1ID" >/dev/null
check "차단 해제 후 발송 가능" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s2.json")" "200"
check "중복 차단은 오류 없음(멱등)" "$(code -b "$U2" -X POST "$MM/blocks/$U1ID")" "200"
curl -s -b "$U2" -X DELETE "$MM/blocks/$U1ID" >/dev/null

echo "── 수신자 검색 (이메일 마스킹)"
SEARCH="$(curl -s -b "$U1" "$MM/recipients/search?q=%ED%9A%8C%EC%9B%90")"
contains "이름으로 검색" "$SEARCH" "회원2"
contains "이메일 마스킹" "$SEARCH" "email_masked"
absent   "전체 이메일 미노출" "$SEARCH" "u2@mm.test"
contains "2자 미만은 빈 결과" "$(curl -s -b "$U1" "$MM/recipients/search?q=a")" '"items":[]'
absent   "자신은 결과에서 제외" "$SEARCH" "$U1ID"

echo "── 포인트 차감 (원자성)"
printf '{"sendPoint":100,"sendInterval":0,"dailyLimit":0,"maxLength":2000}' > "$TMP/set4.json"
curl -s -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/set4.json" >/dev/null
contains "발송 비용 안내" "$(curl -s -b "$U1" "$MM/cost")" '"sendPoint":100'
BEFORE="$(balance "$U1")"
printf '{"receiverEmail":"u2@mm.test","content":"유료 쪽지"}' > "$TMP/s4.json"
contains "유료 발송 성공" "$(curl -s -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s4.json")" '"pointUsed":100'
AFTER="$(balance "$U1")"
check "포인트 100 차감" "$((BEFORE - AFTER))" "100"

# 잔액을 0으로 만들고 발송 → 실패하고 쪽지도 저장되지 않아야 한다
printf '{"adjust":-%s,"reason":"스모크 초기화"}' "$AFTER" > "$TMP/zero.json"
curl -s -b "$ADMIN" -X PUT "$PT/admin/balances/$U1ID" -H 'content-type: application/json' --data-binary "@$TMP/zero.json" >/dev/null
SENT_BEFORE="$(curl -s -b "$U1" "$MM/sent" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])')"
check "포인트 부족 시 발송 실패" "$(code -b "$U1" -X POST "$MM/" -H 'content-type: application/json' --data-binary "@$TMP/s4.json")" "400"
SENT_AFTER="$(curl -s -b "$U1" "$MM/sent" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])')"
check "실패 시 쪽지도 저장되지 않음 (원자성)" "$SENT_AFTER" "$SENT_BEFORE"
check "실패 후 잔액 0 유지" "$(balance "$U1")" "0"

echo "── 전체 읽음 처리"
printf '{"sendPoint":0,"sendInterval":0,"dailyLimit":0,"maxLength":2000}' > "$TMP/set5.json"
curl -s -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/set5.json" >/dev/null
contains "읽음 처리 실행" "$(curl -s -b "$U2" -X POST "$MM/read-all")" '"ok":true'
contains "안읽음 0" "$(curl -s -b "$U2" "$MM/unread-count")" '"count":0'

echo "── 스크랩"
printf '{"slug":"free","title":"자유","write_role":"member","write_interval":0}' > "$TMP/b.json"
curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b.json" >/dev/null
printf '{"title":"스크랩 대상","content":"<p>본문</p>"}' > "$TMP/p.json"
PID="$(curl -s -b "$U2" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p.json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
check "비로그인 스크랩 401" "$(code -X POST "$BD/posts/$PID/scrap")" "401"
contains "스크랩 등록" "$(curl -s -b "$U1" -X POST "$BD/posts/$PID/scrap")" '"scrapped":true'
contains "집계 반영" "$(curl -s -b "$U1" "$BD/posts/$PID")" '"scrap_count":1'
contains "내 스크랩 목록" "$(curl -s -b "$U1" "$BD/my/scraps")" "스크랩 대상"
contains "다시 누르면 해제" "$(curl -s -b "$U1" -X POST "$BD/posts/$PID/scrap")" '"scrapped":false'
contains "해제 후 집계 0" "$(curl -s -b "$U1" "$BD/posts/$PID")" '"scrap_count":0'
contains "목록에서도 사라짐" "$(curl -s -b "$U1" "$BD/my/scraps")" '"total":0'
check "없는 글 스크랩 404" "$(code -b "$U1" -X POST "$BD/posts/01a040ba-0000-0000-0000-000000000000/scrap")" "404"

echo "── 화면 렌더 (페이지 하나가 여러 화면)"
printf '{"slug":"memo","title":"쪽지","status":"published","blocks":[{"block":"brick-memo/memo","props":{}}]}' > "$TMP/page.json"
curl -s -b "$ADMIN" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/page.json" >/dev/null
render() { curl -s "$API/api/render/page?path=$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'; }
# 로그인 상태 렌더 — 쿠키를 넘긴다 (이 경로는 캐시되지 않는다)
render_as() { curl -s -b "$2" "$API/api/render/page?path=$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'; }

INBOX_HTML="$(render "memo")"
contains "쪽지 화면 렌더" "$INBOX_HTML" "brick-memo"
# 비로그인에게는 껍데기조차 주지 않는다 — 로그인 안내만
contains "비로그인은 로그인 안내" "$INBOX_HTML" "로그인 후 이용"
# 스크립트 안의 선택자 문자열과 구분해야 하므로 속성 값까지 확인한다
absent   "비로그인에는 화면 상태 미노출" "$INBOX_HTML" 'data-memo-view="inbox"'
# 본문은 서버 렌더에 담기지 않는다 (사적 내용이 캐시·이력에 남지 않게)
absent "쪽지 내용이 HTML에 없음" "$INBOX_HTML" "유료 쪽지"

LOGGED="$(render_as "memo" "$U1")"
contains "로그인 시 받은함 껍데기" "$LOGGED" 'data-memo-view="inbox"'
contains "탭 표시" "$LOGGED" "보낸 쪽지"
absent   "로그인 렌더에도 본문 없음" "$LOGGED" "유료 쪽지"
contains "쓰기 화면 렌더" "$(render_as "memo%2Fwrite" "$U1")" 'data-memo-view="write"'
contains "차단 목록 화면" "$(render_as "memo%2Fblocks" "$U1")" 'data-memo-view="blocks"'
contains "쪽지 배지 블록 등록" "$(curl -s "$API/api/blocks")" "brick-memo/unread-badge"

echo "── 관리 화면 · 설정"
NAV="$(curl -s -b "$ADMIN" "$API/api/admin/nav")"
contains "쪽지 리소스 등록" "$NAV" '"name":"messages"'
contains "쪽지 설정 리소스" "$NAV" '"plugin":"brick-memo"'
printf '{"sendPoint":-5}' > "$TMP/badset.json"
check "범위 밖 설정 거부" "$(code -b "$ADMIN" -X PUT "$MM/admin/settings-list/settings" -H 'content-type: application/json' --data-binary "@$TMP/badset.json")" "400"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
