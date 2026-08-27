#!/usr/bin/env bash
#
# brick-site (방문자 집계 · 팝업/배너) E2E 스모크 테스트.
#
# 집계는 조용히 틀리는 기능이다 — 숫자가 이상해도 아무도 에러를 보지 못한다.
# 그래서 다음을 명시적으로 검증한다:
#   - 같은 방문자를 두 번 세지 않는가
#   - 봇·관리자를 제외하는가
#   - IP 원문을 저장하지 않는가 (개인정보)
#   - 팝업 노출 기간·경로 조건이 서버에서 걸러지는가
#   - 팝업 본문 HTML에서 스크립트가 제거되는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-site.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
ST="$API/api/plugins/brick-site"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
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
# 방문 집계 훅은 응답을 기다리지 않으므로(void doAction) 잠깐 준다
settle() { sleep 0.4; }

echo "▶ brick-site 사이트 운영 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-site-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비 ────────────────────────────────────────────
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Site","adminEmail":"admin@site.test","adminPassword":"sitepass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@site.test","password":"sitepass123"}' >/dev/null
contains "사이트 운영 플러그인 활성화" \
  "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-site/activate")" '"ok":true'

NAV="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "팝업 리소스 자동 등록" "$NAV" '"name":"popups"'

# 집계 대상이 될 공개 페이지를 만든다
cat > "$TMP/page.json" <<'JSON'
{"slug":"home","title":"첫 화면","status":"published",
 "blocks":[{"name":"core/heading","props":{"text":"환영합니다"}}]}
JSON
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  --data-binary "@$TMP/page.json" >/dev/null
cat > "$TMP/shoppage.json" <<'JSON'
{"slug":"shop","title":"쇼핑","status":"published",
 "blocks":[{"name":"core/heading","props":{"text":"상품"}}]}
JSON
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  --data-binary "@$TMP/shoppage.json" >/dev/null

echo "── 방문 집계"
UA="Mozilla/5.0 (Macintosh) SmokeBrowser/1.0"
visit() { curl -s -H "user-agent: $1" "$API/api/render/page?path=${2:-home}" >/dev/null; }

visit "$UA" home
settle
check "첫 방문 1명" "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "1"

# 같은 UA·같은 IP → 같은 사람. 여러 번 봐도 1명이다
visit "$UA" home
visit "$UA" shop
visit "$UA" home
settle
check "같은 방문자 재방문은 세지 않음" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "1"
check "원본도 1행만" "$(psql_one "SELECT count(*) FROM site_visits")" "1"

# 다른 UA → 다른 사람 (사무실처럼 IP가 같아도 구분된다)
visit "Mozilla/5.0 (Windows NT 10.0) OtherBrowser/2.0" home
settle
check "다른 브라우저는 다른 방문자" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "2"

visit "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148" home
settle
check "모바일 방문 구분 집계" \
  "$(psql_one "SELECT mobile FROM site_visit_daily WHERE visit_day = current_date")" "1"

echo "── 집계에서 빼는 것"
visit "Googlebot/2.1 (+http://www.google.com/bot.html)" home
visit "curl/8.4.0" home
visit "SomeUptimeMonitor/1.0" home
settle
check "검색봇·모니터링은 세지 않음" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "3"

# 관리자 방문 (기본 설정에서는 세지 않는다)
curl -s -b "$CK" -H "user-agent: AdminBrowser/1.0 Mozilla" \
  "$API/api/render/page?path=home" >/dev/null
settle
check "관리자 방문은 기본 제외" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "3"

# 관리 화면 요청은 방문이 아니다
curl -s -H "user-agent: $UA-2 Mozilla" "$API/api/render/page?path=admin/dashboard" >/dev/null
settle
check "/admin 경로는 방문 아님" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "3"

echo "── 개인정보 (IP를 원문으로 두지 않는다)"
absent "IP 원문 미저장" "$(psql_one "SELECT string_agg(ip_prefix, ',') FROM site_visits")" "127.0.0.1"
contains "대역만 축약 저장" "$(psql_one "SELECT string_agg(ip_prefix, ',') FROM site_visits")" "127.0.*"
KEYLEN="$(psql_one "SELECT length(visitor_key) FROM site_visits LIMIT 1")"
check "방문자 키는 해시(64자)" "$KEYLEN" "64"
# 소금이 없으면 IP를 그대로 해시한 값과 같아질 수 있다 → 소금이 저장되어 있어야 한다
SALT="$(psql_one "SELECT count(*) FROM site_settings WHERE key = 'plugin:brick-site:visitorSalt'")"
[[ "$SALT" == "1" ]] && ok "설치별 소금 생성" || bad "설치별 소금 생성 (실제 $SALT)"

echo "── 집계 조회"
PUB="$(curl -s "$ST/visits")"
contains "공개 집계: 오늘" "$PUB" '"today":3'
contains "공개 집계: 전체" "$PUB" '"total":3'
absent "공개 집계에 일별 추이 없음" "$PUB" '"daily"'
absent "공개 집계에 유입 경로 없음" "$PUB" '"referers"'
check "비관리자 상세 집계 차단" "$(code "$ST/admin/visits")" "403"
ADM="$(curl -s -b "$CK" "$ST/admin/visits")"
contains "관리자 집계: 일별 추이" "$ADM" '"daily"'
contains "관리자 집계: 최고 기록" "$ADM" '"best"'
contains "관리자 집계: 유입 경로" "$ADM" '"referers"'

# 유입 경로 기록
curl -s -H "user-agent: RefererBrowser/1.0 Mozilla" -H "referer: https://search.example.com/q?x=1" \
  "$API/api/render/page?path=home" >/dev/null
settle
contains "유입 도메인 기록" "$(curl -s -b "$CK" "$ST/admin/visits")" "search.example.com"
absent "유입 경로에 쿼리스트링 미저장" \
  "$(psql_one "SELECT string_agg(referer_host, ',') FROM site_visits")" "q?x=1"

echo "── 집계 블록"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "접속자 집계 블록" "$BLOCKS" "brick-site/visit-counter"
contains "배너 블록" "$BLOCKS" "brick-site/banner"
contains "팝업 블록" "$BLOCKS" "brick-site/popup"
COUNTER="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-site/visit-counter","props":{"style":"box","showBest":true}}')"
contains "집계 블록 서버 렌더" "$COUNTER" "오늘"
contains "최고 기록 표시" "$COUNTER" "최고"

echo "── 팝업 등록"
check "비관리자 팝업 등록 차단" \
  "$(code -X POST "$ST/admin/popups" -H 'content-type: application/json' \
      -d '{"title":"침입"}')" "403"
check "제목 없는 팝업 차단" \
  "$(code -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
      -d '{"title":""}')" "400"
check "잘못된 노출 경로 차단" \
  "$(code -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
      -d '{"title":"x","path_prefix":"shop"}')" "400"
check "javascript: 링크 차단" \
  "$(code -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
      -d '{"title":"x","link_url":"javascript:alert(1)"}')" "400"
check "종료가 시작보다 빠르면 차단" \
  "$(code -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
      -d '{"title":"x","starts_at":"2030-01-02T00:00:00Z","ends_at":"2030-01-01T00:00:00Z"}')" "400"

cat > "$TMP/p1.json" <<'JSON'
{"title":"전체 공지","content":"<p>점검 안내입니다</p>","path_prefix":"*",
 "link_url":"/notice","hide_days":3,"width":420,"pos_top":60,"pos_left":80}
JSON
P1="$(curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/p1.json" | jq_get "['id']")"
[[ -n "$P1" ]] && ok "전체 팝업 등록" || bad "전체 팝업 등록"

cat > "$TMP/p2.json" <<'JSON'
{"title":"쇼핑몰 이벤트","content":"<p>세일 중</p>","path_prefix":"/shop"}
JSON
P2="$(curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/p2.json" | jq_get "['id']")"
[[ -n "$P2" ]] && ok "경로 한정 팝업 등록" || bad "경로 한정 팝업 등록"

echo "── 팝업 본문 새니타이즈 (관리자 계정이 털렸을 때)"
cat > "$TMP/xss.json" <<'JSON'
{"title":"XSS 시도",
 "content":"<p onclick=\"alert(1)\">본문</p><script>alert(1)</script><iframe src=\"//evil\"></iframe><img src=x onerror=alert(1)><a href=\"javascript:alert(1)\">링크</a><a href=\"/ok\">정상</a><style>body{display:none}</style>"}
JSON
PX="$(curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/xss.json" | jq_get "['id']")"
STORED="$(psql_one "SELECT content FROM site_popups WHERE id = '$PX'")"
absent "script 태그 제거"      "$STORED" "<script"
absent "iframe 제거"           "$STORED" "<iframe"
absent "style 태그 제거"       "$STORED" "<style"
absent "onclick 속성 제거"     "$STORED" "onclick"
absent "onerror 속성 제거"     "$STORED" "onerror"
absent "javascript: 링크 제거" "$STORED" "javascript:"
contains "정상 문단 유지"      "$STORED" "본문"
contains "정상 링크 유지"      "$STORED" '/ok'
contains "링크에 noopener 부여" "$STORED" "noopener"

echo "── 팝업 노출 조건 (서버에서 걸러진다)"
HOME_POPUPS="$(curl -s "$ST/popups?path=/home")"
contains "전체 팝업은 어디서나" "$HOME_POPUPS" "전체 공지"
absent "경로 한정 팝업은 안 뜸" "$HOME_POPUPS" "쇼핑몰 이벤트"
SHOP_POPUPS="$(curl -s "$ST/popups?path=/shop")"
contains "지정 경로에서 노출" "$SHOP_POPUPS" "쇼핑몰 이벤트"
contains "하위 경로에서도 노출" "$(curl -s "$ST/popups?path=/shop/item-1")" "쇼핑몰 이벤트"
absent "접두어만 겹치는 경로는 제외" "$(curl -s "$ST/popups?path=/shopping-mall")" "쇼핑몰 이벤트"

# 기간
cat > "$TMP/future.json" <<'JSON'
{"title":"예약 이벤트","content":"<p>아직 아님</p>","starts_at":"2099-01-01T00:00:00Z"}
JSON
curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/future.json" >/dev/null
absent "시작 전 팝업은 응답에 없음" "$(curl -s "$ST/popups?path=/home")" "아직 아님"
cat > "$TMP/past.json" <<'JSON'
{"title":"끝난 이벤트","content":"<p>종료됨</p>","ends_at":"2000-01-01T00:00:00Z"}
JSON
curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/past.json" >/dev/null
absent "종료된 팝업은 응답에 없음" "$(curl -s "$ST/popups?path=/home")" "종료됨"

# 비활성
curl -s -b "$CK" -X PUT "$ST/admin/popups/$P2" -H 'content-type: application/json' \
  -d '{"title":"쇼핑몰 이벤트","content":"<p>세일 중</p>","path_prefix":"/shop","is_active":false}' >/dev/null
absent "사용 해제 시 노출 중단" "$(curl -s "$ST/popups?path=/shop")" "쇼핑몰 이벤트"

echo "── 노출·클릭 집계"
VIEWS_BEFORE="$(psql_one "SELECT view_count FROM site_popups WHERE id = '$P1'")"
curl -s "$ST/popups?path=/home" >/dev/null
VIEWS_AFTER="$(psql_one "SELECT view_count FROM site_popups WHERE id = '$P1'")"
check "노출 카운트 증가" "$((VIEWS_AFTER - VIEWS_BEFORE))" "1"
contains "클릭 기록" "$(curl -s -X POST "$ST/popups/$P1/click")" '"ok":true'
check "클릭 카운트 증가" "$(psql_one "SELECT click_count FROM site_popups WHERE id = '$P1'")" "1"

echo "── 배너"
cat > "$TMP/banner.json" <<'JSON'
{"title":"여름 세일","kind":"banner","image_url":"/uploads/summer.jpg",
 "link_url":"https://example.com/sale","link_target":"_blank","path_prefix":"*"}
JSON
BID="$(curl -s -b "$CK" -X POST "$ST/admin/popups" -H 'content-type: application/json' \
  --data-binary "@$TMP/banner.json" | jq_get "['id']")"
[[ -n "$BID" ]] && ok "배너 등록" || bad "배너 등록"
absent "배너는 팝업 목록에 없음" "$(curl -s "$ST/popups?path=/home")" "여름 세일"
contains "배너는 배너 목록에 있음" "$(curl -s "$ST/popups?path=/home&kind=banner")" "여름 세일"
BANNER_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-site/banner","props":{},"path":"home"}')"
contains "배너 블록 서버 렌더" "$BANNER_HTML" "summer.jpg"
contains "새 창 링크에 noopener" "$BANNER_HTML" "noopener"

echo "── 관리 목록"
LIST="$(curl -s -b "$CK" "$ST/admin/popups")"
contains "관리 목록에 종류 라벨" "$LIST" '"kind_label"'
contains "관리 목록에 노출 수" "$LIST" '"view_count"'
check "비관리자 관리 목록 차단" "$(code "$ST/admin/popups")" "403"
contains "팝업 삭제" "$(curl -s -b "$CK" -X DELETE "$ST/admin/popups/$P1")" '"ok":true'
check "없는 팝업 삭제는 404" "$(code -b "$CK" -X DELETE "$ST/admin/popups/$P1")" "404"
absent "삭제 후 노출 중단" "$(curl -s "$ST/popups?path=/home")" "전체 공지"

echo "── 설정"
contains "설정 조회" "$(curl -s -b "$CK" "$ST/admin/settings")" '"countVisits":true'
check "비관리자 설정 변경 차단" \
  "$(code -X PUT "$ST/admin/settings" -H 'content-type: application/json' -d '{"countVisits":false}')" "403"
contains "관리자 방문 집계 켜기" \
  "$(curl -s -b "$CK" -X PUT "$ST/admin/settings" -H 'content-type: application/json' \
      -d '{"countVisits":true,"countAdmins":true}')" '"countAdmins":true'
BEFORE_ADMIN="$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")"
curl -s -b "$CK" -H "user-agent: AdminBrowser/9.9 Mozilla" \
  "$API/api/render/page?path=home" >/dev/null
settle
AFTER_ADMIN="$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")"
check "설정을 켜면 관리자도 집계" "$((AFTER_ADMIN - BEFORE_ADMIN))" "1"

contains "집계 끄기" \
  "$(curl -s -b "$CK" -X PUT "$ST/admin/settings" -H 'content-type: application/json' \
      -d '{"countVisits":false}')" '"countVisits":false'
BEFORE_OFF="$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")"
visit "TotallyNewBrowser/1.0 Mozilla" home
settle
check "끄면 더 세지 않음" \
  "$(psql_one "SELECT total FROM site_visit_daily WHERE visit_day = current_date")" "$BEFORE_OFF"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
