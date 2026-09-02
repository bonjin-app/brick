#!/usr/bin/env bash
#
# 테마·랜딩 E2E 스모크 — 기본 스킨 그대로도 사이트로 보이는가.
#
# 화면의 "예쁨"은 눈으로만 확인되지만, 예쁨을 **지탱하는 계약**은 자동으로
# 지킬 수 있다. 이 수트가 못박는 것:
#
#   - 테마 팔레트가 라이트·다크 두 벌로 나오는가 (dark- 토큰 → 미디어쿼리 +
#     data-theme 규칙). 이게 깨지면 다크 화면이 흰 글자에 흰 배경이 된다.
#   - 토큰 값으로 **CSS 를 주입할 수 없는가** (`;}` 로 선언을 닫고 임의 규칙)
#   - 에셋 캐시버스터가 **파일을 고치면 바뀌는가** (버전만 쓰면 손님이 옛
#     CSS 를 계속 본다 — 실제로 새 스타일이 화면에 안 나와 한참 헤맸다)
#   - 랜딩 블록(히어로·특징·CTA·FAQ·알림·구분선)이 렌더되는가
#   - **히어로를 첫 블록으로 놓으면 페이지 제목 h1 이 사라지는가** (같은 말이
#     두 번 크게 적히지 않게)
#   - **블록이 화면 제목을 정하는가** — 게시판 글 상세의 <title> 이 글 제목이
#     어야 한다. 라우터 페이지 제목("게시판")이 그대로 쓰이면 모든 글이 같은
#     제목으로 공유·색인된다.
#   - 헤더 내비게이션이 **현재 위치**를 표시하는가 (aria-current)
#   - 접근성·기본기: 스킵 링크, 파비콘, color-scheme
#   - 웹 화면(로그인 등)이 **같은 팔레트를 받는가** (/api/themes/tokens.css)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-theme.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0
TEST_THEME=""

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  # 검증용으로 만든 임시 테마는 반드시 지운다 — 남으면 다음 실행이 오염된다
  if [[ -n "$TEST_THEME" && -d "$ROOT/themes/$TEST_THEME" ]]; then rm -rf "$ROOT/themes/$TEST_THEME"; fi
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
count_of() { grep -o "$2" <<< "$1" | wc -l | tr -d ' '; }
# 공개 페이지 HTML — 렌더 엔드포인트는 JSON 으로 감싸서 준다(웹이 프록시한다)
render() {
  curl -s "$API/api/render/page?path=$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))"
}

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
stop_server() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
  fi
  sleep 1
}

echo "▶ 테마·랜딩 스모크 테스트"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-theme-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
start_server

curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
  -d '{"siteName":"테마시험","adminEmail":"admin@th.test","adminPassword":"adminpass123","starter":"community"}' \
  -o /dev/null
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@th.test","password":"adminpass123"}' -o /dev/null

# ════════════════════════════════════════════════════
echo "── 팔레트: 라이트 · 다크 두 벌"
HOME_HTML="$(render "")"
contains "라이트 토큰이 :root 로" "$HOME_HTML" "--color-primary:"
contains "다크는 OS 설정을 따르고" "$HOME_HTML" "@media (prefers-color-scheme: dark)"
contains "라이트를 고른 손님은 제외한다" "$HOME_HTML" ':root:not([data-theme="light"])'
contains "직접 고른 다크가 OS 보다 세다" "$HOME_HTML" ':root[data-theme="dark"]'
contains "다크 팔레트의 값이 실제로 다르다" "$HOME_HTML" "#101116"
contains "스크롤바·폼 위젯도 다크로" "$HOME_HTML" 'name="color-scheme"'

echo "── 웹 화면(로그인·마이페이지)도 같은 팔레트를 받는다"
TOKENS="$(curl -s "$API/api/themes/tokens.css")"
check "tokens.css 는 공개" "$(code "$API/api/themes/tokens.css")" "200"
contains "tokens.css 에 라이트" "$TOKENS" "--color-primary:"
contains "tokens.css 에 다크" "$TOKENS" 'data-theme="dark"'
CT="$(curl -s -o /dev/null -w "%{content_type}" "$API/api/themes/tokens.css")"
contains "CSS 로 내려준다" "$CT" "text/css"

echo "── 404 에서 손님을 세워 두지 않는다"
NF="$(render "no-such-page")"
contains "404 안내" "$NF" "페이지를 찾을 수 없습니다"
contains "홈으로 가는 길" "$NF" '<a class="brick-btn brick-btn-primary" href="/">홈으로</a>'
contains "검색으로 가는 길" "$NF" 'href="/search"'

echo "── 팔레트에는 화면들이 실제로 쓸 값이 다 있어야 한다"
for tok in color-bg color-bg-soft color-text color-text-soft color-muted \
           color-line color-line-strong color-primary color-primary-hover \
           color-primary-soft color-primary-text color-on-primary \
           color-danger color-success color-warning radius radius-lg; do
  contains "토큰 $tok" "$TOKENS" "--$tok:"
done
# 로그인·마이페이지가 쓰는 색은 다크에서도 정의돼야 한다 — 아니면 흰 글자에 흰 배경이 된다
DARK_BLOCK="${TOKENS##*data-theme}"
for tok in color-bg color-text color-muted color-line color-on-primary; do
  contains "다크에도 $tok" "$DARK_BLOCK" "--$tok:"
done

echo "── 기본기: 스킵 링크 · 파비콘 · 현재 위치"
contains "스킵 링크(키보드)" "$HOME_HTML" 'class="brick-skip"'
contains "파비콘" "$HOME_HTML" 'rel="icon"'
NAV_HTML="$(render "about")"
contains "현재 메뉴를 표시한다" "$NAV_HTML" 'aria-current="page"'
check "현재 표시는 한 곳뿐" "$(count_of "$NAV_HTML" 'aria-current="page"')" "1"

echo "── 폼은 type 을 안 적은 input 까지 스타일한다"
# `<input name="x">` 는 text 로 동작하지만 [type="text"] 에는 안 걸린다.
# 이 규칙이 빠지면 type 을 생략한 폼이 다크에서 흰 칸 + 흰 글자가 된다.
STYLE_CSS="$(cat "$ROOT/themes/default/assets/style.css")"
contains "테마 CSS 는 Tailwind 소스에서 컴파일된 산출물 (@layer theme)" "$STYLE_CSS" "@layer theme"
contains "type 없는 input 도 포함" "$STYLE_CSS" 'input:not([type])'
contains "포커스 링은 input 전체에" "$STYLE_CSS" '.brick-main input:focus-visible'
# 손님이 고른 밝기를 UA 위젯에도 알려야 한다 — 아니면 다크 화면에 흰 체크박스가 남는다
contains "고른 다크는 UA 위젯까지" "$STYLE_CSS" '[data-theme=dark]{color-scheme:dark}'
contains "고른 라이트도 마찬가지" "$STYLE_CSS" '[data-theme=light]{color-scheme:light}'

echo "── 에셋 캐시버스터는 파일을 고치면 바뀐다"
V1="$(grep -o 'style\.css?v=[^"]*' <<< "$HOME_HTML" | head -1)"
[[ -n "$V1" ]] && ok "스타일 링크에 버전이 붙는다 ($V1)" || bad "스타일 링크에 버전이 없다"
touch "$ROOT/themes/default/assets/style.css"
sleep 6  # mtime 메모 캐시(5초)가 만료될 시간
V2="$(render "" | grep -o 'style\.css?v=[^"]*' | head -1)"
[[ -n "$V2" && "$V1" != "$V2" ]] && ok "고치면 버전이 바뀐다 ($V2)" \
  || bad "테마를 고쳐도 버전이 그대로다 — 손님이 옛 CSS 를 본다 ($V1 → $V2)"

# ════════════════════════════════════════════════════
echo "── 토큰 값으로 CSS 를 주입할 수 없다"
TEST_THEME="smoke-inject"
mkdir -p "$ROOT/themes/$TEST_THEME/templates"
cat > "$ROOT/themes/$TEST_THEME/brick.theme.json" <<'JSON'
{
  "name": "smoke-inject",
  "version": "9.9.9",
  "displayName": "주입 시험",
  "templates": { "layout": "templates/layout.html", "page": "templates/page.html" },
  "tokens": {
    "color-bg": "#fff",
    "evil": "red; } body { display: none } .x {",
    "evil-comment": "red /* eaten",
    "evil-import": "@import url(http://evil.test/x.css)",
    "bad key!": "blue",
    "color-text": "#111"
  }
}
JSON
printf '<!doctype html><html><head><style>{{{ themeTokens }}}</style></head><body>{{{ content }}}</body></html>' \
  > "$ROOT/themes/$TEST_THEME/templates/layout.html"
printf '<article>{{{ blocksHtml }}}</article>' > "$ROOT/themes/$TEST_THEME/templates/page.html"

curl -s -b "$CK" -X POST "$API/api/themes/$TEST_THEME/activate" -o /dev/null
INJ="$(render "")"
absent "선언을 닫는 값은 버린다" "$INJ" "display: none"
absent "주석을 여는 값도 버린다" "$INJ" "/* eaten"
absent "@import 도 버린다" "$INJ" "@import"
absent "이상한 키는 버린다" "$INJ" "bad key"
contains "정상 토큰은 남는다" "$INJ" "--color-text: #111"
curl -s -b "$CK" -X POST "$API/api/themes/default/activate" -o /dev/null
rm -rf "$ROOT/themes/$TEST_THEME"; TEST_THEME=""

# ════════════════════════════════════════════════════
echo "── 두 번째 동봉 테마(editorial): 같은 계약, 다른 인상"
THEMES="$(curl -s -b "$CK" "$API/api/themes")"
contains "테마 목록에 editorial" "$THEMES" '"name":"editorial"'
check "editorial 적용" "$(code -b "$CK" -X POST "$API/api/themes/editorial/activate")" "201"
ED_HOME="$(render "")"
contains "제호(masthead) 레이아웃" "$ED_HOME" 'class="brick-masthead'
contains "섹션 메뉴 괘선 바" "$ED_HOME" 'class="brick-navbar'
contains "명조 제목 토큰" "$ED_HOME" "--font-display:"
contains "다크 팔레트도 두 벌" "$ED_HOME" "#17150f"
contains "파비콘은 자기 것" "$ED_HOME" "/themes/editorial/assets/favicon.svg"
contains "코어 계약: 스킵 링크" "$ED_HOME" 'class="brick-skip"'
contains "코어 계약: 헤더 액션 자리" "$ED_HOME" 'class="brick-actions"'
contains "코어 계약: 현재 메뉴 표시" "$(render "about")" 'aria-current="page"'
ED_BOARD="$(render "board/free")"
contains "플러그인 화면(게시판)도 이 테마로" "$ED_BOARD" 'class="brick-masthead'
contains "코어 404 도 이 테마의 프리미티브(버튼)로 그린다" "$(render "no-such-page")" '<a class="brick-btn brick-btn-primary" href="/">홈으로</a>'
ED_TOKENS="$(curl -s "$API/api/themes/tokens.css")"
contains "웹 화면(로그인·관리)도 종이색 팔레트를 받는다" "$ED_TOKENS" "#fbf8f2"
check "스타일시트 서빙" "$(code "$API/themes/editorial/assets/style.css")" "200"
check "기본 테마로 복귀" "$(code -b "$CK" -X POST "$API/api/themes/default/activate")" "201"
absent "복귀 후 제호 레이아웃이 남지 않는다 (렌더 캐시 키에 테마 스탬프)" "$(render "")" 'class="brick-masthead'

# ════════════════════════════════════════════════════
echo "── 랜딩 블록"
PAGE_JSON="$TMP/landing.json"
cat > "$PAGE_JSON" <<'JSON'
{
  "slug": "landing",
  "title": "랜딩시험",
  "status": "published",
  "blocks": [
    { "block": "core/hero", "props": {
        "eyebrow": "새소식", "title": "히어로 제목입니다", "text": "설명 문장",
        "ctaLabel": "시작하기", "ctaUrl": "/about", "altLabel": "더 보기", "altUrl": "/board" } },
    { "block": "core/features", "props": {
        "title": "우리가 하는 일",
        "items": "카드하나 | 설명하나 | /about\n카드둘 | 설명둘\n" } },
    { "block": "core/cta", "props": {
        "title": "지금 시작하세요", "text": "가입은 1분", "buttonLabel": "가입", "buttonUrl": "/register" } },
    { "block": "core/faq", "props": { "items": "질문하나 | 답변하나\n질문둘 | 답변둘" } },
    { "block": "core/notice", "props": { "text": "알림 문장", "tone": "warning" } },
    { "block": "core/media-text", "props": { "image": "https://example.test/pic.jpg", "alt": "사진", "title": "분할 제목", "text": "분할 본문", "reverse": true } },
    { "block": "core/media-text", "props": { "title": "이미지 없는 분할", "text": "글만" } },
    { "block": "core/stats", "props": { "items": "1,200+ | 고객\n98% | 만족" } },
    { "block": "core/testimonials", "props": { "title": "후기", "items": "정말 좋아요 | 김민수 | 서울\n다시 살게요 | 이서연" } },
    { "block": "core/image-gallery", "props": { "columns": 4, "items": "https://example.test/1.jpg | 첫 장 | /about\nhttps://example.test/2.jpg\njavascript:alert(1) | 나쁜 주소" } },
    { "block": "core/divider", "props": {} }
  ]
}
JSON
CREATED="$(curl -s -b "$CK" -X POST "$API/api/pages" \
  -H 'content-type: application/json' --data-binary "@$PAGE_JSON")"
LANDING_ID="$(python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" <<< "$CREATED")"
[[ -n "$LANDING_ID" ]] && ok "랜딩 페이지 생성" || bad "랜딩 페이지 생성 실패 (${CREATED:0:160})"

L="$(render "landing")"
contains "히어로" "$L" 'class="brick-hero"'
contains "히어로 라벨" "$L" "새소식"
contains "히어로 버튼 두 개" "$L" 'brick-btn-primary'
contains "특징 카드" "$L" 'class="brick-features"'
contains "링크 있는 카드는 <a>" "$L" '<a class="brick-card" href="/about"'
contains "링크 없는 카드는 <div>" "$L" '<div class="brick-card">'
contains "CTA 배너" "$L" 'class="brick-cta"'
contains "FAQ 는 details (JS 없이 접힌다)" "$L" '<details class="brick-faq-item">'
contains "FAQ 답도 문서에 있다 (검색엔진이 읽는다)" "$L" "답변하나"
contains "알림 박스 색" "$L" 'brick-notice-warning'
contains "구분선" "$L" "<hr />"

echo "── 프리미엄 템플릿 재료 (이미지+글 · 숫자 · 후기 · 갤러리 · 사진 히어로)"
contains "이미지+글 분할" "$L" 'class="brick-media-text is-reverse"'
contains "분할의 이미지" "$L" 'src="https://example.test/pic.jpg"'
contains "이미지 없는 분할은 글만(no-media)" "$L" 'brick-media-text no-media'
contains "숫자 강조" "$L" '<div class="brick-stat"><strong>1,200+</strong><span>고객</span></div>'
contains "후기 카드" "$L" '<figure class="brick-quote"><blockquote>정말 좋아요</blockquote>'
contains "후기 소속은 선택" "$L" '<strong>이서연</strong></figcaption>'
contains "갤러리 열 수" "$L" 'style="--cols:4"'
contains "갤러리 링크 있는 항목은 <a>" "$L" '<a href="/about"><figure>'
absent "javascript: 이미지는 버린다" "$L" 'javascript:alert'
check "갤러리 항목은 2개만 (나쁜 주소 제외)" "$(count_of "$L" '<figure><img src="https://example.test/')" "2"
printf '{"slug":"herotest","title":"히어로시험","status":"published","blocks":[{"block":"core/hero","props":{"title":"사진 위 제목","image":"https://example.test/bg.jpg) } body{display:none} .x{"}}]}' > "$TMP/hero.json"
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/hero.json" -o /dev/null
H="$(render "herotest")"
absent "url() 을 닫는 값은 주소 전체를 버린다" "$H" '--hero-image'
absent "버린 주소로는 사진 히어로가 되지 않는다" "$H" 'has-image'
printf '{"slug":"herook","title":"히어로정상","status":"published","blocks":[{"block":"core/hero","props":{"title":"사진 위 제목","image":"https://example.test/bg.jpg"}}]}' > "$TMP/hero2.json"
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/hero2.json" -o /dev/null
H2="$(render "herook")"
contains "정상 주소는 사진 히어로(has-image)" "$H2" 'brick-hero has-image'
contains "배경 이미지 변수" "$H2" '--hero-image: url(https://example.test/bg.jpg)'
contains "웹폰트 링크(실패 시 시스템 글꼴)" "$HOME_HTML" 'pretendardvariable-dynamic-subset'
echo "── 아이콘 스프라이트"
contains "스프라이트 시트가 문서에 한 번" "$HOME_HTML" '<symbol id="i-cart"'
check "스프라이트는 한 번만" "$(count_of "$HOME_HTML" '<symbol id="i-cart"')" "1"
contains "특징 카드의 아이콘은 이름으로 참조" "$(render "about")" '<use href="#i-star"></use>'
# JSON 은 인용 heredoc 으로 — bash printf 는 \n 을 실제 줄바꿈으로 바꿔 JSON 을 깨뜨린다
cat > "$TMP/ico.json" <<'JSON'
{"slug":"icotest","title":"아이콘시험","status":"published","blocks":[{"block":"core/features","props":{"items":"가 | 나 | | truck\n다 | 라 | | <script>x</script>"}}]}
JSON
ICO_CREATE="$(curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' --data-binary "@$TMP/ico.json")"
ICO="$(render "icotest")"
contains "아이콘 이름이 심볼 참조로 (생성 응답: ${ICO_CREATE:0:80})" "$ICO" 'href="#i-truck"'
absent "이름이 아닌 값은 아이콘이 되지 않는다" "$ICO" 'href="#i-<'
check "아이콘은 유효한 것 하나만" "$(count_of "$ICO" 'class="brick-card-icon"')" "1"
contains "푸터 3열" "$HOME_HTML" 'class="brick-footer-cols'

echo "── 히어로가 첫 블록이면 페이지 제목을 히어로가 맡는다"
contains "문서 제목은 히어로 제목" "$L" "<title>히어로 제목입니다 — 테마시험</title>"
check "h1 은 하나뿐 (같은 말이 두 번 크게 적히지 않는다)" "$(count_of "$L" '<h1')" "1"
absent "페이지 제목 h1 은 그리지 않는다" "$L" "<h1>랜딩시험</h1>"

echo "── 빈 목록은 아무것도 그리지 않는다"
printf '{"slug":"landing","title":"랜딩시험","status":"published","blocks":[{"block":"core/features","props":{"items":""}},{"block":"core/faq","props":{"items":""}}]}' > "$TMP/empty.json"
curl -s -b "$CK" -X PUT "$API/api/pages/$LANDING_ID" -H 'content-type: application/json' \
  --data-binary "@$TMP/empty.json" -o /dev/null
E="$(render "landing")"
absent "빈 특징 묶음은 섹션조차 없다" "$E" 'class="brick-features"'
absent "빈 FAQ 도 없다" "$E" 'brick-faq-item'
contains "제목은 되돌아온다 (히어로가 없으므로)" "$E" "<h1>랜딩시험</h1>"

# ════════════════════════════════════════════════════
echo "── 블록이 화면 제목을 정한다 (공유 링크·검색 결과)"
POST_JSON="$TMP/post.json"
printf '{"title":"제목이 문서에 실려야 한다","content":"본문 내용은 설명으로 요약된다. 두 번째 문장."}' > "$POST_JSON"
PID="$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/boards/free/posts" \
  -H 'content-type: application/json' --data-binary "@$POST_JSON" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$PID" ]] && ok "시험용 글 작성" || bad "시험용 글 작성 실패"

D="$(render "board/free/$PID")"
contains "글 상세의 문서 제목은 글 제목" "$D" "<title>제목이 문서에 실려야 한다 — 테마시험</title>"
contains "설명(공유 미리보기)은 본문 요약" "$D" 'name="description" content="본문 내용은'
check "글 상세의 h1 은 하나 (글 제목)" "$(count_of "$D" '<h1')" "1"
contains "그 h1 이 글 제목" "$D" "<h1>제목이 문서에 실려야 한다</h1>"

LIST="$(render "board/free")"
contains "목록의 문서 제목은 게시판 이름" "$LIST" "<title>자유게시판 — 테마시험</title>"
check "목록의 h1 도 하나" "$(count_of "$LIST" '<h1')" "1"

echo "── 항상 빈 열은 그리지 않는다"
absent "공지 없는 게시판에 공지 열이 없다" "$LIST" 'class="brick-c-num"'
NOTICE_LIST="$(render "board/notice")"

echo "── 운영자가 SEO 를 명시하면 그것이 우선한다"
BOARD_ID="$(curl -s -b "$CK" "$API/api/pages" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get('items', [])
print(next((p['id'] for p in rows if p.get('slug') == 'board'), ''))")"
printf '{"slug":"board","title":"게시판","status":"published","seo":{"title":"운영자가 정한 제목"},"blocks":[{"block":"brick-board/board","props":{}}]}' > "$TMP/seo.json"
curl -s -b "$CK" -X PUT "$API/api/pages/$BOARD_ID" -H 'content-type: application/json' \
  --data-binary "@$TMP/seo.json" -o /dev/null
contains "블록보다 운영자 설정이 세다" "$(render "board/free/$PID")" "<title>운영자가 정한 제목</title>"

# ════════════════════════════════════════════════════
echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
