#!/usr/bin/env bash
#
# 1:1 문의 · FAQ · 사이트맵 E2E 스모크.
#
# 못박는 것:
#   - 문의는 **기본이 비공개**인가 (남의 문의가 절대 보이지 않는가)
#   - 없는 문의와 남의 문의를 구분해 알려주지 않는가 (열거 방지)
#   - 비회원 조회 비밀번호가 실제로 검증되는가
#   - 답변 상태가 양방향으로 바뀌는가 (답변 후 재질문 → 접수)
#   - 사이트맵에 비밀글·비공개가 새지 않는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-helpdesk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
HD="$API/api/plugins/brick-helpdesk"
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
render_html() { python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))" 2>/dev/null || echo ""; }

echo "▶ 1:1 문의 · FAQ 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-help-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_SITE_URL="${BRICK_SITE_URL:-https://help.test}"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

CONSENT='"agreements":{"terms":true,"privacy":true},'
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"Help","adminEmail":"admin@help.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@help.test","password":"adminpass123"}' >/dev/null
contains "플러그인 활성화" \
  "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-helpdesk/activate")" '"ok":true'

# 회원 둘 — 서로의 문의가 보이지 않아야 한다
for n in 1 2; do
  printf '{"email":"u%s@help.test","password":"password123",%s"displayName":"회원%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"u%s@help.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/u$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
U1="$TMP/u1.txt"; U2="$TMP/u2.txt"

echo "── 관리자 리소스 등록"
NAV="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "문의 리소스" "$NAV" '"name":"tickets"'
contains "FAQ 리소스" "$NAV" '"name":"faqs"'
contains "FAQ 분류 리소스" "$NAV" '"name":"faq-categories"'

echo "── 설정"
CONF="$(curl -s "$HD/config")"
contains "분류 목록 제공" "$CONF" "주문·배송"
contains "비회원 문의는 기본 꺼짐" "$CONF" '"allowGuest":false'

echo "── 문의 접수"
check "비로그인 문의 차단 (기본 설정)" \
  "$(code -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"제목","content":"내용입니다"}')" "401"
check "제목 없는 문의 차단" \
  "$(code -b "$U1" -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"","content":"내용입니다"}')" "400"
check "너무 짧은 내용 차단" \
  "$(code -b "$U1" -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"제목","content":"짧음"}')" "400"
check "없는 분류 차단" \
  "$(code -b "$U1" -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"제목","content":"충분한 내용입니다","category":"없는분류"}')" "400"

T1="$(curl -s -b "$U1" -X POST "$HD/tickets" -H 'content-type: application/json' \
  -d '{"title":"환불 문의","content":"주문번호 12345 환불 부탁드립니다. 계좌는 000-000.","category":"환불·교환"}')"
T1_ID="$(echo "$T1" | jq_get "['id']")"
T1_NO="$(echo "$T1" | jq_get "['ticketNo']")"
[[ -n "$T1_ID" ]] && ok "문의 접수" || bad "문의 접수"
[[ "$T1_NO" == Q* ]] && ok "문의번호 발급 ($T1_NO)" || bad "문의번호 발급 (실제 $T1_NO)"

check "1분 내 재문의는 도배 방지" \
  "$(code -b "$U1" -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"두번째","content":"연속 문의 시도입니다"}')" "429"

echo "── 프라이버시: 남의 문의는 존재조차 알 수 없다"
MY1="$(curl -s -b "$U1" "$HD/my/tickets")"
contains "내 문의 목록에 보임" "$MY1" "환불 문의"
MY2="$(curl -s -b "$U2" "$HD/my/tickets")"
contains "남의 목록에는 없음" "$MY2" '"total":0'
absent "남의 목록에 제목 미노출" "$MY2" "환불 문의"

# 403 이 아니라 404 여야 한다 — 403 은 "그 문의가 존재한다"를 알려준다
check "남의 문의 상세는 404 (403 이면 존재가 새어 나간다)" \
  "$(code -b "$U2" "$HD/tickets/$T1_ID")" "404"
check "비로그인도 404" "$(code "$HD/tickets/$T1_ID")" "404"
DETAIL_OTHER="$(curl -s -b "$U2" "$HD/tickets/$T1_ID")"
absent "남에게 계좌번호 미노출" "$DETAIL_OTHER" "000-000"
absent "남에게 주문번호 미노출" "$DETAIL_OTHER" "12345"

echo "── 본인·운영자 열람"
MINE="$(curl -s -b "$U1" "$HD/tickets/$T1_ID")"
contains "본인은 내용 열람" "$MINE" "주문번호 12345"
contains "본인 표시" "$MINE" '"mine":true'
absent "비밀번호 해시는 응답에 없음" "$MINE" "scrypt"
absent "본인에게도 남의 메일주소 필드 미노출" "$MINE" '"author_email":"u1@help.test"'
ADMIN_VIEW="$(curl -s -b "$CK" "$HD/tickets/$T1_ID")"
contains "운영자는 내용 열람" "$ADMIN_VIEW" "주문번호 12345"
contains "운영자에게는 연락 메일 노출" "$ADMIN_VIEW" "u1@help.test"

echo "── 답변과 상태 전이"
ADMIN_LIST="$(curl -s -b "$CK" "$HD/admin/tickets")"
contains "관리 목록에 접수 상태" "$ADMIN_LIST" '"status_label":"접수"'
contains "미답변 건수 집계" "$ADMIN_LIST" '"openCount":1'
check "일반 회원은 관리 목록 접근 불가" "$(code -b "$U1" "$HD/admin/tickets")" "403"

contains "운영자 답변 (관리 폼에서)" \
  "$(curl -s -b "$CK" -X PUT "$HD/admin/tickets/$T1_ID" -H 'content-type: application/json' \
      -d '{"reply":"확인했습니다. 3일 내 환불 처리됩니다."}')" '"ok":true'
AFTER="$(curl -s -b "$U1" "$HD/tickets/$T1_ID")"
contains "답변완료로 전이" "$AFTER" '"status":"answered"'
contains "답변 내용이 작성자에게 보임" "$AFTER" "3일 내 환불"
contains "운영자 답변으로 표시" "$AFTER" '"is_staff":true'

# 답변 후 재질문 → 다시 접수. 이게 안 되면 운영자가 놓친다
contains "작성자 추가 문의" \
  "$(curl -s -b "$U1" -X POST "$HD/tickets/$T1_ID/replies" -H 'content-type: application/json' \
      -d '{"content":"환불 계좌를 변경하고 싶습니다."}')" '"status":"open"'
contains "재질문 시 접수로 되돌아감" "$(curl -s -b "$U1" "$HD/tickets/$T1_ID")" '"status":"open"'
check "남은 답변 불가" \
  "$(code -b "$U2" -X POST "$HD/tickets/$T1_ID/replies" -H 'content-type: application/json' \
      -d '{"content":"끼어들기"}')" "404"

echo "── 종료"
contains "운영자가 종료" \
  "$(curl -s -b "$CK" -X PUT "$HD/admin/tickets/$T1_ID" -H 'content-type: application/json' \
      -d '{"status":"closed"}')" '"ok":true'
check "종료된 문의에는 답변 불가" \
  "$(code -b "$U1" -X POST "$HD/tickets/$T1_ID/replies" -H 'content-type: application/json' \
      -d '{"content":"추가 문의"}')" "409"
check "잘못된 상태값 거부" \
  "$(code -b "$CK" -X PUT "$HD/admin/tickets/$T1_ID" -H 'content-type: application/json' \
      -d '{"status":"bogus"}')" "400"

echo "── 비회원 문의 (설정을 켠 뒤)"
contains "비회원 허용으로 변경" \
  "$(curl -s -b "$CK" -X PUT "$HD/admin/settings" -H 'content-type: application/json' \
      -d '{"allowGuest":true,"categoriesText":"일반\n주문·배송","notifyOnAnswer":true,"pageSize":20}')" '"allowGuest":true'
check "이메일 없는 비회원 문의 차단 (답변을 받을 수 없다)" \
  "$(code -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"비회원 문의","content":"내용입니다 충분히","guestName":"손님","guestPassword":"1234"}')" "400"
check "짧은 조회 비밀번호 차단" \
  "$(code -X POST "$HD/tickets" -H 'content-type: application/json' \
      -d '{"title":"비회원","content":"내용입니다 충분히","guestName":"손님","guestEmail":"g@x.test","guestPassword":"1"}')" "400"

cat > "$TMP/guest.json" <<'JSON'
{"title":"비회원 문의","content":"비회원이 남긴 내용입니다.","category":"일반",
 "guestName":"손님","guestEmail":"guest@help.test","guestPassword":"guestpw"}
JSON
G="$(curl -s -X POST "$HD/tickets" -H 'content-type: application/json' --data-binary "@$TMP/guest.json")"
G_ID="$(echo "$G" | jq_get "['id']")"
G_NO="$(echo "$G" | jq_get "['ticketNo']")"
[[ -n "$G_ID" ]] && ok "비회원 문의 접수" || bad "비회원 문의 접수"
check "비밀번호 없이 조회 불가" "$(code "$HD/tickets/$G_ID")" "404"
check "틀린 비밀번호로 조회 불가" "$(code "$HD/tickets/$G_ID?pw=wrong")" "404"
contains "맞는 비밀번호로 조회" "$(curl -s "$HD/tickets/$G_ID?pw=guestpw")" "비회원이 남긴 내용"
contains "문의번호로도 조회" "$(curl -s "$HD/tickets/by-no/$G_NO?pw=guestpw")" "비회원이 남긴 내용"
contains "운영자는 비밀번호 없이 조회" "$(curl -s -b "$CK" "$HD/tickets/$G_ID")" "비회원이 남긴 내용"

echo "── FAQ"
CATS="$(curl -s -b "$CK" "$HD/admin/faq-categories")"
contains "기본 분류 심어짐" "$CATS" "자주 묻는 질문"
CAT_ID="$(echo "$CATS" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])")"
NEW_CAT="$(curl -s -b "$CK" -X POST "$HD/admin/faq-categories" -H 'content-type: application/json' \
  -d '{"name":"배송","slug":"delivery","sort_order":1}' | jq_get "['id']")"
[[ -n "$NEW_CAT" ]] && ok "분류 추가" || bad "분류 추가"
check "slug 중복 차단" \
  "$(code -b "$CK" -X POST "$HD/admin/faq-categories" -H 'content-type: application/json' \
      -d '{"name":"중복","slug":"delivery"}')" "409"
check "잘못된 slug 거부" \
  "$(code -b "$CK" -X POST "$HD/admin/faq-categories" -H 'content-type: application/json' \
      -d '{"name":"x","slug":"한글슬러그"}')" "400"

printf '{"question":"배송은 얼마나 걸리나요?","answer":"주문 후 2~3일 내 도착합니다.","category_id":"%s","sort_order":0}' "$NEW_CAT" > "$TMP/faq1.json"
F1="$(curl -s -b "$CK" -X POST "$HD/admin/faqs" -H 'content-type: application/json' --data-binary "@$TMP/faq1.json" | jq_get "['id']")"
[[ -n "$F1" ]] && ok "FAQ 등록" || bad "FAQ 등록"
printf '{"question":"회원 탈퇴는 어떻게 하나요?","answer":"내 정보 화면에서 가능합니다.","category_id":"%s"}' "$CAT_ID" > "$TMP/faq2.json"
curl -s -b "$CK" -X POST "$HD/admin/faqs" -H 'content-type: application/json' --data-binary "@$TMP/faq2.json" >/dev/null
check "질문 없는 FAQ 거부" \
  "$(code -b "$CK" -X POST "$HD/admin/faqs" -H 'content-type: application/json' \
      -d '{"question":"","answer":"답변"}')" "400"
check "비관리자 FAQ 등록 차단" \
  "$(code -b "$U1" -X POST "$HD/admin/faqs" -H 'content-type: application/json' \
      -d '{"question":"q","answer":"a"}')" "403"

PUB="$(curl -s "$HD/faqs")"
contains "공개 FAQ 목록" "$PUB" "배송은 얼마나"
contains "분류명 포함" "$PUB" '"category_name":"배송"'
contains "분류 필터" "$(curl -s "$HD/faqs?category=delivery")" "배송은 얼마나"
absent "다른 분류는 제외" "$(curl -s "$HD/faqs?category=delivery")" "회원 탈퇴는"
# curl 은 한글을 raw 바이트로 넣어 Fastify 가 400 을 준다 (브라우저는 항상 인코딩한다).
# -G --data-urlencode 로 제대로 인코딩해 보낸다.
SEARCH="$(curl -s -G "$HD/faqs" --data-urlencode "q=탈퇴")"
contains "검색" "$SEARCH" "회원 탈퇴는"
absent "검색어 불일치 제외" "$SEARCH" "배송은 얼마나"
check "raw 한글 쿼리는 400 (브라우저는 인코딩하므로 무해)" \
  "$(code "$HD/faqs?q=탈퇴")" "400"

echo "── FAQ 조회수 · 평가"
curl -s -X POST "$HD/faqs/$F1/viewed" >/dev/null
contains "조회수 증가" "$(curl -s "$HD/faqs?category=delivery")" '"view_count":1'
contains "도움됨 반영" \
  "$(curl -s -X POST "$HD/faqs/$F1/rate" -H 'content-type: application/json' -d '{"helpful":true}')" '"counted":true'
contains "같은 IP 중복 평가 무시" \
  "$(curl -s -X POST "$HD/faqs/$F1/rate" -H 'content-type: application/json' -d '{"helpful":true}')" '"counted":false'
contains "집계 확인" "$(curl -s "$HD/faqs?category=delivery")" '"helpful_count":1'
check "없는 FAQ 평가는 404" \
  "$(code -X POST "$HD/faqs/00000000-0000-7000-8000-000000000000/rate" -H 'content-type: application/json' -d '{"helpful":true}')" "404"

echo "── FAQ 숨김 · 분류 삭제"
printf '{"question":"배송은 얼마나 걸리나요?","answer":"주문 후 2~3일 내 도착합니다.","category_id":"%s","is_visible":false}' "$NEW_CAT" > "$TMP/faqh.json"
curl -s -b "$CK" -X PUT "$HD/admin/faqs/$F1" -H 'content-type: application/json' --data-binary "@$TMP/faqh.json" >/dev/null
absent "숨긴 FAQ는 공개 목록에서 제외" "$(curl -s "$HD/faqs")" "배송은 얼마나"
contains "관리 목록에는 남음" "$(curl -s -b "$CK" "$HD/admin/faqs")" "배송은 얼마나"
curl -s -b "$CK" -X DELETE "$HD/admin/faq-categories/$NEW_CAT" >/dev/null
contains "분류를 지워도 FAQ는 남는다" "$(curl -s -b "$CK" "$HD/admin/faqs")" "배송은 얼마나"

echo "── 블록 렌더"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "FAQ 블록 등록" "$BLOCKS" "brick-helpdesk/faq"
contains "문의 블록 등록" "$BLOCKS" "brick-helpdesk/tickets"
FAQ_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-helpdesk/faq","props":{}}' | render_html)"
contains "FAQ 서버 렌더 (검색엔진이 읽는다)" "$FAQ_HTML" "회원 탈퇴는 어떻게 하나요"
contains "답변도 함께 렌더" "$FAQ_HTML" "내 정보 화면에서"
contains "JS 없이 접히는 details 사용" "$FAQ_HTML" "<details"
TK_HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-helpdesk/tickets","props":{}}' | render_html)"
absent "문의 블록은 내용을 서버 렌더하지 않음 (캐시 유출 방지)" "$TK_HTML" "비회원이 남긴 내용"
contains "문의 블록 껍데기" "$TK_HTML" "brick-help"

echo "── FAQ XSS"
curl -s -b "$CK" -X POST "$HD/admin/faqs" -H 'content-type: application/json' \
  -d '{"question":"<script>alert(1)</script> 질문","answer":"<b>굵게</b> 답변"}' >/dev/null
XHTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-helpdesk/faq","props":{}}' | render_html)"
absent "질문의 스크립트 태그 이스케이프" "$XHTML" "<script>alert(1)</script>"
contains "이스케이프된 형태로 표시" "$XHTML" "&lt;script&gt;"
contains "답변의 HTML은 허용 (관리자만 작성)" "$XHTML" "<b>굵게</b>"

echo "── 사이트맵 · robots"
ROBOTS="$(curl -s "$API/robots.txt")"
contains "robots 에 사이트맵 주소" "$ROBOTS" "Sitemap: https://help.test/sitemap.xml"
contains "관리자 경로 차단" "$ROBOTS" "Disallow: /admin"
contains "로그인 화면 차단" "$ROBOTS" "Disallow: /login"
IDX="$(curl -s "$API/sitemap.xml")"
contains "사이트맵 인덱스" "$IDX" "<sitemapindex"
contains "조각 주소가 절대 URL" "$IDX" "https://help.test/sitemap-1.xml"
S1="$(curl -s "$API/sitemap-1.xml")"
contains "홈 포함" "$S1" "<loc>https://help.test/</loc>"
contains "urlset 형식" "$S1" "<urlset"
check "없는 조각은 404" "$(code "$API/sitemap-99.xml")" "404"
check "잘못된 조각 번호는 404" "$(code "$API/sitemap-0.xml")" "404"
# FAQ 분류가 사이트맵에 들어간다
ALL_SITEMAP=""
for n in 1 2 3 4 5; do
  R="$(curl -s "$API/sitemap-$n.xml" 2>/dev/null || true)"
  [[ "$R" == *urlset* ]] && ALL_SITEMAP="$ALL_SITEMAP$R"
done
contains "FAQ 분류가 사이트맵에 포함" "$ALL_SITEMAP" "/faq?category=general"
absent "문의는 사이트맵에 없음 (비공개 콘텐츠)" "$ALL_SITEMAP" "/tickets"

echo "── 게시판·상품 사이트맵 (비밀글 유출 확인)"
for pl in brick-board brick-shop; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/admin/boards" -H 'content-type: application/json' \
  -d '{"slug":"open","title":"공개게시판","read_role":"guest","write_role":"member","allow_secret":true}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/admin/boards" -H 'content-type: application/json' \
  -d '{"slug":"members","title":"회원게시판","read_role":"member","write_role":"member"}' >/dev/null
curl -s -b "$U1" -X POST "$API/api/plugins/brick-board/boards/open/posts" -H 'content-type: application/json' \
  -d '{"title":"공개글입니다","content":"내용"}' >/dev/null
# 관리자로 쓴다 — 같은 회원이 연속으로 쓰면 게시판 도배 방지에 걸린다
# (관리자는 공지 연속 등록을 위해 예외다)
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/boards/open/posts" -H 'content-type: application/json' \
  -d '{"title":"비밀글입니다","content":"내용","isSecret":true}' >/dev/null
curl -s -b "$U1" -X POST "$API/api/plugins/brick-board/boards/members/posts" -H 'content-type: application/json' \
  -d '{"title":"회원전용글","content":"내용"}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"map-item","name":"사이트맵 상품","price":1000,"status":"selling"}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"draft-item","name":"임시 상품","price":1000,"status":"draft"}' >/dev/null

ALL2=""
for n in $(seq 1 12); do
  R="$(curl -s "$API/sitemap-$n.xml" 2>/dev/null || true)"
  [[ "$R" == *urlset* ]] && ALL2="$ALL2$R"
done
POST_ID="$(node -e '
  const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
  (async () => {
    const c = new Client(process.env.DATABASE_URL); await c.connect();
    const r = await c.query("SELECT id FROM board_posts WHERE title = $1 LIMIT 1", ["공개글입니다"]);
    console.log(r.rows[0] ? r.rows[0].id : ""); await c.end();
  })().catch(() => { console.log(""); });
')"
[[ -n "$POST_ID" && "$ALL2" == *"$POST_ID"* ]] && ok "공개 게시글이 사이트맵에 포함" || bad "공개 게시글이 사이트맵에 포함"
contains "판매중 상품 포함" "$ALL2" "/shop/map-item"
absent "임시 상품 제외" "$ALL2" "/shop/draft-item"
# 목록 API 는 비밀글 제목을 가리므로 DB 에서 직접 읽는다
SECRET_ID="$(node -e '
  const { Client } = require("'"$ROOT"'/apps/api/node_modules/pg");
  (async () => {
    const c = new Client(process.env.DATABASE_URL); await c.connect();
    const r = await c.query("SELECT id FROM board_posts WHERE is_secret = true LIMIT 1");
    console.log(r.rows[0] ? r.rows[0].id : ""); await c.end();
  })().catch(() => { console.log(""); });
')"
if [[ -n "$SECRET_ID" ]]; then
  absent "비밀글은 사이트맵에서 제외" "$ALL2" "$SECRET_ID"
else
  bad "비밀글 id 조회 실패 (검증 불가)"
fi
absent "회원 전용 게시판은 사이트맵에서 제외" "$ALL2" "/board/members/"

echo "── 최신글 모아보기 블록"
MULTI="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-board/latest-multi","props":{"boards":"open,members","columns":2}}' | render_html)"
contains "공개 게시판 상자" "$MULTI" "공개게시판"
absent "회원 전용 게시판은 제외" "$MULTI" "회원게시판"
contains "글 제목 표시" "$MULTI" "공개글입니다"
absent "비밀글 제목 미노출" "$MULTI" "비밀글입니다"
contains "더보기 링크" "$MULTI" "더보기"
EMPTY="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-board/latest-multi","props":{"boards":"nonexistent"}}' | render_html)"
contains "없는 게시판은 안내" "$EMPTY" "표시할 게시판이 없습니다"

echo "── 탈퇴 시 문의 삭제 (개인정보 포함)"
T2="$(curl -s -b "$U2" -X POST "$HD/tickets" -H 'content-type: application/json' \
  -d '{"title":"탈퇴 전 문의","content":"연락처 010-1234-5678 입니다.","category":"일반"}' | jq_get "['id']")"
[[ -n "$T2" ]] && ok "탈퇴 전 문의 접수" || bad "탈퇴 전 문의 접수"
PRE="$(curl -s -b "$U2" "$API/api/me/withdraw/preview")"
contains "탈퇴 안내에 문의 포함" "$PRE" "1:1 문의"
WD="$(curl -s -b "$U2" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
contains "문의 삭제를 알려준다" "$WD" "1:1 문의"
check "삭제된 문의는 운영자도 못 본다" "$(code -b "$CK" "$HD/tickets/$T2")" "404"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
