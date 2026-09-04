#!/usr/bin/env bash
#
# Brick E2E 스모크 테스트.
# 실제 PostgreSQL과 실제 서버 프로세스를 띄워 핵심 흐름을 검증한다.
#
# 사용법:  DATABASE_URL=postgresql://... bash scripts/smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

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
fi

echo "── 공개 품질: 공유 이미지 · 캐시 · 압축"
check "공유 이미지는 http(s) 또는 / 로 시작해야 한다" \
  "$(code -b "$COOKIES" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.og_image":"javascript:alert(1)"}')" "400"
check "공유 이미지 저장" \
  "$(code -b "$COOKIES" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.og_image":"/uploads/share.png"}')" "200"
OG_HTML="$(curl -s "$API/api/render/page?path=&og=1" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))' 2>/dev/null)"
contains "테마가 og:image 를 절대 URL 로 낸다" "$OG_HTML" 'property="og:image" content="http'
contains "트위터 카드도 함께" "$OG_HTML" 'name="twitter:card"'
check "스탬프 붙은 테마 자산은 1년 immutable" "$(curl -s -o /dev/null -w '%header{cache-control}' "$API/themes/default/assets/style.css?v=1")" "public, max-age=31536000, immutable"
check "스탬프 없는 자산은 1시간" "$(curl -s -o /dev/null -w '%header{cache-control}' "$API/themes/default/assets/style.css")" "public, max-age=3600"
check "텍스트 응답은 br 로 압축된다" "$(curl -s -o /dev/null -w '%header{content-encoding}' -H 'Accept-Encoding: br, gzip' "$API/themes/default/assets/style.css")" "br"

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
