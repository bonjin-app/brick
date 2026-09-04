#!/usr/bin/env bash
#
# brick-board 게시판 E2E 스모크 테스트.
#
# 그누보드에서 옮겨오는 사람이 기대하는 것을 검증한다:
#   등급별 권한 · 분류 · 답변형(계층) · 비밀글 · 첨부파일(+권한) ·
#   추천/비추천 · 비회원 글쓰기(비밀번호) · 검색 · 도배 방지 · RSS
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-board.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="${DATABASE_URL:?DATABASE_URL이 필요합니다}"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
BD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
MEMBER="$TMP/member.txt"
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
# 렌더 결과의 html 필드를 꺼낸다.
# JSON 안에서는 따옴표가 이스케이프되므로 원문에서 문자열을 찾으면 어긋난다.
render_html() { curl -s "$API/api/render/page?path=$1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))'; }

echo "▶ brick-board 게시판 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-board-secret-value}"
# 이 스위트는 캡차를 시험하지 않는다. 켜두면 회원가입·비회원 글쓰기가 막힌다.
# 캡차 자체는 smoke-security.sh 가 검증한다.
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비: 설치 · 관리자/회원 로그인 · 플러그인 활성화 ──
printf '{"siteName":"Board","adminEmail":"admin@bd.test","adminPassword":"bdpass1234"}' > "$TMP/i.json"
jpost "$API/api/install" "$TMP/i.json" >/dev/null
printf '{"email":"admin@bd.test","password":"bdpass1234"}' > "$TMP/la.json"
curl -s -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/la.json" >/dev/null
printf '{"email":"member@bd.test","password":"memberpass1","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"일반회원"}' > "$TMP/reg.json"
jpost "$API/api/register" "$TMP/reg.json" >/dev/null
printf '{"email":"member@bd.test","password":"memberpass1"}' > "$TMP/lm.json"
curl -s -c "$MEMBER" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/lm.json" >/dev/null
contains "게시판 플러그인 활성화" "$(curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-board/activate")" '"ok":true'

echo "── 관리자 화면 (선언적 리소스)"
NAV="$(curl -s -b "$ADMIN" "$API/api/admin/nav")"
contains "게시판 리소스 등록" "$NAV" '"name":"boards"'
contains "게시글 관리 리소스 등록" "$NAV" '"name":"posts"'

echo "── 게시판 생성 · 설정 검증"
printf '{"slug":"free","title":"자유게시판","description":"환영합니다","read_role":"guest","write_role":"guest","comment_role":"guest","download_role":"guest","categories":"공지, 질문, 자유","page_size":20,"max_files":2,"write_interval":0}' > "$TMP/b1.json"
contains "공개 게시판 생성" "$(curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b1.json")" '"id"'
printf '{"slug":"members","title":"회원게시판","read_role":"member","write_role":"member","download_role":"member"}' > "$TMP/b2.json"
contains "회원 전용 게시판 생성" "$(curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b2.json")" '"id"'
printf '{"slug":"free","title":"중복"}' > "$TMP/bdup.json"
check "slug 중복 차단" "$(code -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/bdup.json")" "409"
printf '{"slug":"bad","title":"x","read_role":"superuser"}' > "$TMP/brole.json"
check "알 수 없는 권한 거부" "$(code -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/brole.json")" "400"
check "비관리자 게시판 생성 차단" "$(code -b "$MEMBER" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b1.json")" "403"

echo "── 권한: 목록 노출 · 열람 차단"
PUBLIC_LIST="$(curl -s "$BD/boards")"
contains "공개 게시판은 비로그인에 노출" "$PUBLIC_LIST" '"free"'
absent   "회원 전용은 비로그인에 감춤" "$PUBLIC_LIST" '"members"'
contains "회원에게는 회원 전용도 노출" "$(curl -s -b "$MEMBER" "$BD/boards")" '"members"'
check "비로그인 회원게시판 열람 401" "$(code "$BD/boards/members/posts")" "401"
check "회원은 열람 가능" "$(code -b "$MEMBER" "$BD/boards/members/posts")" "200"

echo "── 비회원 글쓰기"
printf '{"title":"비회원 글","content":"내용입니다","category":"질문","guestName":"손님","guestPassword":"1234"}' > "$TMP/p1.json"
P1="$(jpost "$BD/boards/free/posts" "$TMP/p1.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$P1" ]] && ok "비회원 글 작성" || bad "비회원 글 작성"
printf '{"title":"x","content":"y"}' > "$TMP/pn.json"
check "이름·비밀번호 없으면 거부" "$(code -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/pn.json")" "400"
printf '{"title":"x","content":"y","category":"없는분류","guestName":"손님","guestPassword":"1234"}' > "$TMP/pc.json"
check "없는 분류 거부" "$(code -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/pc.json")" "400"

echo "── 답변형 (계층 정렬)"
printf '{"title":"첫 답변","content":"답변","replyTo":"%s"}' "$P1" > "$TMP/r1.json"
R1="$(curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/r1.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
printf '{"title":"둘째 답변","content":"답변","replyTo":"%s"}' "$P1" > "$TMP/r2.json"
curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/r2.json" >/dev/null
printf '{"title":"답변의 답변","content":"재답변","replyTo":"%s"}' "$R1" > "$TMP/r3.json"
curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/r3.json" >/dev/null
ORDER="$(curl -s "$BD/boards/free/posts" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('|'.join(f\"{p['depth']}:{p['title']}\" for p in d['items']))")"
check "계층 순서가 그누보드식으로 정렬" "$ORDER" "0:비회원 글|1:첫 답변|2:답변의 답변|1:둘째 답변"

echo "── 비회원 글 수정·삭제 권한"
printf '{"title":"탈취","content":"내용"}' > "$TMP/e1.json"
check "비밀번호 없이 수정 401" "$(code -X PUT "$BD/posts/$P1" -H 'content-type: application/json' --data-binary "@$TMP/e1.json")" "401"
printf '{"title":"탈취","content":"내용","guestPassword":"9999"}' > "$TMP/e2.json"
check "틀린 비밀번호 403" "$(code -X PUT "$BD/posts/$P1" -H 'content-type: application/json' --data-binary "@$TMP/e2.json")" "403"
printf '{"title":"비회원이 수정","content":"수정됨","guestPassword":"1234"}' > "$TMP/e3.json"
contains "맞는 비밀번호로 수정" "$(curl -s -X PUT "$BD/posts/$P1" -H 'content-type: application/json' --data-binary "@$TMP/e3.json")" '"ok":true'
printf '{"title":"관리자 수정","content":"내용"}' > "$TMP/e4.json"
contains "관리자는 비밀번호 없이 수정" "$(curl -s -b "$ADMIN" -X PUT "$BD/posts/$P1" -H 'content-type: application/json' --data-binary "@$TMP/e4.json")" '"ok":true'

echo "── 비밀글"
printf '{"title":"비밀글입니다","content":"비밀 내용","isSecret":true}' > "$TMP/sec.json"
PSEC="$(curl -s -b "$MEMBER" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/sec.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$PSEC" ]] && ok "비밀글 작성" || bad "비밀글 작성"
check "타인은 비밀글 열람 403" "$(code "$BD/posts/$PSEC")" "403"
check "작성자는 열람 가능" "$(code -b "$MEMBER" "$BD/posts/$PSEC")" "200"
check "관리자는 열람 가능" "$(code -b "$ADMIN" "$BD/posts/$PSEC")" "200"

echo "── 첨부파일"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMP/a.png"
cp "$TMP/a.png" "$TMP/b.png"; cp "$TMP/a.png" "$TMP/evil.php"
printf '{"title":"첨부 테스트","content":"내용"}' > "$TMP/pf.json"
PF="$(curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/pf.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
contains "파일 2개 업로드" "$(curl -s -b "$ADMIN" -X POST "$BD/posts/$PF/files" -F "file=@$TMP/a.png" -F "file=@$TMP/b.png")" '"saved":2'
check "개수 제한(2) 초과 차단" "$(code -b "$ADMIN" -X POST "$BD/posts/$PF/files" -F "file=@$TMP/a.png")" "400"
# 실행 가능 형식은 하나라도 섞이면 전체를 거부하고 고아 파일을 남기지 않아야 한다
printf '{"title":"혼합 업로드","content":"내용"}' > "$TMP/pm.json"
PM="$(curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/pm.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
check ".php 섞인 업로드 거부" "$(code -b "$ADMIN" -X POST "$BD/posts/$PM/files" -F "file=@$TMP/a.png" -F "file=@$TMP/evil.php")" "400"
contains "거부 시 고아 파일 없음(첨부 0)" "$(curl -s -b "$ADMIN" "$BD/posts/$PM")" '"file_count":0'

echo "── 다운로드 권한"
FID="$(curl -s "$BD/posts/$PF" | python3 -c "import sys,json;print(json.load(sys.stdin)['attachments'][0]['id'])")"
contains "다운로드 URL 발급" "$(curl -s "$BD/files/$FID")" '"url"'
contains "다운로드 카운트 증가" "$(curl -s "$BD/posts/$PF")" '"download_count":1'
absent   "응답에 비밀번호 해시 없음" "$(curl -s "$BD/posts/$P1")" "guest_password"

echo "── 추천 / 비추천"
printf '{"value":1}' > "$TMP/v1.json"
contains "추천" "$(curl -s -b "$MEMBER" -X POST "$BD/posts/$PF/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")" '"up":1'
contains "같은 값 재클릭은 취소" "$(curl -s -b "$MEMBER" -X POST "$BD/posts/$PF/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")" '"up":0'
printf '{"value":-1}' > "$TMP/v2.json"
contains "비추천으로 변경" "$(curl -s -b "$MEMBER" -X POST "$BD/posts/$PF/vote" -H 'content-type: application/json' --data-binary "@$TMP/v2.json")" '"down":1'
check "비로그인 추천 401" "$(code -X POST "$BD/posts/$PF/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")" "401"

echo "── 댓글"
printf '{"content":"댓글입니다","guestName":"손님","guestPassword":"1234"}' > "$TMP/c1.json"
C1="$(jpost "$BD/posts/$PF/comments" "$TMP/c1.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$C1" ]] && ok "비회원 댓글" || bad "비회원 댓글"
printf '{"content":"대댓글","parentId":"%s"}' "$C1" > "$TMP/c2.json"
contains "대댓글" "$(curl -s -b "$MEMBER" -X POST "$BD/posts/$PF/comments" -H 'content-type: application/json' --data-binary "@$TMP/c2.json")" '"id"'
contains "댓글 수 집계 반영" "$(curl -s "$BD/posts/$PF")" '"comment_count":2'
printf '{"content":"비밀댓글","isSecret":true}' > "$TMP/c3.json"
curl -s -b "$MEMBER" -X POST "$BD/posts/$PF/comments" -H 'content-type: application/json' --data-binary "@$TMP/c3.json" >/dev/null
contains "비밀댓글은 타인에게 가려짐" "$(curl -s "$BD/posts/$PF")" "비밀 댓글입니다."

echo "── 검색"
contains "제목 검색" "$(curl -s -G "$BD/boards/free/posts" --data-urlencode "q=첨부" --data-urlencode "in=title")" "첨부 테스트"
contains "작성자 검색" "$(curl -s -G "$BD/boards/free/posts" --data-urlencode "q=손님" --data-urlencode "in=author")" '"total"'
contains "검색 결과 없음도 정상 응답" "$(curl -s -G "$BD/boards/free/posts" --data-urlencode "q=존재하지않는단어xyz")" '"total":0'

echo "── 도배 방지"
printf '{"slug":"slow","title":"제한게시판","write_role":"member","write_interval":300}' > "$TMP/bs.json"
curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/bs.json" >/dev/null
printf '{"title":"첫 글","content":"내용"}' > "$TMP/s1.json"
contains "첫 글은 성공" "$(curl -s -b "$MEMBER" -X POST "$BD/boards/slow/posts" -H 'content-type: application/json' --data-binary "@$TMP/s1.json")" '"id"'
check "연속 작성 차단(429)" "$(code -b "$MEMBER" -X POST "$BD/boards/slow/posts" -H 'content-type: application/json' --data-binary "@$TMP/s1.json")" "429"
contains "관리자는 제한 없음" "$(curl -s -b "$ADMIN" -X POST "$BD/boards/slow/posts" -H 'content-type: application/json' --data-binary "@$TMP/s1.json")" '"id"'

echo "── RSS"
RSS="$(curl -s "$BD/boards/free/rss")"
contains "RSS 생성" "$RSS" "<rss version=\"2.0\">"
contains "RSS content-type" "$(curl -sI "$BD/boards/free/rss")" "application/rss+xml"
absent   "RSS에 비밀글 제외" "$RSS" "비밀글입니다"
check "비공개 게시판 RSS 차단" "$(code "$BD/boards/members/rss")" "403"

echo "── 블록 (서버 렌더 · XSS)"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "게시판 블록" "$BLOCKS" "brick-board/board"
contains "게시판 목록 블록" "$BLOCKS" "brick-board/board-list"
printf '{"name":"brick-board/board","props":{"board":"free"}}' > "$TMP/blk.json"
RENDER="$(jpost "$API/api/blocks/render" "$TMP/blk.json")"
contains "목록 서버 렌더" "$RENDER" "자유게시판"
contains "분류 내비게이션" "$RENDER" "brick-cat-nav"
contains "답변 들여쓰기 표시" "$RENDER" "brick-reply-mark"
printf '{"title":"<script>alert(1)</script>","content":"본문","guestName":"손님","guestPassword":"1234"}' > "$TMP/xss.json"
jpost "$BD/boards/free/posts" "$TMP/xss.json" >/dev/null
RENDER2="$(jpost "$API/api/blocks/render" "$TMP/blk.json")"
contains "제목 XSS 이스케이프" "$RENDER2" "&lt;script&gt;"
absent   "raw script 태그 없음" "$RENDER2" "<script>alert(1)</script>"

echo "── 저장형 XSS 방어 (새니타이저)"
# 본문은 HTML로 렌더되므로 저장 시점에 걸러야 한다
# 속성값에 홑따옴표를 써서 JSON 이스케이프를 피한다 (겹따옴표는 printf와 JSON 양쪽에서 깨진다)
printf '{"title":"XSS 시도","content":"<p>정상</p><script>alert(1)</script><img src=x onerror=alert(1)><a href=%sjavascript:alert(1)%s>링크</a><iframe src=//evil></iframe>"}' "'" "'" > "$TMP/xss2.json"
PX="$(curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/xss2.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
STORED="$(curl -s -b "$ADMIN" "$BD/posts/$PX")"
absent "script 태그 제거" "$STORED" "<script"
absent "onerror 속성 제거" "$STORED" "onerror"
absent "javascript: 링크 제거" "$STORED" "javascript:"
absent "iframe 제거" "$STORED" "<iframe"
contains "정상 서식은 유지" "$STORED" "<p>정상</p>"
# 수정 경로에도 새니타이저가 걸려야 한다 (우회 통로 방지)
printf '{"title":"수정 XSS","content":"<p>본문</p><script>alert(2)</script>"}' > "$TMP/xss3.json"
curl -s -b "$ADMIN" -X PUT "$BD/posts/$PX" -H 'content-type: application/json' --data-binary "@$TMP/xss3.json" >/dev/null
absent "수정 경로도 새니타이즈" "$(curl -s -b "$ADMIN" "$BD/posts/$PX")" "<script"
# 댓글은 서식을 아예 허용하지 않는다
printf '{"content":"<b>굵게</b>와 <script>alert(3)</script>"}' > "$TMP/cx.json"
curl -s -b "$ADMIN" -X POST "$BD/posts/$PX/comments" -H 'content-type: application/json' --data-binary "@$TMP/cx.json" >/dev/null
CMTS="$(curl -s -b "$ADMIN" "$BD/posts/$PX")"
absent "댓글에서 태그 제거" "$CMTS" "<b>굵게</b>"

echo "── 화면 렌더 (목록 · 상세 · 글쓰기)"
# 페이지 하나가 pathTail로 세 화면을 처리한다
printf '{"slug":"board/free","title":"자유게시판","status":"published","blocks":[{"block":"brick-board/board","props":{"board":"free"}}]}' > "$TMP/page.json"
curl -s -b "$ADMIN" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/page.json" >/dev/null
LIST="$(render_html "board%2Ffree")"
contains "목록 화면 렌더" "$LIST" "brick-board-table"
contains "목록에 검색 폼" "$LIST" "brick-board-search"
contains "목록에 분류 내비" "$LIST" "brick-cat-nav"
DETAIL="$(render_html "board%2Ffree%2F$P1")"
contains "상세 화면 렌더 (하위 경로 매칭)" "$DETAIL" "brick-post-content"
contains "상세에 댓글 영역" "$DETAIL" "brick-comments"
contains "상세에 추천 버튼" "$DETAIL" "data-vote"
WRITE="$(render_html "board%2Ffree%2Fwrite")"
contains "글쓰기 화면 렌더" "$WRITE" "brick-write-form"
contains "위지윅 에디터 툴바" "$WRITE" "brick-toolbar"
contains "에디터 본문 영역" "$WRITE" 'contenteditable="true"'
contains "비회원 이름·비밀번호 입력" "$WRITE" "guestPassword"
contains "첨부파일 입력" "$WRITE" 'type="file"'
# 상세 화면에서도 새니타이즈된 본문만 나가야 한다
DETAILX="$(render_html "board%2Ffree%2F$PX")"
absent "렌더된 상세에 script 없음" "$DETAILX" "alert(2)"

echo "── 비밀글은 서버 렌더에 본문을 담지 않는다 (캐시 유출 방지)"
SECRET_RENDER="$(render_html "board%2Ffree%2F$PSEC")"
contains "비밀글 안내 표시" "$SECRET_RENDER" "비밀글입니다"
absent   "비밀글 본문 미포함" "$SECRET_RENDER" "비밀 내용"

echo "── 렌더 캐시 정책"
# 비로그인 요청만 캐시된다 (로그인 사용자 렌더가 캐시되면 유출된다)
CACHED="$(node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(\"SELECT key FROM cache_entries WHERE key LIKE 'render:page:%:board%'\");
  console.log(rows.map(r => r.key).join(','));
  await c.end();
})();
")"
contains "비로그인 렌더는 캐시됨" "$CACHED" ":board/free"
# 로그인 요청 후에도 캐시 항목이 늘지 않아야 한다
curl -s -b "$ADMIN" "$API/api/render/page?path=board%2Ffree" >/dev/null
CACHED2="$(node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(\"SELECT count(*) n FROM cache_entries WHERE key LIKE 'render:page:%:board%'\");
  console.log(rows[0].n);
  await c.end();
})();
")"
CACHED1_COUNT="$(echo "$CACHED" | tr ',' '\n' | grep -c . || echo 0)"
check "로그인 요청은 캐시하지 않음" "$CACHED2" "$CACHED1_COUNT"
# 쿼리가 다르면 별도 캐시 (검색 결과가 섞이면 안 된다)
curl -s "$API/api/render/page?path=board%2Ffree&q=%EC%B2%A8%EB%B6%80" >/dev/null
QCACHE="$(node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(\"SELECT key FROM cache_entries WHERE key LIKE 'render:page:%:board/free?%'\");
  console.log(rows.length ? 'has-query-key' : 'none');
  await c.end();
})();
")"
check "쿼리별로 캐시 분리" "$QCACHE" "has-query-key"

echo "── 목록 스킨 · 썸네일 · 이전/다음 · 일괄 작업 · 이미지 삽입 · 알림 설정 (M25)"
# JSON 한 필드 꺼내기 (jq 없이)
jf() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || echo ""; }
render_html() { curl -s "$API/api/render/page?path=$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))"; }

printf '{"slug":"gal","title":"갤러리","list_style":"gallery","notify_email":"alerts@st.test","notify_comment":true,"read_role":"guest","write_role":"guest","comment_role":"guest","allow_upload":true,"write_interval":0}' > "$TMP/gal.json"
GAL_ID="$(curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/gal.json" | jf "['id']")"
[[ -n "$GAL_ID" ]] && ok "갤러리 게시판 생성" || bad "갤러리 게시판 생성 실패"
GALS="$(curl -s -b "$ADMIN" "$BD/admin/boards")"
contains "목록 스킨이 저장된다" "$GALS" '"list_style":"gallery"'
contains "알림 주소가 저장된다" "$GALS" '"notify_email":"alerts@st.test"'
check "잘못된 알림 주소는 400" "$(code -b "$ADMIN" -X PUT "$BD/admin/boards/$GAL_ID" -H 'content-type: application/json' \
  -d '{"slug":"gal","title":"갤러리","notify_email":"not-an-email"}')" "400"
check "모르는 스킨은 기본으로" "$(curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' \
  -d '{"slug":"gal2","title":"갤러리2","list_style":"fancy"}' >/dev/null; curl -s -b "$ADMIN" "$BD/admin/boards" \
  | python3 -c "import sys,json;print(next(b['list_style'] for b in json.load(sys.stdin)['items'] if b['slug']=='gal2'))")" "basic"

# 이 수트는 라우터 페이지 없이 게시판별 페이지만 만든다 — /board/gal 이 뜨려면 라우터가 필요하다
printf '{"slug":"board","title":"게시판","status":"published","blocks":[{"block":"brick-board/board","props":{}}]}' > "$TMP/router.json"
curl -s -b "$ADMIN" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/router.json" -o /dev/null

# 본문 첫 이미지가 썸네일이 된다 (첨부가 없을 때).
# JSON 은 인용 heredoc 으로 쓴다 — bash 의 printf 는 \" 를 " 로 바꿔 JSON 을 깨뜨린다(zsh 는 안 그래서 놓치기 쉽다)
cat > "$TMP/gp1.json" <<'JSON'
{"title":"사진 하나","content":"<p>봄</p><img src=\"https://example.test/a.jpg\" alt=\"\">","guestName":"손님","guestPassword":"pass1234"}
JSON
GP1_RAW="$(curl -s -X POST "$BD/boards/gal/posts" -H 'content-type: application/json' --data-binary "@$TMP/gp1.json")"
GP1="$(echo "$GP1_RAW" | jf "['id']")"
cat > "$TMP/gp2.json" <<'JSON'
{"title":"사진 둘","content":"<p>글만</p>","guestName":"손님","guestPassword":"pass1234"}
JSON
GP2="$(curl -s -X POST "$BD/boards/gal/posts" -H 'content-type: application/json' --data-binary "@$TMP/gp2.json" | jf "['id']")"
cat > "$TMP/gp3.json" <<'JSON'
{"title":"사진 셋","content":"<p>x</p><img src=\"javascript:alert(1)\">","guestName":"손님","guestPassword":"pass1234"}
JSON
GP3="$(curl -s -X POST "$BD/boards/gal/posts" -H 'content-type: application/json' --data-binary "@$TMP/gp3.json" | jf "['id']")"
[[ -n "$GP1" && -n "$GP2" && -n "$GP3" ]] && ok "갤러리 글 3개 작성" || bad "갤러리 글 작성 실패 ($GP1/$GP2/$GP3) 첫 응답: ${GP1_RAW:0:200}"

GAL_HTML="$(render_html "board/gal")"
contains "갤러리 스킨으로 렌더" "$GAL_HTML" 'class="brick-board brick-list-gallery"'
contains "썸네일이 본문 첫 이미지" "$GAL_HTML" 'src="https://example.test/a.jpg"'
contains "이미지 없는 글은 자리표시" "$GAL_HTML" 'brick-thumb-empty'
absent "javascript: 는 썸네일이 되지 않는다" "$GAL_HTML" 'src="javascript:'
absent "갤러리에는 표가 없다" "$GAL_HTML" '<table class="brick-board-table"'

echo "── 블록 속성이 게시판 스킨을 덮는다 (홈엔 웹진, 목록엔 표)"
printf '{"slug":"galweb","title":"웹진시험","status":"published","blocks":[{"block":"brick-board/board","props":{"board":"gal","listStyle":"webzine"}}]}' > "$TMP/galweb.json"
curl -s -b "$ADMIN" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/galweb.json" -o /dev/null
WEB_HTML="$(render_html "galweb")"
contains "웹진 스킨" "$WEB_HTML" 'brick-list-webzine'
contains "웹진은 발췌를 보여준다" "$WEB_HTML" 'brick-webzine-excerpt'
contains "고정 게시판 위젯은 페이지 제목을 가져가지 않는다" "$WEB_HTML" '<title>웹진시험 —'
contains "위젯의 게시판 이름은 h2 (페이지 h1 은 따로 있다)" "$WEB_HTML" '<h2><a href="/board/gal">갤러리</a></h2>'
absent "위젯에는 검색폼이 없다" "$WEB_HTML" 'class="brick-board-search"'

echo "── 이전글 · 다음글"
D2="$(render_html "board/gal/$GP2")"
contains "다음글(더 새 글)은 사진 셋" "$D2" 'is-next" href="/board/gal/'"$GP3"'"'
contains "이전글(더 오래된 글)은 사진 하나" "$D2" 'is-prev" href="/board/gal/'"$GP1"'"'
D3="$(render_html "board/gal/$GP3")"
contains "가장 새 글에는 다음글이 없다" "$D3" 'is-next is-empty'
contains "공유 막대" "$D3" 'data-share-bar'
contains "인쇄 버튼" "$D3" 'data-print'
contains "댓글 앵커(메일 링크가 가리킨다)" "$D3" 'id="comments"'

echo "── 이미지 삽입은 회원만"
printf 'PNGDATA' > "$TMP/x.png"
check "비회원 이미지 업로드는 401" "$(code -X POST "$BD/boards/gal/images" -F "files=@$TMP/x.png;type=image/png")" "401"
IMG_R="$(curl -s -b "$ADMIN" -X POST "$BD/boards/gal/images" -F "files=@$TMP/x.png;type=image/png")"
contains "회원(관리자)은 URL 을 받는다" "$IMG_R" '"url"'
check "이미지가 아닌 파일은 400" "$(printf 'x' > "$TMP/x.txt"; code -b "$ADMIN" -X POST "$BD/boards/gal/images" -F "files=@$TMP/x.txt;type=text/plain")" "400"

echo "── 글쓰기 화면: 회원에게만 이미지 버튼 · 임시저장 키"
W_GUEST="$(render_html "board/gal/write")"
absent "비회원 글쓰기에는 이미지 버튼이 없다" "$W_GUEST" '<button type="button" data-image'
contains "임시저장 키가 있다" "$W_GUEST" 'data-draft-key="brick-draft:gal:new"'
contains "복원 안내 자리" "$W_GUEST" 'data-draft-note'

echo "── 관리 일괄 작업"
OPTS="$(curl -s -b "$ADMIN" "$BD/admin/boards/options")"
contains "이동 대상 선택지에 게시판 이름" "$OPTS" '"label":"갤러리"'
FREE_ID="$(echo "$OPTS" | python3 -c "import sys,json;print(next(o['value'] for o in json.load(sys.stdin) if o['label']=='자유게시판'))" 2>/dev/null || echo "")"
[[ -n "$FREE_ID" ]] || FREE_ID="$(echo "$OPTS" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['value'])")"
check "비관리자 일괄 작업 차단" "$(code -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"delete","ids":["'"$GP2"'"]}')" "403"
NB="$(curl -s -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"notice-on","ids":["'"$GP1"'","'"$GP2"'"]}')"
contains "공지 지정 2건" "$NB" '"affected":2'
contains "공지가 갤러리 목록에 배지로" "$(render_html "board/gal")" 'brick-list-badge'
CP="$(curl -s -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"copy","ids":["'"$GP3"'"],"params":{"board":"'"$FREE_ID"'"}}')"
contains "복사 1건" "$CP" '"affected":1'
check "원본은 남아 있다" "$(code "$API/api/render/page?path=board/gal/$GP3")" "200"
MV="$(curl -s -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"move","ids":["'"$GP2"'"],"params":{"board":"'"$FREE_ID"'"}}')"
contains "이동 1건" "$MV" '"affected":1'
absent "옮긴 글은 원래 게시판에 없다" "$(render_html "board/gal")" "사진 둘"
check "대상 없는 이동은 400" "$(code -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"move","ids":["'"$GP1"'"],"params":{}}')" "400"
check "모르는 작업은 400" "$(code -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"explode","ids":["'"$GP1"'"]}')" "400"
DL="$(curl -s -b "$ADMIN" -X POST "$BD/admin/posts/bulk" -H 'content-type: application/json' -d '{"action":"delete","ids":["'"$GP1"'","'"$GP3"'"]}')"
contains "선택 삭제 2건" "$DL" '"affected":2'
check "지운 글은 404" "$(code "$BD/posts/$GP1")" "404"
contains "게시글 리소스가 일괄 작업을 선언한다" "$(curl -s -b "$ADMIN" "$API/api/admin/resources/brick-board/posts")" '"bulkActions"'

echo "── 게시판 그룹 · 그룹 권한 · 링크 필드 (M25)"
GRP="$(curl -s -b "$ADMIN" -X POST "$BD/admin/groups" -H 'content-type: application/json' -d '{"slug":"staff","title":"운영진 공간","read_role":"member","sort_order":1}')"
GID="$(echo "$GRP" | jf "['id']")"
[[ -n "$GID" ]] && ok "그룹 생성" || bad "그룹 생성 실패 ($GRP)"
check "그룹 slug 중복은 409" "$(code -b "$ADMIN" -X POST "$BD/admin/groups" -H 'content-type: application/json' -d '{"slug":"staff","title":"x"}')" "409"
check "비관리자 그룹 생성 차단" "$(code -X POST "$BD/admin/groups" -H 'content-type: application/json' -d '{"slug":"g2","title":"x"}')" "403"
contains "그룹 선택지" "$(curl -s -b "$ADMIN" "$BD/admin/groups/options")" '"label":"운영진 공간"'
# 공개(guest) 게시판 gal 을 회원 그룹에 넣으면 비회원은 못 읽는다 — 그룹 권한이 더 엄격
curl -s -b "$ADMIN" -X PUT "$BD/admin/boards/$GAL_ID" -H 'content-type: application/json' \
  -d '{"slug":"gal","title":"갤러리","list_style":"gallery","read_role":"guest","write_role":"guest","comment_role":"guest","allow_upload":true,"write_interval":0,"group_id":"'"$GID"'"}' -o /dev/null
check "그룹 권한(회원)이 게시판 권한(누구나)보다 세다 — 비회원 401" "$(code "$BD/boards/gal/posts")" "401"
check "회원은 읽는다" "$(code -b "$ADMIN" "$BD/boards/gal/posts")" "200"
absent "비회원 공개 목록에서 감춰진다" "$(curl -s "$BD/boards")" '"slug":"gal"'
contains "회원 목록에는 그룹 이름과 함께" "$(curl -s -b "$ADMIN" "$BD/boards")" '"group_title":"운영진 공간"'
IDX_GUEST="$(render_html "board")"
absent "/board 목록에서도 비회원에게 감춘다" "$IDX_GUEST" 'href="/board/gal"'
contains "그룹이 있으면 소제목으로 묶인다(회원 화면은 로그인 렌더라 API 로 본다)" "$(curl -s -b "$ADMIN" "$BD/boards")" '"group_slug":"staff"'
absent "사이트맵은 그룹 권한도 본다" "$(curl -s "$API/sitemap.xml" 2>/dev/null || curl -s "$API/api/sitemap.xml")" "/board/gal/"
check "그룹 삭제" "$(code -b "$ADMIN" -X DELETE "$BD/admin/groups/$GID")" "200"
check "그룹을 지워도 게시판은 남고 다시 공개된다" "$(code "$BD/boards/gal/posts")" "200"

cat > "$TMP/lk.json" <<'JSON'
{"title":"링크 있는 글","content":"<p>참고</p>","links":["https://example.test/ref","javascript:alert(1)"],"guestName":"손님","guestPassword":"pass1234"}
JSON
check "javascript: 링크는 거부(400)" "$(code -X POST "$BD/boards/gal/posts" -H 'content-type: application/json' --data-binary "@$TMP/lk.json")" "400"
cat > "$TMP/lk2.json" <<'JSON'
{"title":"링크 있는 글","content":"<p>참고</p>","links":["https://example.test/ref","https://example.test/two","https://example.test/three"],"guestName":"손님","guestPassword":"pass1234"}
JSON
LK="$(curl -s -X POST "$BD/boards/gal/posts" -H 'content-type: application/json' --data-binary "@$TMP/lk2.json" | jf "['id']")"
[[ -n "$LK" ]] && ok "링크 2개 글 작성" || bad "링크 글 작성 실패"
LKH="$(render_html "board/gal/$LK")"
contains "상세에 링크 목록" "$LKH" 'class="brick-post-links"'
contains "링크는 새 창 + nofollow" "$LKH" 'href="https://example.test/ref" target="_blank" rel="nofollow noopener"'
absent "세 번째 링크는 잘린다(최대 2개)" "$LKH" "example.test/three"
contains "수정 화면에 기존 링크가 채워진다" "$(render_html "board/gal/$LK/edit")" 'name="link1" placeholder="https://" value="https://example.test/ref"'

echo "── 삭제 (첨부 정리)"
check "비관리자 관리 목록 차단" "$(code -b "$MEMBER" "$BD/admin/posts")" "403"
contains "관리자 글 목록" "$(curl -s -b "$ADMIN" "$BD/admin/posts")" '"total"'
contains "글 삭제" "$(curl -s -b "$ADMIN" -X DELETE "$BD/posts/$PF")" '"ok":true'
check "삭제된 글은 404" "$(code "$BD/posts/$PF")" "404"

echo
echo "── 이미지 첨부도 줄여서 저장한다 (첨부는 본문 아래에 그대로 보인다)"
node -e '
const sharp = require("'"$ROOT"'/apps/api/node_modules/sharp");
const w=3000,h=2000, buf=Buffer.alloc(w*h*3);
for (let y=0;y<h;y++) for (let x=0;x<w;x++){const i=(y*w+x)*3;buf[i]=(x*255/w)|0;buf[i+1]=90;buf[i+2]=(y*255/h)|0;}
sharp(buf,{raw:{width:w,height:h,channels:3}}).withExif({IFD0:{Make:"Brick"}}).jpeg({quality:95}).toFile(process.argv[1]);
' "$TMP/attach.jpg" 2>/dev/null || echo "(sharp 없음 — 건너뜁니다)"
if [[ -f "$TMP/attach.jpg" ]]; then
  ORIG_BYTES=$(wc -c < "$TMP/attach.jpg")
  # 글은 JSON 으로 만들고 첨부는 별도 멀티파트 호출이다 (POST /posts/:id/files)
  printf '{"title":"사진 첨부","content":"첨부 시험"}' > "$TMP/ap.json"
  AP="$(curl -s -b "$ADMIN" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' \
    --data-binary "@$TMP/ap.json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"
  [[ -n "$AP" ]] && ok "이미지 첨부용 글 작성" || bad "이미지 첨부용 글 작성"
  contains "이미지 첨부 업로드" "$(curl -s -b "$ADMIN" -X POST "$BD/posts/$AP/files" -F "files=@$TMP/attach.jpg;type=image/jpeg")" '"saved":1'
  SAVED="$(node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query('SELECT size FROM board_attachments WHERE post_id = \$1::uuid LIMIT 1', ['$AP']);
  console.log(rows[0] ? rows[0].size : '');
  await c.end();
})();
")"
  [[ -n "$SAVED" && "$SAVED" -lt "$ORIG_BYTES" ]] && ok "첨부 이미지가 줄어든다 ($ORIG_BYTES → $SAVED)" || bad "첨부 이미지가 줄어든다 ($ORIG_BYTES → ${SAVED:-없음})"
fi

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
