#!/usr/bin/env bash
#
# 게시판 — 읽기 권한이 **모든 통로**에서 같은가, 그리고 게시판별 본인인증·성인 인증.
#
# 1) 글 하나에 닿는 경로(읽기·첨부·댓글·스크랩)와 보는 사람을 모르는 통로(통합검색·사이트맵·
#    최근 글 위젯)가 게시판 목록과 **같은 규칙**(그룹 권한 · 공개 여부)을 쓰는가. 전에는 목록만
#    그룹 권한을 봤고, 글 ID 를 아는 비회원은 회원 전용 그룹의 글과 첨부를 그대로 읽었다.
# 2) 본인인증을 요구하는 게시판 — 목록·글·댓글·첨부·쓰기가 확인 뒤에만 열리고, 모아 보기
#    통로에서는 빠진다. 성인 게시판은 청소년보호법상 성인만.
# 3) 댓글·문의 답변 알림도 운영자가 문구를 고칠 수 있다(기본 문구 = 실제 문구).
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-board-cert.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
BD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
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
render() {  # render <쿠키|-> <경로> → html
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  curl -s ${jar[@]+"${jar[@]}"} "$API/api/render/page?path=$2" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'
}
signup() {  # signup <이메일> → 쿠키 파일
  curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\",\"agreements\":{\"terms\":true,\"privacy\":true},\"displayName\":\"회원$RANDOM\"}"
  curl -s -o /dev/null -c "$TMP/$1.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}"
  echo "$TMP/$1.txt"
}
# 본인인증 결과를 넣는다 — 인증 흐름 자체는 smoke-identity 가 시험한다. 여기서는 게시판이 결과를 읽는가
certify() {  # certify <이메일> <출생연도>
  psql_q "INSERT INTO user_certifications (user_id, provider, person_hash, birth_year)
          SELECT id, 'test', md5(email) || md5(email), $2 FROM users WHERE email='$1'" >/dev/null
}
newpost() {  # newpost <쿠키|-> <게시판> <제목> → id
  local jar=()
  [[ "$1" != "-" ]] && jar=(-b "$1")
  printf '{"title":"%s","content":"<p>%s 본문</p>","guestName":"손님","guestPassword":"pass1234"}' "$3" "$3" > "$TMP/np.json"
  curl -s ${jar[@]+"${jar[@]}"} -X POST "$BD/boards/$2/posts" -H 'content-type: application/json' --data-binary "@$TMP/np.json" | jq_get "['id']"
}
# 사이트맵 전체 — /sitemap.xml 은 조각 목록(색인)이고 글 주소는 조각(/sitemap-N.xml)에 있다.
# 색인만 보면 어떤 글 주소도 "없다" 고 통과한다
sitemap_all() {
  local idx; idx="$(curl -s "$API/sitemap.xml")"
  echo "$idx"
  for u in $(echo "$idx" | grep -o '<loc>[^<]*</loc>' | sed -E 's#</?loc>##g; s#^https?://[^/]+##'); do curl -s "$API$u"; done
}
YEAR="$(python3 -c 'import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(hours=9)).year)')"

echo "▶ 게시판 읽기 규칙 · 본인인증 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-boardcert-secret-value}"
export BRICK_CAPTCHA=off

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
    -d '{"siteName":"게시판인증","adminEmail":"admin@bc.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@bc.test","password":"adminpass123"}' >/dev/null
for pl in brick-board brick-helpdesk; do curl -s -o /dev/null -b "$CK" -X POST "$API/api/plugins/$pl/activate"; done
MEM="$(signup mem@bc.test)"

board() {  # board <slug> <추가 JSON 조각> → id
  curl -s -b "$CK" -X POST "$BD/admin/boards" -H 'content-type: application/json' \
    -d "{\"slug\":\"$1\",\"title\":\"$1 게시판\",\"read_role\":\"guest\",\"write_role\":\"guest\",\"comment_role\":\"guest\",\"download_role\":\"guest\",\"allow_upload\":true,\"write_interval\":0$2}" | jq_get "['id']"
}
curl -s -o /dev/null -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"board","title":"게시판","status":"published","blocks":[{"block":"brick-board/board","props":{}}]}'
curl -s -o /dev/null -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"home","title":"홈","status":"published","blocks":[{"block":"brick-board/latest-posts","props":{"limit":30}}]}'

echo "── 회원 전용 그룹 안의 게시판 — 모든 통로가 같은 규칙인가"
GID="$(curl -s -b "$CK" -X POST "$BD/admin/groups" -H 'content-type: application/json' -d '{"slug":"inner","title":"회원 공간","read_role":"member"}' | jq_get "['id']")"
board open "" >/dev/null
board inner ",\"group_id\":\"$GID\"" >/dev/null
OPEN_POST="$(newpost - open 공개글그린사과)"
INNER_POST="$(newpost "$CK" inner 그룹글파란포도)"
printf 'secret-attachment' > "$TMP/f.txt"
curl -s -o /dev/null -b "$CK" -X POST "$BD/posts/$INNER_POST/files" -F "file=@$TMP/f.txt;type=text/plain"
FILE_ID="$(psql_q "SELECT id FROM board_attachments WHERE post_id='$INNER_POST' LIMIT 1")"
[[ -n "$FILE_ID" ]] && ok "그룹 게시판 글에 첨부" || bad "첨부 준비 실패"
check "목록은 비회원에게 닫혀 있다 (원래 그랬다)" "$(code "$BD/boards/inner/posts")" "401"
check "글 ID 로 직접 읽어도 닫힌다" "$(code "$BD/posts/$INNER_POST")" "401"
check "첨부를 직접 받아도 닫힌다" "$(code "$BD/files/$FILE_ID")" "401"
check "댓글을 달 수도 없다" "$(code -X POST "$BD/posts/$INNER_POST/comments" -H 'content-type: application/json' -d '{"content":"몰래","guestName":"x","guestPassword":"pass1234"}')" "401"
check "회원은 읽는다" "$(code -b "$MEM" "$BD/posts/$INNER_POST")" "200"
check "공개 게시판 글은 그대로" "$(code "$BD/posts/$OPEN_POST")" "200"
SEARCH="$(curl -s "$API/api/search?q=%ED%8C%8C%EB%9E%80%ED%8F%AC%EB%8F%84")"
absent "비회원 통합검색에 그룹 글이 나오지 않는다" "$SEARCH" "$INNER_POST"
contains "회원 검색에는 나온다 (검색이 그 글을 찾기는 한다)" "$(curl -s -b "$MEM" "$API/api/search?q=%ED%8C%8C%EB%9E%80%ED%8F%AC%EB%8F%84")" "$INNER_POST"
SITEMAP="$(sitemap_all)"
contains "사이트맵에 공개 글은 있다" "$SITEMAP" "/board/open/$OPEN_POST"
absent "사이트맵에 그룹 글 주소가 없다" "$SITEMAP" "$INNER_POST"
HOME_HTML="$(render - home)"
contains "최근 글 위젯에 공개 글" "$HOME_HTML" "공개글그린사과"
absent "최근 글 위젯에 그룹 글 제목이 없다" "$HOME_HTML" "그룹글파란포도"

echo "── 공개를 끈 게시판"
HID="$(board hidden "")"
HID_POST="$(newpost - hidden 숨긴게시판글)"
curl -s -o /dev/null -b "$CK" -X PUT "$BD/admin/boards/$HID" -H 'content-type: application/json' \
  -d '{"slug":"hidden","title":"hidden 게시판","read_role":"guest","write_role":"guest","comment_role":"guest","write_interval":0,"is_visible":false}'
check "글 ID 로도 읽을 수 없다" "$(code "$BD/posts/$HID_POST")" "404"
absent "검색에도 없다" "$(curl -s "$API/api/search?q=%EC%88%A8%EA%B8%B4%EA%B2%8C%EC%8B%9C%ED%8C%90%EA%B8%80")" "$HID_POST"

echo "── 본인인증 게시판"
CERT_ID="$(board realname ",\"cert_required\":\"verified\"")"
[[ -n "$CERT_ID" ]] && ok "본인인증 게시판 생성" || bad "생성 실패"
check "모르는 값은 거절 (오타로 열리지 않게)" "$(code -b "$CK" -X POST "$BD/admin/boards" -H 'content-type: application/json' -d '{"slug":"typo","title":"x","read_role":"guest","write_role":"guest","cert_required":"adults"}')" "400"
CERT_POST="$(newpost "$CK" realname 실명글노란레몬)"
[[ -n "$CERT_POST" ]] && ok "운영진은 통과 (글쓰기)" || bad "운영진 글쓰기 실패"
check "비회원 — 목록" "$(code "$BD/boards/realname/posts")" "401"
check "인증 안 한 회원 — 목록" "$(code -b "$MEM" "$BD/boards/realname/posts")" "403"
R="$(curl -s -b "$MEM" "$BD/posts/$CERT_POST")"
contains "인증 안 한 회원 — 글 (이유)" "$R" "본인인증한 회원만"
contains "화면이 본인인증으로 데려갈 수 있다 (field)" "$R" '"field":"identity"'
check "인증 안 한 회원 — 글쓰기" "$(code -b "$MEM" -X POST "$BD/boards/realname/posts" -H 'content-type: application/json' -d '{"title":"t","content":"<p>c</p>"}')" "403"
check "인증 안 한 회원 — 댓글" "$(code -b "$MEM" -X POST "$BD/posts/$CERT_POST/comments" -H 'content-type: application/json' -d '{"content":"c"}')" "403"
GATE="$(render "$MEM" board/realname)"
contains "게시판 화면 — 안내" "$GATE" "본인인증한 회원만 이용할 수 있는 게시판입니다"
contains "게시판 화면 — 본인인증 길 (돌아올 곳을 붙여서)" "$GATE" "/identity?next=%2Fboard%2Frealname"
absent "게시판 화면 — 글 제목을 그리지 않는다" "$GATE" "실명글노란레몬"
contains "비회원 화면 — 로그인 뒤 본인인증" "$(render - board/realname)" "/login?next=%2Fidentity"
certify mem@bc.test 1990
check "인증하면 목록" "$(code -b "$MEM" "$BD/boards/realname/posts")" "200"
check "글" "$(code -b "$MEM" "$BD/posts/$CERT_POST")" "200"
check "댓글" "$(code -b "$MEM" -X POST "$BD/posts/$CERT_POST/comments" -H 'content-type: application/json' -d '{"content":"인증 회원 댓글"}')" "200"
[[ -n "$(newpost "$MEM" realname 인증회원글)" ]] && ok "글쓰기" || bad "인증 회원 글쓰기 실패"
contains "게시판 화면이 열린다" "$(render "$MEM" board/realname)" "실명글노란레몬"
absent "비회원 검색에 본인인증 게시판 글이 없다" "$(curl -s "$API/api/search?q=%EB%85%B8%EB%9E%80%EB%A0%88%EB%AA%AC")" "$CERT_POST"
absent "사이트맵에도" "$(sitemap_all)" "$CERT_POST"
absent "최근 글 위젯에도" "$(render - home)" "실명글노란레몬"
check "RSS 도 없다" "$(code "$BD/boards/realname/rss")" "403"

echo "── 성인 게시판"
board adult ",\"cert_required\":\"adult\"" >/dev/null
ADULT_POST="$(newpost "$CK" adult 성인글)"
MINOR="$(signup minor@bc.test)"; certify minor@bc.test $((YEAR - 18))
R="$(curl -s -b "$MINOR" "$BD/posts/$ADULT_POST")"
contains "인증한 미성년 — 볼 수 없다고 말한다" "$R" "19세 미만이라"
absent "미성년에게는 본인인증 길을 권하지 않는다 (다시 해도 같다)" "$(render "$MINOR" board/adult)" "/identity?next="
UNV="$(signup unv@bc.test)"
contains "인증 안 한 회원 — 성인 인증 요구" "$(curl -s -b "$UNV" "$BD/posts/$ADULT_POST")" "성인 인증(19세 이상)이 필요한"
check "인증한 성인 — 읽는다" "$(code -b "$MEM" "$BD/posts/$ADULT_POST")" "200"

echo "── 댓글·문의 답변 알림도 문구를 고칠 수 있다"
LIST="$(curl -s -b "$CK" "$API/api/admin/notification-templates")"
contains "게시판 댓글 알림" "$LIST" '"event":"board.comment"'
contains "문의 답변 알림" "$LIST" '"event":"helpdesk.answered"'
contains "기본 문구가 변수로" "$(curl -s -b "$CK" "$API/api/admin/notification-templates/board.comment")" "#{댓글작성자}"
# 기본 문구 그대로 저장해 보낸 알림 = 고치지 않은 알림 (글쓴이에게 가는 알림함 본문으로 비교)
curl -s -o /dev/null -b "$CK" -X PUT "$BD/admin/boards/$(psql_q "SELECT id FROM board_boards WHERE slug='open'")" -H 'content-type: application/json' \
  -d '{"slug":"open","title":"open 게시판","read_role":"guest","write_role":"guest","comment_role":"guest","write_interval":0,"notify_comment":true}'
MYPOST="$(newpost "$MEM" open 내글)"
CM="$(signup cm@bc.test)"
inbox_last() { psql_q "SELECT title || ' / ' || body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email='mem@bc.test' AND n.kind='board.comment' ORDER BY n.created_at DESC LIMIT 1"; }
curl -s -o /dev/null -b "$CM" -X POST "$BD/posts/$MYPOST/comments" -H 'content-type: application/json' -d '{"content":"첫 댓글"}'
sleep 1
N1="$(inbox_last)"
contains "댓글 알림이 왔다" "$N1" "첫 댓글"
python3 -c "
import json,sys
d=json.load(sys.stdin)['defaults']
json.dump({'subject':d['subject'],'body':d['body'],'sms':''}, open(sys.argv[1],'w'), ensure_ascii=False)" "$TMP/same.json" \
  < <(curl -s -b "$CK" "$API/api/admin/notification-templates/board.comment")
check "기본 문구 그대로 저장" "$(code -b "$CK" -X PUT "$API/api/admin/notification-templates/board.comment" -H 'content-type: application/json' --data-binary "@$TMP/same.json")" "200"
curl -s -o /dev/null -b "$CM" -X POST "$BD/posts/$MYPOST/comments" -H 'content-type: application/json' -d '{"content":"첫 댓글"}'
sleep 1
check "기본 문구로 보낸 알림 = 고치지 않은 알림" "$(inbox_last)" "$N1"
printf '{"subject":"[#{게시판명}] 새 댓글","body":"#{댓글작성자}님: #{댓글요약}","sms":""}' > "$TMP/custom.json"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/admin/notification-templates/board.comment" -H 'content-type: application/json' --data-binary "@$TMP/custom.json"
curl -s -o /dev/null -b "$CM" -X POST "$BD/posts/$MYPOST/comments" -H 'content-type: application/json' -d '{"content":"두번째"}'
sleep 1
contains "고친 문구로 나간다" "$(inbox_last)" "[open 게시판] 새 댓글 / "
contains "변수를 채운다" "$(inbox_last)" "님: 두번째"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
