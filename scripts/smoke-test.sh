#!/usr/bin/env bash
#
# Brick E2E 스모크 테스트.
# 실제 PostgreSQL과 실제 서버 프로세스를 띄워 핵심 흐름을 검증한다.
#
# 사용법:  DATABASE_URL=postgresql://... bash scripts/smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib-smoke.sh
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check() { # check <설명> <실제> <기대>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (기대: $3, 실제: $2)"; fi
}
contains() { # contains <설명> <문자열> <부분문자열>
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (\"$3\" 없음: ${2:0:120})"; fi
}
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

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

echo "▶ Brick 스모크 테스트"

# 매번 빈 DB에서 시작한다 — 스모크 테스트는 "설치 전" 상태를 전제로 한다.
# (로컬 반복 실행 시 이전 데이터가 남아 실패하는 것을 막는다)
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi


# ── 서버 기동 ──────────────────────────────────────────
export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-test-secret-value}"
# 이 스위트는 캡차를 시험하지 않는다. 켜두면 회원가입·비회원 글쓰기가 막힌다.
# 캡차 자체는 smoke-security.sh 가 검증한다.
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!

for i in $(seq 1 60); do
  if curl -fsS "$API/readyz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "서버가 기동 중 종료되었습니다:"; cat "$TMP/api.log"; exit 1
  fi
  sleep 1
done
# 우리가 띄운 서버와 이야기하는지 확인한다 (scripts/lib-smoke.sh 의 설명 참고)
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"
curl -fsS "$API/readyz" >/dev/null || { echo "서버 기동 실패:"; cat "$TMP/api.log"; exit 1; }

echo "── 헬스체크"
contains "healthz" "$(curl -s "$API/healthz")" '"status":"ok"'
contains "readyz"  "$(curl -s "$API/readyz")"  '"database":"ok"'
contains "보안 헤더" "$(curl -sI "$API/healthz")" "nosniff"

echo "── 설치"
INSTALL_STATE="$(curl -s "$API/api/install/status")"
if [[ "$INSTALL_STATE" == *"not_installed"* ]]; then
  contains "설치 실행" \
    "$(curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
        -d '{"siteName":"Smoke","adminEmail":"admin@smoke.test","adminPassword":"smokepass123"}')" \
    '"ok":true'
else
  ok "설치 실행 (이미 설치됨 — 건너뜀)"
fi
contains "설치 상태" "$(curl -s "$API/api/install/status")" "installed"

echo "── 인증"
check "미인증 관리자 작업 차단" "$(code -X POST "$API/api/plugins/brick-board/activate")" "401"
check "잘못된 비밀번호 차단" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"admin@smoke.test","password":"wrong-password"}')" "401"
# 손님이 가장 자주 보는 오류 화면이다. 로그인 화면은 서버가 준 message 를 그대로
# 보여주므로(한국어 대체 문구는 message 가 아예 없을 때만 쓰인다) 여기에 영어를
# 적으면 한국어 사이트에 "invalid credentials" 가 뜬다 — 실제로 그렇게 떴다.
WRONGPW="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@smoke.test","password":"wrong-password"}')"
absent "거절 문구가 영어가 아니다" "$WRONGPW" "invalid credentials"
contains "무엇이 틀렸는지 한국어로 말한다" "$WRONGPW" "올바르지 않습니다"

# 없는 계정과 틀린 비밀번호가 다른 말을 하면 그 차이로 가입 여부가 샌다
contains "없는 계정도 같은 문구" \
  "$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"nobody-here@smoke.test","password":"wrong-password"}')" "올바르지 않습니다"
# 관리 저장이 401 로 막히면 "Unauthorized" 가 아니라 무엇을 해야 하는지 말한다
contains "세션이 풀렸을 때도 한국어로" \
  "$(curl -s -X POST "$API/api/pages" -H 'content-type: application/json' -d '{}')" "다시 로그인"
contains "로그인" \
  "$(curl -s -c "$COOKIES" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"admin@smoke.test","password":"smokepass123"}')" '"role":"admin"'
contains "세션 확인(me)" "$(curl -s -b "$COOKIES" "$API/api/auth/me")" "admin@smoke.test"

echo "── 회원"
contains "회원가입" \
  "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"member@smoke.test","password":"memberpass1","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"스모크"}')" '"id"'
check "중복 이메일 차단" \
  "$(code -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"member@smoke.test","password":"memberpass1","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"스모크"}')" "409"
check "약한 비밀번호 차단" \
  "$(code -X POST "$API/api/register" -H 'content-type: application/json' \
      -d '{"email":"weak@smoke.test","password":"123","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"약함"}')" "400"

echo "── 플러그인"
contains "플러그인 활성화" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/plugins/brick-board/activate")" '"ok":true'
contains "코어 블록 등록" "$(curl -s "$API/api/blocks")" "core/heading"
contains "플러그인 블록 등록" "$(curl -s "$API/api/blocks")" "brick-board/latest-posts"

echo "── 게시판 (플러그인 연동 최소 확인 — 상세는 smoke-board.sh)"
# 게시판 생성은 관리자 API를 쓴다 (그누보드의 게시판 관리에 대응)
printf '{"slug":"smoke","title":"스모크 게시판","write_role":"member","comment_role":"member"}' > "$TMP/board.json"
contains "게시판 생성" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/plugins/brick-board/admin/boards" \
      -H 'content-type: application/json' --data-binary "@$TMP/board.json")" '"id"'
printf '{"title":"익명","content":"본문"}' > "$TMP/anon.json"
check "미로그인 글쓰기 차단" \
  "$(code -X POST "$API/api/plugins/brick-board/boards/smoke/posts" \
      -H 'content-type: application/json' --data-binary "@$TMP/anon.json")" "401"

# 제목에 스크립트 태그를 넣어 블록 렌더의 이스케이프를 검증한다
printf '{"title":"스모크 <script>alert(1)</script>","content":"본문"}' > "$TMP/post.json"
POST_ID="$(curl -s -b "$COOKIES" -X POST "$API/api/plugins/brick-board/boards/smoke/posts" \
  -H 'content-type: application/json' --data-binary "@$TMP/post.json" \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[[ -n "$POST_ID" ]] && ok "글 작성" || bad "글 작성"
printf '{"content":"댓글"}' > "$TMP/cmt.json"
contains "댓글 작성" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/plugins/brick-board/posts/$POST_ID/comments" \
      -H 'content-type: application/json' --data-binary "@$TMP/cmt.json")" '"id"'
contains "글 읽기(조회수)" "$(curl -s "$API/api/plugins/brick-board/posts/$POST_ID")" '"view_count":1'
printf '{"name":"brick-board/latest-posts","props":{"board":"smoke","limit":3}}' > "$TMP/blk.json"
BLOCK_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  --data-binary "@$TMP/blk.json")"
contains "블록 XSS 이스케이프" "$BLOCK_HTML" "&lt;script&gt;"
if [[ "$BLOCK_HTML" != *"<script>alert(1)</script>"* ]]; then ok "raw script 태그 미포함"; else bad "raw script 태그 미포함"; fi

echo "── 페이지 · 렌더"
PAGE_ID="$(curl -s -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' -d '{
  "slug":"smoke-page","title":"스모크 페이지","status":"published",
  "seo":{"description":"스모크 설명"},
  "blocks":[{"block":"core/heading","props":{"text":"제목입니다","level":1}},
            {"block":"core/paragraph","props":{"text":"본문입니다"}}]
}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[[ -n "$PAGE_ID" ]] && ok "페이지 생성" || bad "페이지 생성"
check "slug 중복 차단" \
  "$(code -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"smoke-page","title":"중복"}')" "409"
RENDER="$(curl -s "$API/api/render/page?path=smoke-page")"
contains "페이지 렌더" "$RENDER" "제목입니다"
contains "SEO 메타 출력" "$RENDER" "스모크 설명"
contains "테마가 문서 소유(<!doctype>)" "$RENDER" "doctype html"
contains "404 상태" "$(curl -s "$API/api/render/page?path=no-such-page-xyz")" '"status":404'

echo "── 캐시 무효화"
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$PAGE_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-page","title":"수정된 제목","status":"published",
  "blocks":[{"block":"core/heading","props":{"text":"수정된 본문","level":1}}]
}' >/dev/null
AFTER="$(curl -s "$API/api/render/page?path=smoke-page")"
contains "수정 내용 반영" "$AFTER" "수정된 본문"
if [[ "$AFTER" != *"제목입니다"* ]]; then ok "이전 캐시 제거"; else bad "이전 캐시 제거"; fi

echo "── 이전 버전 (덮어쓴 뒤에 되돌릴 수 있는가)"
#
# 블록 열 개를 지우고 저장한 뒤에야 잘못을 알아채도, 예전에는 기억을 더듬어
# 다시 만드는 수밖에 없었다. 저장할 때마다 그때 내용을 한 판 남긴다.
REVS="$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID/revisions")"
check "만든 것도 한 판이다 (없으면 원래 모습을 잃는다)" \
  "$(echo "$REVS" | jq_get "['items'][-1]['revNo']")" "1"
check "수정하면 판이 늘어난다" "$(echo "$REVS" | jq_get "['items'][0]['revNo']")" "2"
contains "1판에는 처음 제목이 남아 있다" "$REVS" "스모크 페이지"
contains "2판은 수정한 제목" "$REVS" "수정된 제목"
contains "누가 저장했는지 남는다" "$REVS" '"authorName"'
check "블록 수로 무엇이 얼마나 바뀌었는지 짐작한다" \
  "$(echo "$REVS" | jq_get "['items'][-1]['blockCount']")" "2"
# 목록에 서른 판의 블록 JSON 을 모두 실어 보내면 큰 페이지에서 몇 MB 가 된다
absent "목록에는 내용을 싣지 않는다" "$REVS" '"blocks"'

echo "── 같은 내용을 다시 저장해도 판을 만들지 않는다"
# 저장을 두 번 눌렀다고 판이 두 개 생기면 목록이 금세 의미를 잃는다
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$PAGE_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-page","title":"수정된 제목","status":"published",
  "blocks":[{"block":"core/heading","props":{"text":"수정된 본문","level":1}}]
}' >/dev/null
check "판 수는 그대로" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID/revisions" | jq_get "['items'][0]['revNo']")" "2"

echo "── 되돌리기"
contains "옛 판의 내용을 볼 수 있다" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID/revisions/1")" "제목입니다"
check "없는 판은 404" "$(code -b "$COOKIES" "$API/api/pages/$PAGE_ID/revisions/99")" "404"
check "없는 페이지의 판도 404" "$(code -b "$COOKIES" "$API/api/pages/00000000-0000-0000-0000-000000000000/revisions")" "404"
check "비로그인은 판을 볼 수 없다" "$(code "$API/api/pages/$PAGE_ID/revisions")" "401"
RESTORE="$(curl -s -b "$COOKIES" -X POST "$API/api/pages/$PAGE_ID/revisions/1/restore")"
contains "1판으로 되돌린다" "$RESTORE" '"restoredFrom":1'
AFTER_R="$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID")"
contains "제목이 돌아온다" "$AFTER_R" "스모크 페이지"
contains "본문도 돌아온다" "$AFTER_R" "제목입니다"
contains "손님 화면에도 반영된다 (캐시를 비운다)" \
  "$(curl -s "$API/api/render/page?path=smoke-page")" "제목입니다"
# 되돌리기도 하나의 저장이다 — 되돌리기를 되돌릴 수 있어야 한다
REVS2="$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID/revisions")"
check "되돌린 것도 판으로 남는다" "$(echo "$REVS2" | jq_get "['items'][0]['revNo']")" "3"
contains "무엇을 했는지 적혀 있다" "$REVS2" "1판으로 되돌림"
check "지금 내용을 되돌리기 전으로 다시 되돌릴 수 있다" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/pages/$PAGE_ID/revisions/2/restore" | jq_get "['restoredFrom']")" "2"
contains "다시 수정본이 된다" "$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID")" "수정된 제목"
contains "되돌린 기록이 감사 로그에 남는다" \
  "$(curl -s -b "$COOKIES" "$API/api/audit?action=page.revision.restore")" "되돌림"

echo "── 되돌려도 주소와 공개 상태는 건드리지 않는다"
# 주소를 되돌리면 그 사이에 걸어 둔 링크·메뉴가 끊기고, 다른 페이지가 그 주소를
# 가져갔으면 저장 자체가 실패한다. 공개 상태는 내용이 아니다.
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$PAGE_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-page-moved","title":"주소 바뀐 제목","status":"draft",
  "blocks":[{"block":"core/heading","props":{"text":"옮긴 뒤 본문","level":1}}]
}' >/dev/null
curl -s -b "$COOKIES" -X POST "$API/api/pages/$PAGE_ID/revisions/1/restore" >/dev/null
MOVED="$(curl -s -b "$COOKIES" "$API/api/pages/$PAGE_ID")"
check "주소는 지금 것 그대로" "$(echo "$MOVED" | jq_get "['slug']")" "smoke-page-moved"
check "공개 상태도 그대로" "$(echo "$MOVED" | jq_get "['status']")" "draft"
contains "내용만 돌아온다" "$MOVED" "제목입니다"
# 뒤 절(예약 발행)이 쓰는 상태로 되돌려 둔다
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$PAGE_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-page","title":"수정된 제목","status":"published",
  "blocks":[{"block":"core/heading","props":{"text":"수정된 본문","level":1}}]
}' >/dev/null

echo "── 예약 발행 (때가 되면 저절로 열린다)"
#
# `published_at` 은 지금까지 "발행한 순간" 을 적는 칸일 뿐이었다. 그래서 공지·이벤트
# 페이지를 정해진 시각에 여는 방법이 없었고, 운영자가 그 시각에 깨어 있어야 했다.
#
# 예약된 페이지는 **published 가 아니므로** 손님·검색·사이트맵 어디에도 나오지
# 않는다 — 공개 여부를 보는 곳이 전부 그 한 값을 본다.
SCHED_ID="$(curl -s -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' -d '{
  "slug":"smoke-soon","title":"곧 열릴 페이지","status":"scheduled","publishedAt":"2099-01-01T00:00:00.000Z",
  "blocks":[{"block":"core/paragraph","props":{"text":"예약된 본문입니다"}}]
}' | jq_get "['id']")"
[[ -n "$SCHED_ID" ]] && ok "예약 페이지 생성" || bad "예약 페이지 생성"
check "예약 상태로 저장된다" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$SCHED_ID" | jq_get "['status']")" "scheduled"
check "때가 되기 전에는 손님에게 없는 페이지다" \
  "$(curl -s "$API/api/render/page?path=smoke-soon" | jq_get "['status']")" "404"
absent "검색에도 걸리지 않는다" "$(curl -s "$API/api/search?q=예약된+본문")" "곧 열릴 페이지"
# /sitemap.xml 은 조각 목록이다 — 실제 주소는 조각(/sitemap-1.xml) 안에 있다
absent "사이트맵에도 없다" "$(curl -s "$API/sitemap-1.xml")" "smoke-soon"
contains "목록은 언제 열리는지 알려준다" \
  "$(curl -s -b "$COOKIES" "$API/api/pages")" '"slug":"smoke-soon"'
contains "링크 고르는 자리에서도 임시저장과 구분된다" \
  "$(curl -s -b "$COOKIES" "$API/api/admin/link-targets?q=smoke-soon")" "예약 발행"

echo "── 공개 전에 확인할 수 있다 (자정 공개를 자정에 처음 보면 오타도 손님이 먼저 본다)"
PV="$(curl -s -b "$COOKIES" "$API/api/admin/pages/$SCHED_ID/preview")"
contains "예약된 페이지를 관리자가 미리 본다" "$PV" "예약된 본문입니다"
contains "완성된 화면 그대로 (테마가 감싼다)" "$PV" "doctype html"
check "미리보기는 HTML 로 준다" \
  "$(curl -s -o /dev/null -w '%{content_type}' -b "$COOKIES" "$API/api/admin/pages/$SCHED_ID/preview")" "text/html; charset=utf-8"
check "검색엔진에 올리지 않는다" \
  "$(curl -s -o /dev/null -w '%header{x-robots-tag}' -b "$COOKIES" "$API/api/admin/pages/$SCHED_ID/preview")" "noindex"
check "캐시하지 않는다 (미공개 화면이 캐시에 남으면 안 된다)" \
  "$(curl -s -o /dev/null -w '%header{cache-control}' -b "$COOKIES" "$API/api/admin/pages/$SCHED_ID/preview")" "no-store"
check "비로그인은 미리볼 수 없다" "$(code "$API/api/admin/pages/$SCHED_ID/preview")" "401"
# 미리보기가 공개 경로를 열어 주면 안 된다 — 손님에게는 여전히 없는 페이지다
check "미리본 뒤에도 손님에게는 없다" \
  "$(curl -s "$API/api/render/page?path=smoke-soon" | jq_get "['status']")" "404"

echo "── 잘못된 예약은 저장되지 않는다 (조용히 안 열리는 것이 가장 나쁘다)"
check "시각 없는 예약은 거절" \
  "$(code -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"smoke-nodate","title":"시각없음","status":"scheduled"}')" "400"
# 연도를 잘못 적은 예약이 조용히 즉시 공개되면, 예약을 쓰는 이유가 사라진다
check "이미 지난 시각은 거절" \
  "$(code -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"smoke-past","title":"지난시각","status":"scheduled","publishedAt":"2020-01-01T00:00:00.000Z"}')" "400"
contains "왜 안 되는지 말해 준다" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"smoke-past","title":"지난시각","status":"scheduled","publishedAt":"2020-01-01T00:00:00.000Z"}')" "이미 지났습니다"
# 상태에 오타가 나면 저장은 성공하는데 페이지는 어디에도 안 나왔다
check "모르는 상태는 거절" \
  "$(code -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"smoke-typo","title":"오타","status":"publishd"}')" "400"

echo "── 때가 되면 열린다"
# 시각을 당겨 놓고 **주기 확인과 같은 코드**를 부른다 (30초를 기다리지 않는다)
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$SCHED_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-soon","title":"곧 열릴 페이지","status":"scheduled","publishedAt":"2099-01-01T00:00:00.000Z",
  "blocks":[{"block":"core/paragraph","props":{"text":"예약된 본문입니다"}}]
}' >/dev/null
cat > "$TMP/due.cjs" <<'JS'
const { Client } = require(process.env.PG_PATH);
(async () => {
  const c = new Client(process.env.DATABASE_URL);
  await c.connect();
  // 시각을 당겨 "때가 지난 예약" 을 만든다 (30초 주기를 기다리지 않으려고)
  await c.query("UPDATE pages SET published_at = now() - make_interval(mins => 1) WHERE slug = $1", ["smoke-soon"]);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
JS
PG_PATH="$ROOT/apps/api/node_modules/pg" node "$TMP/due.cjs"
check "한 건이 열렸다" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/admin/pages/publish-due" | jq_get "['published']")" "1"
OPENED="$(curl -s "$API/api/render/page?path=smoke-soon")"
check "이제 손님이 볼 수 있다" "$(echo "$OPENED" | jq_get "['status']")" "200"
contains "본문이 나온다" "$OPENED" "예약된 본문입니다"
check "상태도 공개로 바뀐다" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$SCHED_ID" | jq_get "['status']")" "published"
contains "사이트맵에도 들어온다" "$(curl -s "$API/sitemap-1.xml")" "smoke-soon"
contains "누가 열었는지 기록이 남는다 (사람이 아니라 시각이 열었다)" \
  "$(curl -s -b "$COOKIES" "$API/api/audit?action=page.publish.scheduled")" "곧 열릴 페이지"
check "때가 안 된 것이 없으면 아무것도 열지 않는다" \
  "$(curl -s -b "$COOKIES" -X POST "$API/api/admin/pages/publish-due" | jq_get "['published']")" "0"

echo "── 서버가 여럿이어도 한 번만 열린다 (docs/operations.md 의 스케일링)"
#
# 예약 확인은 **모든 인스턴스**에서 30초마다 돈다. 두 서버가 같은 예약을 동시에
# 집으면 감사 로그가 두 줄 남고, 알림을 붙이는 날에는 손님이 같은 안내를 두 번
# 받는다. 상태를 조건에 넣은 UPDATE 하나로 처리하므로 뒤에 온 쪽은 0건을 본다.
curl -s -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' -d '{
  "slug":"smoke-race","title":"동시에 열릴 페이지","status":"scheduled","publishedAt":"2099-01-01T00:00:00.000Z",
  "blocks":[]}' >/dev/null
cat > "$TMP/due2.cjs" <<'JS'
const { Client } = require(process.env.PG_PATH);
(async () => {
  const c = new Client(process.env.DATABASE_URL);
  await c.connect();
  await c.query("UPDATE pages SET published_at = now() - make_interval(mins => 1) WHERE slug = $1", ["smoke-race"]);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
JS
PG_PATH="$ROOT/apps/api/node_modules/pg" node "$TMP/due2.cjs"
# 동시에 두 번 부른다 — 두 인스턴스가 같은 순간에 확인하는 것과 같다
R1="$(curl -s -b "$COOKIES" -X POST "$API/api/admin/pages/publish-due" &       curl -s -b "$COOKIES" -X POST "$API/api/admin/pages/publish-due" & wait)"
check "둘이 합쳐 한 번만 연다" "$(grep -o '"published":[0-9]*' <<< "$R1" | awk -F: '{s+=$2} END {print s}')" "1"
check "감사 기록도 한 줄뿐이다" \
  "$(curl -s -b "$COOKIES" "$API/api/audit?action=page.publish.scheduled" \
      | python3 -c "import sys,json;print(sum(1 for i in json.load(sys.stdin)['items'] if '동시에' in (i.get('summary') or '')))")" "1"

echo "── 공개 시각은 한 번 정해지면 밀리지 않는다"
# 다시 저장할 때마다 오늘로 밀리면 그 값은 아무 뜻도 없어진다
WAS="$(curl -s -b "$COOKIES" "$API/api/pages/$SCHED_ID" | jq_get "['publishedAt']")"
# 값이 실제로 있어야 "그대로" 라는 비교에 뜻이 생긴다 (둘 다 비어 있으면 늘 통과한다)
[[ -n "$WAS" && "$WAS" != "None" ]] && ok "열린 페이지에는 공개 시각이 있다" \
  || bad "열린 페이지에 공개 시각이 없다 ($WAS)"
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$SCHED_ID" -H 'content-type: application/json' -d '{
  "slug":"smoke-soon","title":"곧 열릴 페이지 (수정)","status":"published",
  "blocks":[{"block":"core/paragraph","props":{"text":"예약된 본문입니다"}}]
}' >/dev/null
check "수정해도 공개 시각은 그대로" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$SCHED_ID" | jq_get "['publishedAt']")" "$WAS"
# 임시저장으로 만든 뒤 공개한 페이지는 공개 시각이 영원히 비어 있었다
DRAFT_ID="$(curl -s -b "$COOKIES" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"smoke-later","title":"나중에 공개","status":"draft"}' | jq_get "['id']")"
check "임시저장은 공개 시각이 없다" \
  "$(curl -s -b "$COOKIES" "$API/api/pages/$DRAFT_ID" | jq_get "['publishedAt']")" "None"
curl -s -b "$COOKIES" -X PUT "$API/api/pages/$DRAFT_ID" -H 'content-type: application/json' \
  -d '{"slug":"smoke-later","title":"나중에 공개","status":"published"}' >/dev/null
LATER="$(curl -s -b "$COOKIES" "$API/api/pages/$DRAFT_ID" | jq_get "['publishedAt']")"
[[ -n "$LATER" && "$LATER" != "None" ]] && ok "공개로 바꾸면 그때가 적힌다" \
  || bad "공개로 바꿔도 공개 시각이 비어 있다 ($LATER)"

echo "── 아직 없는 설정은 조용히 지나가지 않는다"
#
# 운영 문서의 스케일링 표가 `STORAGE_DRIVER=s3` 와 `REDIS_URL` 을 안내했는데 둘 다
# 읽는 곳이 없었다 — 설정해도 아무 일도 일어나지 않는다. 그런데 운영자는 **그것을
# 설정했기 때문에** 인스턴스를 늘린다. 업로드가 공유되지 않는다는 사실은 절반의
# 요청이 이미지 404 를 받은 뒤에 알게 된다.
CFGOUT="$TMP/cfg.log"
# `set -e` 가 의도된 실패에서 수트를 끊지 않게 종료코드를 직접 받는다
STORAGE_DRIVER=s3 node "$ROOT/apps/api/dist/main.js" > "$CFGOUT" 2>&1 && CFGRC=0 || CFGRC=$?
# 종료코드만 보면 포트 충돌 같은 다른 실패도 1 이라 통과해 버린다 — 뜨지 **않았다**는 것까지 본다
check "없는 저장소 드라이버면 뜨지 않는다" \
  "$CFGRC|$(grep -c 'Bootstrap' "$CFGOUT" || true)" "1|0"
contains "무엇이 없는지 말한다" "$(cat "$CFGOUT")" "아직 구현되지 않았습니다"
contains "대신 무엇을 할지도 말한다" "$(cat "$CFGOUT")" "공유 볼륨"
# 캐시는 막지 않는다 — PostgreSQL 캐시는 이미 인스턴스 사이에서 공유된다
REDIS_URL=redis://localhost:6379 node "$ROOT/apps/api/dist/main.js" > "$TMP/redis.log" 2>&1 &
REDIS_PID=$!
for i in $(seq 1 30); do grep -q "REDIS_URL" "$TMP/redis.log" 2>/dev/null && break; sleep 0.3; done
kill "$REDIS_PID" 2>/dev/null || true; wait "$REDIS_PID" 2>/dev/null || true
contains "REDIS_URL 은 막지 않고 알려만 준다" "$(cat "$TMP/redis.log")" "아직 Redis 구현이 없습니다"
contains "동작은 정상이라고 말한다" "$(cat "$TMP/redis.log")" "동작은 정상"

echo "── 미디어"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMP/t.png"
cp "$TMP/t.png" "$TMP/evil.php"
contains "이미지 업로드" "$(curl -s -b "$COOKIES" -X POST "$API/api/media/upload" -F "file=@$TMP/t.png")" '"url"'
check ".php 업로드 차단" "$(code -b "$COOKIES" -X POST "$API/api/media/upload" -F "file=@$TMP/evil.php")" "400"
check "path traversal 차단" "$(code "$API/uploads/../../etc/passwd")" "404"

echo "── 메뉴 · 설정 · 검색"
contains "메뉴 저장" \
  "$(curl -s -b "$COOKIES" -X PUT "$API/api/menus/header" -H 'content-type: application/json' \
      -d '{"items":[{"label":"소개","url":"/smoke-page"}]}')" '"ok":true'
check "javascript: 스킴 차단" \
  "$(code -b "$COOKIES" -X PUT "$API/api/menus/header" -H 'content-type: application/json' \
      -d '{"items":[{"label":"X","url":"javascript:alert(1)"}]}')" "400"
contains "메뉴가 사이트에 렌더" "$(curl -s "$API/api/render/page?path=smoke-page")" "brick-nav"
check "화이트리스트 외 설정 거부" \
  "$(code -b "$COOKIES" -X PUT "$API/api/settings" -H 'content-type: application/json' \
      -d '{"install.state":"not_installed"}')" "400"
contains "검색" "$(curl -s -G "$API/api/search" --data-urlencode "q=수정된")" "수정된"

echo "── 테마"
contains "테마 목록" "$(curl -s "$API/api/themes")" '"active"'
contains "테마 CSS 서빙" "$(curl -sI "$API/themes/default/assets/style.css")" "text/css"

echo
echo "── 업로드 이미지 최적화 (큰 사진을 그대로 저장하지 않는다)"
# 휴대폰 사진 크기의 JPEG 를 만든다 (EXIF 포함) — sharp 는 API 에 들어 있으므로 그것으로 만든다
node -e '
const sharp = require("'"$ROOT"'/apps/api/node_modules/sharp");
const w=3600,h=2400, buf=Buffer.alloc(w*h*3);
for (let y=0;y<h;y++) for (let x=0;x<w;x++){const i=(y*w+x)*3;buf[i]=(x*255/w)|0;buf[i+1]=(y*255/h)|0;buf[i+2]=120;}
sharp(buf,{raw:{width:w,height:h,channels:3}}).withExif({IFD0:{Make:"Brick"},GPS:{GPSLatitudeRef:"N"}}).jpeg({quality:95}).toFile(process.argv[1]);
' "$TMP/photo.jpg" 2>/dev/null || echo "(sharp 없음 — 이 절은 건너뜁니다)"
if [[ -f "$TMP/photo.jpg" ]]; then
  UP_JSON="$(curl -s -b "$COOKIES" -X POST "$API/api/media/upload" -F "file=@$TMP/photo.jpg;type=image/jpeg")"
  W="$(echo "$UP_JSON" | jq_get "['width']")"
  ORIG="$(echo "$UP_JSON" | jq_get "['originalSize']")"
  NEW="$(echo "$UP_JSON" | jq_get "['size']")"
  check "3600px 원본이 2400px 로 줄어든다" "$W" "2400"
  [[ -n "$ORIG" && -n "$NEW" && "$NEW" -lt "$ORIG" ]] && ok "저장 용량이 줄어든다 ($ORIG → $NEW)" || bad "저장 용량이 줄어든다 ($ORIG → $NEW)"
  contains "목록용 썸네일이 생긴다" "$UP_JSON" '"thumbUrl":"/uploads/'
  THUMB="$(echo "$UP_JSON" | jq_get "['thumbUrl']")"
  check "썸네일이 서빙된다" "$(code "$API$THUMB")" "200"
  contains "썸네일은 WebP" "$(curl -s -o /dev/null -w '%header{content-type}' "$API$THUMB")" "image/webp"
  MEDIA_URL="$(echo "$UP_JSON" | jq_get "['url']")"
  # EXIF(촬영 위치)가 남으면 글쓴이의 집 주소가 공개된다
  curl -s "$API$MEDIA_URL" -o "$TMP/saved.jpg"
  EXIF="$(node -e 'require("'"$ROOT"'/apps/api/node_modules/sharp")(process.argv[1]).metadata().then(m=>console.log(m.exif?"있음":"없음"))' "$TMP/saved.jpg" 2>/dev/null)"
  check "EXIF(GPS 등)를 지운다" "$EXIF" "없음"
  contains "목록 응답에 치수와 썸네일" "$(curl -s -b "$COOKIES" "$API/api/media")" '"thumbUrl":'

  # ── 압축 폭탄 ────────────────────────────────────────────
  #
  # 파일 **용량**만 막으면 부족하다. 단색 PNG 는 압축이 잘 되어 0.74MB 로
  # 16000×16000(256메가픽셀)이 된다 — 업로드 상한 8MB 를 가볍게 통과한다.
  # 예전에는 그 한 장을 처리하는 데 778ms 와 150MB 가 들었다(실측). 몇 장이면
  # 작은 서버는 넘어가고, 설치형 CMS 의 주 무대가 바로 그런 서버다.
  # 지금은 sharp 가 픽셀 상한(5천만)에서 거부하고, 원본을 그대로 저장한다
  # — 처리하지 못한 이미지를 버리지 않는다는 기존 약속 그대로다.
  node -e '
  const sharp = require("'"$ROOT"'/apps/api/node_modules/sharp");
  sharp({ create: { width: 16000, height: 16000, channels: 3, background: "#ffffff" } })
    .png({ compressionLevel: 9 }).toFile(process.argv[1]);
  ' "$TMP/bomb.png" 2>/dev/null
  if [[ -f "$TMP/bomb.png" ]]; then
    BOMB_JSON="$(curl -s -b "$COOKIES" -X POST "$API/api/media/upload" -F "file=@$TMP/bomb.png;type=image/png")"
    contains "압축 폭탄도 접수는 된다 (버리지 않는다)" "$BOMB_JSON" '"url"'
    # 시간으로 재지 않는다 — 기계 속도에 흔들려서, 상한을 풀어도 통과해 버린다.
    # 서버가 **무엇 때문에** 거부했는지가 결정적인 신호다.
    contains "픽셀 상한에서 디코딩을 거부한다" "$(cat "$TMP/api.log")" "exceeds pixel limit"
    # 가공하지 못했으므로 치수를 모른다 — 줄였다고 거짓말하지 않는다
    check "줄이지 못한 것을 줄였다고 하지 않는다" "$(echo "$BOMB_JSON" | jq_get "['width']")" "None"
  fi
  # 키가 UUID 라 덮어쓰이지 않는다 — 1년 immutable, 조건부 요청은 304
  check "업로드 파일은 1년 immutable" "$(curl -s -o /dev/null -w '%header{cache-control}' "$API$MEDIA_URL")" "public, max-age=31536000, immutable"
  ET="$(curl -s -o /dev/null -w '%header{etag}' "$API$MEDIA_URL")"
  [[ -n "$ET" ]] && ok "ETag 를 낸다 ($ET)" || bad "ETag 를 낸다"
  check "If-None-Match 가 맞으면 304" "$(code -H "if-none-match: $ET" "$API$MEDIA_URL")" "304"
  check "테마 자산도 조건부 요청 304" "$(code -H "if-none-match: $(curl -s -o /dev/null -w '%header{etag}' "$API/themes/default/assets/style.css")" "$API/themes/default/assets/style.css")" "304"
fi

echo "── 썸네일 백필 도구 (업그레이드한 사이트의 옛 파일)"
# 업로드는 됐지만 썸네일이 없는 상태(이 기능 이전에 운영한 사이트)를 만들어 도구가 채우는지 본다
if [[ -f "$TMP/photo.jpg" ]]; then
  node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('UPDATE media_files SET thumb_key = NULL, width = NULL, height = NULL');
  await c.end();
})();
"
  BF="$(BRICK_UPLOADS_DIR="$TMP/uploads" node "$ROOT/apps/api/dist/backfill-thumbs.js" 2>&1)"
  # 스모크가 올린 이미지 수는 절에 따라 달라진다 — 0건이 아니라는 것만 본다
  absent "백필이 빠진 썸네일을 만든다" "$BF" "0건 생성"
  contains "백필이 대상을 찾는다" "$BF" "건 생성"
  BF2="$(BRICK_UPLOADS_DIR="$TMP/uploads" node "$ROOT/apps/api/dist/backfill-thumbs.js" 2>&1)"
  contains "다시 돌려도 새로 만들지 않는다 (멱등)" "$BF2" "0건 생성"
  contains "백필 뒤 목록에 썸네일" "$(curl -s -b "$COOKIES" "$API/api/media")" '"thumbUrl":"/uploads/'
fi


echo "── 공개 품질: 공유 이미지 · 캐시 · 압축"
check "공유 이미지는 http(s) 또는 / 로 시작해야 한다" \
  "$(code -b "$COOKIES" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.og_image":"javascript:alert(1)"}')" "400"
check "공유 이미지 저장" \
  "$(code -b "$COOKIES" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.og_image":"/uploads/share.png"}')" "200"
if [[ -f "$TMP/photo.jpg" ]]; then
  OGU="$(curl -s -b "$COOKIES" -X POST "$API/api/settings/og-image" -F "file=@$TMP/photo.jpg;type=image/jpeg")"
  check "올린 사진을 1200×630 으로 자른다" "$(echo "$OGU" | jq_get "['width']")x$(echo "$OGU" | jq_get "['height']")" "1200x630"
  OG_URL="$(echo "$OGU" | jq_get "['url']")"
  contains "JPEG 로 site/og-… 에 저장" "$OG_URL" "/uploads/site/og-"
  contains "설정에 즉시 반영" "$(curl -s -b "$COOKIES" "$API/api/settings")" "\"site.og_image\":\"$OG_URL\""
  contains "저장 파일은 image/jpeg" "$(curl -s -o /dev/null -w '%header{content-type}' "$API$OG_URL")" "image/jpeg"
  OGU2="$(curl -s -b "$COOKIES" -X POST "$API/api/settings/og-image" -F "file=@$TMP/photo.jpg;type=image/jpeg")"
  check "다시 올리면 이전 파일은 지운다" "$(code "$API$OG_URL")" "404"
  check "og 업로드는 이미지만" "$(printf 'x' > "$TMP/x.txt"; code -b "$COOKIES" -X POST "$API/api/settings/og-image" -F "file=@$TMP/x.txt;type=text/plain")" "400"
fi
OG_HTML="$(curl -s "$API/api/render/page?path=&og=1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))' 2>/dev/null)"
contains "테마가 og:image 를 절대 URL 로 낸다" "$OG_HTML" 'property="og:image" content="http'
contains "트위터 카드도 함께" "$OG_HTML" 'name="twitter:card"'
check "스탬프 붙은 테마 자산은 1년 immutable" "$(curl -s -o /dev/null -w '%header{cache-control}' "$API/themes/default/assets/style.css?v=1")" "public, max-age=31536000, immutable"

# ── 개인화된 응답이 공유 캐시에 담기지 않는다 ────────────
#
# 지금까지 API 응답에는 cache-control 이 아예 없었다. 그런 200 응답은 중간 캐시가
# 자기 판단으로 담는다(heuristic caching). 설치 안내는 앞에 Nginx·Caddy 를 두라고
# 하고 그 앞에 CDN 을 얹는 사이트가 많다 — 그러면 한 손님의 프로필·주문 목록이
# 다른 손님에게 그대로 나간다.
check "내 정보는 공유 캐시에 담기지 않는다" \
  "$(curl -s -o /dev/null -w '%header{cache-control}' -b "$COOKIES" "$API/api/auth/me")" "private, no-store"
check "회원 프로필도" \
  "$(curl -s -o /dev/null -w '%header{cache-control}' -b "$COOKIES" "$API/api/me/profile")" "private, no-store"
# 자기 정책을 정한 응답은 건드리지 않는다 — 정책을 아는 쪽이 하나여야 한다
check "사이트맵은 자기 정책을 지킨다" \
  "$(curl -s -o /dev/null -w '%header{cache-control}' "$API/sitemap.xml")" "public, max-age=3600"
check "업로드 파일도 그대로 immutable" \
  "$(curl -s -o /dev/null -w '%header{cache-control}' "$API$MEDIA_URL")" "public, max-age=31536000, immutable"
check "스탬프 없는 자산은 1시간" "$(curl -s -o /dev/null -w '%header{cache-control}' "$API/themes/default/assets/style.css")" "public, max-age=3600"
check "텍스트 응답은 br 로 압축된다" "$(curl -s -o /dev/null -w '%header{content-encoding}' -H 'Accept-Encoding: br, gzip' "$API/themes/default/assets/style.css")" "br"

echo "── 중단된 작업을 되찾는가 (재시작 한 번에 메일 캠페인이 영구히 멈추면 안 된다)"
#
# 작업을 집으면 status 가 'running' 이 되는데 되돌리는 곳이 없었다. 프로세스가
# 그 사이에 죽으면 그 행은 영원히 'running' 이고, 폴링은 'pending' 만 보므로
# 아무도 다시 집지 않는다. 캠페인은 '발송중'에서 멈춘 채 한 통도 안 나가고
# 다시 시작하려 하면 "이미 발송 중입니다" 로 거절당한다 — 오류도 경고도 없이.
#
# 프로세스를 죽이는 대신 **죽은 워커가 남긴 것과 같은 행**을 직접 넣는다.
# (1) 살아 있는 워커의 작업부터 본다. **혼자** 두고, 차례도 가장 앞에 둔다 —
#     다른 행들과 같이 넣으면 폴링이 한 번에 하나만 집으므로 "아직 차례가 오지
#     않았을 뿐"인 것을 "보호했다"로 잘못 읽는다(실제로 처음에 그랬다: 임대를
#     0초로 망가뜨려도 이 단언이 통과했다).
ALIVE="$(node -e 'console.log(require("node:crypto").randomUUID())')"
psql_q "INSERT INTO queue_jobs (id, name, payload, status, attempts, max_attempts, run_at, locked_at)
        VALUES ('$ALIVE', 'mailing.send', '{\"campaignId\":\"00000000-0000-0000-0000-000000000000\"}',
                'running', 1, 3, now() - interval '1 hour', now())" >/dev/null
sleep 5   # 폴링 주기(1초)의 다섯 배 — 임대가 제 역할을 못 하면 이 사이에 빼앗긴다
check "살아 있는 워커의 작업은 빼앗지 않는다 (같은 메일이 두 번 나간다)" \
  "$(psql_q "SELECT status FROM queue_jobs WHERE id='$ALIVE'")" "running"

# (2) 죽은 워커가 남긴 것과 같은 행 — 임대가 만료된 running.
#     캠페인 id 는 없는 값이라 핸들러가 곧바로 돌아온다 — 검증 대상은 발송이
#     아니라 **되찾는가** 이다.
STUCK="$(node -e 'console.log(require("node:crypto").randomUUID())')"
psql_q "INSERT INTO queue_jobs (id, name, payload, status, attempts, max_attempts, run_at, locked_at)
        VALUES ('$STUCK', 'mailing.send', '{\"campaignId\":\"00000000-0000-0000-0000-000000000000\"}',
                'running', 1, 3, now() - interval '10 minutes', now() - interval '10 minutes')" >/dev/null
# (3) 되살릴 수 없는 작업 — 시도 횟수를 다 썼다. 되찾지 못한다고 running 에
#     두면 고치려던 문제로 되돌아간다.
DEAD="$(node -e 'console.log(require("node:crypto").randomUUID())')"
psql_q "INSERT INTO queue_jobs (id, name, payload, status, attempts, max_attempts, run_at, locked_at)
        VALUES ('$DEAD', 'mailing.send', '{}', 'running', 3, 3, now() - interval '10 minutes', now() - interval '10 minutes')" >/dev/null

for i in $(seq 1 40); do
  ST="$(psql_q "SELECT status FROM queue_jobs WHERE id='$STUCK'")"
  [[ "$ST" == "done" ]] && break
  sleep 1
done
check "임대가 끊긴 작업을 되찾아 끝냈다" "$ST" "done"
ATT="$(psql_q "SELECT attempts FROM queue_jobs WHERE id='$STUCK'")"
check "되찾을 때 시도 횟수를 센다 (작업이 워커를 죽이면 무한히 되살지 않는다)" "$ATT" "2"
for i in $(seq 1 40); do
  DS="$(psql_q "SELECT status FROM queue_jobs WHERE id='$DEAD'")"
  [[ "$DS" == "failed" ]] && break
  sleep 1
done
check "되살릴 수 없는 작업은 실패로 끝낸다 (running 에 갇히지 않는다)" "$DS" "failed"
contains "실패 이유를 남긴다 (운영자가 무슨 일이 났는지 볼 수 있어야 한다)" \
  "$(psql_q "SELECT last_error FROM queue_jobs WHERE id='$DEAD'")" "워커가 중단된"

# (4) 하트비트 — 살아서 **오래** 일하는 작업을 지키는가. 위의 핸들러는 즉시 끝나서
#     이것을 드러내지 못한다. 임대를 1초로 줄이고 4초짜리 작업을 두 워커에 건다.
#     하트비트가 없으면 이 작업은 네 번 실행된다 — 수만 명 발송이 네 번 나가는 것이다.
check "오래 걸리는 작업도 한 번만 실행된다 (하트비트가 임대를 지킨다)" \
  "$(node "$ROOT/scripts/queue-lease-probe.mjs" 300 1000)" "runs=1 status=done"
# (5) 대기 중인 것은 키당 하나 — 플러그인은 부팅할 때마다 주기 작업 사슬의 첫 작업을
#     다시 심는다. 이것이 없으면 재시작 횟수만큼 사슬이 겹친다(개발 DB 에 넷이 있었다).
#     실행 중인 작업이 자기 다음 차례를 예약하는 것은 막지 않아야 한다 — 막으면 사슬이 끊긴다.
check "대기 중인 주기 작업은 하나만 남고, 사슬은 이어진다" \
  "$(node "$ROOT/scripts/queue-lease-probe.mjs" dedupe)" "pending=1 chain=true"
# (6) 끝내 실패하면 주인에게 알린다 — 캠페인의 '발송중' 을 풀 수 있는 유일한 자리다
check "시도를 다 쓴 실패는 주인에게 한 번 알린다" \
  "$(node "$ROOT/scripts/queue-lease-probe.mjs" fail)" "onFailed=1 status=failed"

echo "── 요청 제한은 버킷마다 자기 시간 창을 지킨다"
# 15분 창 호출의 정리가 60분 창 버킷(비밀번호 재설정 제출 등)을 15분 만에 지워 한도가 풀렸다
check "60분 한도는 15분 창 요청이 정리를 불러도 60분 동안 막는다" \
  "$(node "$ROOT/scripts/rate-limit-probe.mjs")" "exhausted=true after21m=true"

echo "── 잠금은 잡은 연결에서 풀린다 (한 번에 하나만 돌아야 하는 일 — 정기결제 청구 등)"
# advisory lock 은 연결 단위다. 풀에 대고 잡고 풀면, 사이에 쿼리가 하나만 끼어도 해제가
# 다른 연결로 가서 잠금이 남는다 — 플러그인 마이그레이션 잠금이 실제로 그랬다.
check "잠금 중에 다른 쿼리가 끼어도 해제되고, 잡혀 있는 동안 두 번째는 못 들어온다" \
  "$(node "$ROOT/scripts/lock-probe.mjs")" "released=true second=blocked after=ok"

echo "── DB 순단을 견디는가 (PostgreSQL 재시작·풀 순단에 사이트가 내려가면 안 된다)"
# 작업 큐는 1초마다 DB 를 폴링한다. 그 질의가 던지는 오류를 흘리면 미처리 프로미스 거부가
# 되어 **Node 가 프로세스를 죽인다** — 실제로 그랬다. DB 는 살아 있는데 연결만 끊어 본다.
kill_conns() {
  node -e '
    const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
    (async () => {
      const c = new Client(process.env.DATABASE_URL); await c.connect();
      const r = await c.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
      );
      console.log(r.rowCount);
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  '
}
KILLED="$(kill_conns)"
[[ "${KILLED:-0}" -ge 1 ]] && ok "서버의 DB 연결을 끊었다 (${KILLED}개)" || bad "연결을 끊지 못했다 (${KILLED:-없음})"
# 큐 폴링이 그 사이에 최소 한 번 돈다 — 고치기 전에는 여기서 프로세스가 죽었다
sleep 3
kill -0 "$API_PID" 2>/dev/null && ok "서버 프로세스가 살아 있다" || bad "서버가 죽었다 (미처리 오류)"
kill -0 "$API_PID" 2>/dev/null || { echo "── 죽은 이유 ──"; grep -nE "Error|error:|at [A-Za-z]" "$TMP/api.log" | tail -20; }
# liveness 는 DB 를 건드리지 않으므로 프로세스만 살아 있으면 200 이다
check "liveness 가 응답한다" "$(code "$API/healthz")" "200"
# readiness 는 DB 를 본다 — 풀이 새 커넥션을 맺으면 곧 200 으로 돌아온다
for i in 1 2 3 4 5; do
  READY="$(code "$API/readyz")"
  [[ "$READY" == "200" ]] && break
  sleep 1
done
check "readiness 가 스스로 회복된다" "$READY" "200"
check "DB 를 읽는 요청도 된다" "$(code "$API/api/render/page?path=")" "200"

# ── 업로드 한도를 넘으면 한국어로, 숫자로 말한다 ─────────────
#
# 그 전에는 @fastify/multipart 의 원문이 그대로 나갔다:
#   {"statusCode":413,"message":"request file too large"}
# 관리 화면은 이 message 를 그대로 보여주므로 한국어 화면에 "실패: request file
# too large" 가 떴다. 무엇이 문제인지도, **한도가 얼마인지도** 알 수 없다.
# 휴대폰 사진 한 장이 12MB 인 시대에 상품 사진을 올리는 사람이 가장 자주 만나는
# 오류가 이것이다.
#
# 한도를 낮춰 띄운 두 번째 서버로 확인한다 — 50MB 짜리 파일을 만들지 않기 위해서다.
echo "── 업로드 한도 안내"
PORT_LIM=$((${BRICK_API_PORT:-3001} + 60))
LIM="http://127.0.0.1:${PORT_LIM}"
BRICK_API_PORT="$PORT_LIM" BRICK_MAX_UPLOAD_MB=1 node "$ROOT/apps/api/dist/main.js" > "$TMP/api-limit.log" 2>&1 &
LIM_PID=$!
for i in $(seq 1 60); do curl -fsS "$LIM/readyz" >/dev/null 2>&1 && break; sleep 1; done
# 포트가 이미 잡혀 있으면 새 서버는 죽고 **남의 서버가 대답한다** — 그러면 이 절은
# 한도가 다른 서버를 검사하게 된다(실제로 그렇게 통과할 뻔했다). 우리 것인지 못박는다.
kill -0 "$LIM_PID" 2>/dev/null && ok "한도 낮춘 서버가 우리 것이다 (:$PORT_LIM)" \
  || bad "한도 낮춘 서버가 뜨지 않았다 — 포트 $PORT_LIM 가 이미 쓰이는 중일 수 있다 ($(tail -2 "$TMP/api-limit.log"))"
curl -s -c "$TMP/limck" -X POST "$LIM/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@smoke.test","password":"smokepass123"}' >/dev/null
# 1MB 한도를 넘는 2MB 파일 (내용은 중요하지 않다 — 크기에서 먼저 걸린다)
head -c 2097152 /dev/zero > "$TMP/toobig.png"
TOOBIG="$(curl -s -b "$TMP/limck" -X POST "$LIM/api/media/upload" -F "file=@$TMP/toobig.png;type=image/png")"
contains "한도 초과를 한국어로 알린다" "$TOOBIG" "파일이 너무 큽니다"
contains "한도를 숫자로 알려준다 (설정한 값 그대로)" "$TOOBIG" "최대 1MB"
absent  "원문이 새어 나오지 않는다" "$TOOBIG" "request file too large"
# 다른 오류까지 삼키면 안 된다 — 전역 필터이므로 이것을 함께 본다
contains "다른 오류는 그대로 둔다" \
  "$(curl -s -b "$TMP/limck" -X POST "$LIM/api/media/upload" -F "file=@$TMP/evil.php")" \
  "허용되지 않는 파일 형식"
check "없는 경로는 404 그대로" "$(code "$LIM/api/no-such-route")" "404"
kill "$LIM_PID" 2>/dev/null || true; wait "$LIM_PID" 2>/dev/null || true

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
# 실측을 남긴다(설정됐을 때만) — README 의 표가 실제와 같은지 CI 가 대조한다.
# 표의 숫자는 조용히 썩는다: 단언을 더해도 아무도 그 줄을 고치지 않는다.
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
