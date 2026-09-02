#!/usr/bin/env bash
#
# 모더레이션 E2E 스모크 — 그누보드 기본 설정 동등성 (금지 단어 · 가입 금지 · 접속 차단 IP).
#
# 커뮤니티를 운영하면 첫 주에 필요해지는 것들이다. 못박는 것:
#   - 금지 단어가 글 제목/본문·수정·댓글·쪽지·닉네임에서 막히고, **무엇이 걸렸는지** 알려주는가
#   - 태그 사이에 끼워 넣은 우회("바<b></b>보")도 막히는가
#   - 운영진 사칭 이름(관리자·admin)은 설정 없이도 막히는가, 설정 목록도 반영되는가
#   - 가입 금지 이메일 도메인
#   - 접속 차단 IP: 차단된 주소는 403, 헬스 체크는 예외, 관리자 **자기잠금**은 저장 시 거부
#   - 설정 저장 직후 다음 요청부터 반영되는가 (5초 캐시가 저장 시 비워진다)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-moderation.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
BD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jf()       { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || echo ""; }

kill_port() {
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)"
  fi
  for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  [[ -n "$pids" ]] && sleep 1
  return 0
}
start_server() {
  kill_port "$API_PORT"
  node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
  API_PID=$!
  for i in $(seq 1 60); do
    curl -fsS "$API/readyz" >/dev/null 2>&1 && break
    kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
    sleep 1
  done
}

echo "▶ 모더레이션 스모크 테스트"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-moderation-secret-value}"
export BRICK_CAPTCHA=off
# 프록시 헤더를 신뢰해야 X-Forwarded-For 로 "다른 주소에서 온 요청"을 흉내 낼 수 있다
export BRICK_TRUST_PROXY=true

node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
start_server

curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
  -d '{"siteName":"모더레이션","adminEmail":"admin@mod.test","adminPassword":"adminpass123","starter":"community"}' -o /dev/null
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@mod.test","password":"adminpass123"}' -o /dev/null
# 쪽지 플러그인도 켠다 (쪽지 본문 검사)
curl -s -b "$CK" -X POST "$API/api/plugins/brick-memo/activate" -o /dev/null
# 게시판: 회원 도배 방지 0
FREE_ID="$(curl -s -b "$CK" "$BD/admin/boards" | python3 -c "import sys,json;print(next(b['id'] for b in json.load(sys.stdin)['items'] if b['slug']=='free'))")"
curl -s -b "$CK" -X PUT "$BD/admin/boards/$FREE_ID" -H 'content-type: application/json' \
  -d '{"slug":"free","title":"자유게시판","read_role":"guest","write_role":"guest","comment_role":"guest","write_interval":0}' -o /dev/null

# 일반 회원 하나
cat > "$TMP/u.json" <<'JSON'
{"email":"user@mod.test","password":"password123","displayName":"평범한회원","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
U="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/u.json" | jf "['id']")"
[[ -n "$U" ]] && ok "일반 회원 가입" || bad "일반 회원 가입 실패"
UK="$TMP/user.txt"
curl -s -c "$UK" -X POST "$API/api/auth/login" -H 'content-type: application/json' -d '{"email":"user@mod.test","password":"password123"}' -o /dev/null

# ════════════════════════════════════════════════════
echo "── 운영진 사칭 이름은 설정 없이도 막힌다"
cat > "$TMP/adm.json" <<'JSON'
{"email":"fake@mod.test","password":"password123","displayName":"관리자","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
R="$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/adm.json")"
contains "\"관리자\" 로는 가입 못 한다" "$R" "사용할 수 없는 이름"
cat > "$TMP/adm2.json" <<'JSON'
{"email":"fake2@mod.test","password":"password123","displayName":"Ad min","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
contains "공백·대소문자로 우회 못 한다 (Ad min)" "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/adm2.json")" "사용할 수 없는 이름"
contains "이름 변경으로도 못 된다" "$(curl -s -b "$UK" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"운영자"}')" "사용할 수 없는 이름"

echo "── 금지 단어 (설정 저장 → 바로 반영)"
check "설정 저장" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"moderation.banned_words":"바보, 멍청이\n광고문의"}')" "200"
cat > "$TMP/p1.json" <<'JSON'
{"title":"평범한 글","content":"<p>너 바보야</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
R="$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p1.json")"
contains "본문의 금지 단어는 400 + 걸린 단어를 알려준다" "$R" "사용할 수 없는 단어가 있습니다: 바보"
cat > "$TMP/p2.json" <<'JSON'
{"title":"바보 제목","content":"<p>내용</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
contains "제목도 검사한다" "$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p2.json")" "바보"
cat > "$TMP/p3.json" <<'JSON'
{"title":"우회 시도","content":"<p>바<b></b>보</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
contains "태그 사이에 끼운 우회도 막힌다" "$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p3.json")" "바보"
cat > "$TMP/p4.json" <<'JSON'
{"title":"대소문자","content":"<p>광고문의 주세요</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
contains "줄바꿈으로 나눈 두 번째 단어도" "$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p4.json")" "광고문의"
cat > "$TMP/p5.json" <<'JSON'
{"title":"정상 글","content":"<p>안녕하세요 반갑습니다</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
PID="$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p5.json" | jf "['id']")"
[[ -n "$PID" ]] && ok "금지 단어 없는 글은 올라간다" || bad "정상 글 작성 실패"
cat > "$TMP/p6.json" <<'JSON'
{"title":"정상 글","content":"<p>수정하면서 멍청이</p>","guestPassword":"pass1234"}
JSON
contains "수정으로도 못 넣는다" "$(curl -s -X PUT "$BD/posts/$PID" -H 'content-type: application/json' --data-binary "@$TMP/p6.json")" "멍청이"
contains "댓글도" "$(curl -s -X POST "$BD/posts/$PID/comments" -H 'content-type: application/json' -d '{"content":"바보 댓글","guestName":"손님","guestPassword":"pass1234"}')" "바보"
check "정상 댓글은 된다" "$(code -X POST "$BD/posts/$PID/comments" -H 'content-type: application/json' -d '{"content":"좋은 글이네요","guestName":"손님","guestPassword":"pass1234"}')" "200"
contains "쪽지도" "$(curl -s -b "$UK" -X POST "$API/api/plugins/brick-memo" -H 'content-type: application/json' -d '{"receiverEmail":"admin@mod.test","content":"바보야"}')" "바보"
contains "이름에 금지 단어도" "$(curl -s -b "$UK" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"바보왕"}')" "사용할 수 없는 단어"
check "설정을 비우면 다시 통과" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"moderation.banned_words":""}' -o /dev/null; code -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p1.json")" "200"

echo "── 가입 금지 이름 목록 · 이메일 도메인"
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"moderation.denied_names":"공식계정\nBrick","moderation.denied_email_domains":"tempmail.test, throwaway.test"}' -o /dev/null
cat > "$TMP/dn.json" <<'JSON'
{"email":"x1@mod.test","password":"password123","displayName":"brick","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
contains "설정 목록의 이름도 막힌다(대소문자 무시)" "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/dn.json")" "사용할 수 없는 이름"
cat > "$TMP/dd.json" <<'JSON'
{"email":"x2@mail.tempmail.test","password":"password123","displayName":"도메인시험","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
contains "하위 도메인까지 막힌다" "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/dd.json")" "도메인으로는 가입할 수 없습니다"
cat > "$TMP/dok.json" <<'JSON'
{"email":"x3@fine.test","password":"password123","displayName":"멀쩡한이름","agreements":{"terms":true,"privacy":true},"ageConfirmed":true}
JSON
contains "그 외 도메인은 가입된다" "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/dok.json")" '"id"'

echo "── 접속 차단 IP"
contains "형식이 틀리면 400" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.blocked_ips":"not-an-ip"}')" "IP 형식"
contains "자기 IP 를 차단하면 400 (자기잠금 방지)" "$(curl -s -b "$CK" -H 'X-Forwarded-For: 203.0.113.9' -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.blocked_ips":"203.0.113.9"}')" "스스로 차단"
check "다른 주소 차단은 저장된다" "$(code -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.blocked_ips":"203.0.113.0/24\n2001:db8::1"}')" "200"
check "차단된 주소는 403" "$(code -H 'X-Forwarded-For: 203.0.113.77' "$API/api/i18n")" "403"
check "IPv6 도" "$(code -H 'X-Forwarded-For: 2001:db8::1' "$API/api/i18n")" "403"
check "차단되지 않은 주소는 200" "$(code -H 'X-Forwarded-For: 198.51.100.5' "$API/api/i18n")" "200"
check "헬스 체크는 차단 목록과 무관" "$(code -H 'X-Forwarded-For: 203.0.113.77' "$API/readyz")" "200"
check "차단 해제하면 다시 200" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"security.blocked_ips":""}' -o /dev/null; code -H 'X-Forwarded-For: 203.0.113.77' "$API/api/i18n")" "200"

echo "── 분류 필수"
curl -s -b "$CK" -X PUT "$BD/admin/boards/$FREE_ID" -H 'content-type: application/json' \
  -d '{"slug":"free","title":"자유게시판","read_role":"guest","write_role":"guest","comment_role":"guest","write_interval":0,"categories":"잡담, 질문","category_required":true}' -o /dev/null
cat > "$TMP/c1.json" <<'JSON'
{"title":"분류 없이","content":"<p>x</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
contains "분류를 고르지 않으면 400" "$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/c1.json")" "분류를 선택"
cat > "$TMP/c2.json" <<'JSON'
{"title":"분류 있음","content":"<p>x</p>","category":"질문","guestName":"손님","guestPassword":"pass1234"}
JSON
contains "고르면 된다" "$(curl -s -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/c2.json")" '"id"'
contains "글쓰기 폼의 분류가 required" "$(curl -s "$API/api/render/page?path=board/free/write" | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))")" '<select name="category" required>'

echo
echo "── 설정 화면 (정적 검사)"
# 서버가 편집을 허용하는 설정(EDITABLE_SETTINGS)마다 관리 화면에 입력칸이 있어야 한다.
# M26 의 모더레이션 키 넷이 API 에만 있고 화면에 없던 것을 이 검사가 잡는다 —
# "API 는 있는데 화면이 없는 설정"은 운영자에게 없는 기능이다.
MISSING=""
for KEY in $(grep -oE '^\s*"[a-z_]+\.[a-z_0-9]+":\s*"(string|boolean)"' "$ROOT/apps/api/src/modules/site/site.controller.ts" | grep -oE '"[a-z_]+\.[a-z_0-9]+"' | tr -d '"'); do
  grep -q "\"$KEY\"" "$ROOT/apps/web/src/app/admin/(dashboard)/settings/page.tsx" || MISSING="$MISSING $KEY"
done
check "설정 화면이 편집 가능한 설정 키를 모두 담는다${MISSING:+ (누락:$MISSING)}" "$MISSING" ""

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
