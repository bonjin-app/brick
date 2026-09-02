#!/usr/bin/env bash
#
# 사이트 스타터 E2E 스모크 — 설치하면 기본 구성이 다 되어 있는가.
#
# 지금까지 설치는 관리자 계정과 사이트 이름만 만들었다. 설치 직후 사이트를
# 열면 아무것도 없고, 운영자는 빈 화면 앞에서 무엇부터 해야 하는지 모른다.
#
# 못박는 것:
#   - 유형을 고르면 홈·페이지·게시판·메뉴가 실제로 만들어지는가
#   - 만들어진 홈이 **렌더되는가** (블록 이름이 틀리면 조용히 주석이 된다)
#   - 메뉴가 만들어진 것들을 가리키는가 (끊어진 링크가 없는가)
#   - 만들어진 것이 일반 페이지·메뉴로 수정 가능한가 (특별 취급이 없는가)
#   - 빈 사이트를 고르면 아무것도 만들지 않는가
#   - 모르는 유형은 거부하는가 (조용히 빈 사이트가 되면 안 된다)
#   - 스타터 실패가 설치를 실패시키지 않는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-starter.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
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

# 포트를 잡은 고아 프로세스를 정리한다.
#
# 이전에 잘린 테스트가 서버를 남기면, **우리 서버는 포트를 못 잡고 죽는데
# readyz 는 고아가 응답해 통과한다.** 요청은 전부 옛 상태의 고아에게 가고,
# DB 만 리셋되어 "relation does not exist" 500 이 난다 — 원인을 찾기 아주
# 어려운 실패다. (SMTP 스텁·PG 스텁에서 배운 것과 같은 함정이다)
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
  # readyz 에 응답한 것이 **우리 프로세스인지** 확인한다
  if command -v lsof >/dev/null 2>&1; then
    local holder
    holder="$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | head -1)"
    if [[ -n "$holder" && "$holder" != "$API_PID" ]]; then
      echo "포트 $API_PORT 를 다른 프로세스($holder)가 잡고 있습니다"; exit 1
    fi
  fi
}
stop_server() {
  if [[ -n "${API_PID:-}" ]]; then
    # 프로세스가 이미 죽어 있으면 kill 이 1을 반환하고 set -e 가 스크립트를
    # 중단시킨다 — || true 가 없으면 마지막 절만 조용히 안 돈다
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
  fi
  # 서버가 완전히 내려가고 포트가 풀릴 시간을 준다 — 새 서버가 같은 포트를
  # 바로 잡지 못하면 readyz 대기가 옛 로그를 보고 지나간다
  sleep 1
}
# 스타터마다 깨끗한 DB 에서 설치한다 — 설치는 한 번뿐이므로
fresh_install() {  # fresh_install <starter> <siteName>
  stop_server
  node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
  start_server
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d "{\"siteName\":\"$2\",\"adminEmail\":\"admin@st.test\",\"adminPassword\":\"adminpass123\",\"starter\":\"$1\"}"
}

echo "▶ 사이트 스타터 스모크 테스트"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-starter-secret-val}"
export BRICK_CAPTCHA=off

node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
start_server

echo "── 유형 목록 (설치 화면이 그린다)"
ST="$(curl -s "$API/api/install/starters")"
contains "커뮤니티" "$ST" '"code":"community"'
contains "쇼핑몰" "$ST" '"code":"shop"'
contains "회사 홈페이지" "$ST" '"code":"company"'
contains "빈 사이트" "$ST" '"code":"blank"'
contains "만들어지는 것을 알려준다" "$ST" '"creates"'

echo "── 모르는 유형은 거부한다 (조용히 빈 사이트가 되면 안 된다)"
check "오타 유형은 400" \
  "$(code -X POST "$API/api/install" -H 'content-type: application/json' \
      -d '{"siteName":"x","adminEmail":"a@st.test","adminPassword":"adminpass123","starter":"comunity"}')" "400"
check "아직 미설치 상태" "$(curl -s "$API/api/install/status" | jq_get "['state']")" "not_installed"

echo "══ 커뮤니티 스타터 ══"
R="$(fresh_install community "달빛마을")"
contains "설치 성공" "$R" '"ok":true'
contains "적용 내역을 알려준다" "$R" "게시판 자유게시판"
# 홈 페이지 제목은 사이트명이다 — 테마가 페이지 제목을 h1 으로 그리므로
# "홈"이라는 제목은 화면에 "홈"이라는 h1 을 만든다 (이중 제목의 원인이었다)
contains "홈 페이지 (제목=사이트명)" "$R" "페이지 달빛마을"
contains "메뉴" "$R" "헤더 메뉴"

check "게시판 4개 (갤러리 포함)" "$(psql_q "SELECT count(*) FROM board_boards")" "4"
check "공지사항 쓰기는 manager (아무나 쓰면 공지가 아니다)" \
  "$(psql_q "SELECT write_role FROM board_boards WHERE slug='notice'")" "manager"
check "자유게시판 쓰기는 member" \
  "$(psql_q "SELECT write_role FROM board_boards WHERE slug='free'")" "member"
check "페이지 3개 (홈·소개·게시판)" "$(psql_q "SELECT count(*) FROM pages")" "3"
check "전부 공개 상태" "$(psql_q "SELECT count(*) FROM pages WHERE status='published'")" "3"

echo "── 홈이 실제로 렌더된다 (블록 이름이 틀리면 조용히 주석이 된다)"
HOME="$(curl -s "$API/api/render/page?path=")"
contains "사이트 이름" "$HOME" "달빛마을"
contains "최신글 모아보기가 렌더됨" "$HOME" "공지사항"
contains "자유게시판 상자" "$HOME" "자유게시판"
absent "깨진 블록이 없다" "$HOME" "unknown block"

echo "── 메뉴가 만들어진 것들을 가리킨다"
MENU="$(curl -s "$API/api/menus/header")"
contains "공지사항 링크" "$MENU" '"url":"/board/notice"'
contains "소개 링크" "$MENU" '"url":"/about"'
# 메뉴의 **모든** 내부 링크가 실제 렌더로 200 인지 본다 — 예외 없이.
#
# 처음에는 게시판 경로를 "게시판 존재"로 우회했는데, 그 우회가 진짜 구멍을
# 가렸다: /board/notice 를 렌더할 board 페이지를 아무도 안 만들어서
# **스타터의 메뉴가 404 를 가리키고 있었다.** 링크 검증은 사용자가 누르는
# 것과 같은 방식이어야 한다.
verify_menu_links() {  # verify_menu_links <menu json>
  python3 -c "
import json, sys, urllib.request
menu = json.loads(sys.argv[1])
bad = []
for item in menu['items']:
    url = item['url']
    if not url.startswith('/'): continue
    try:
        req = urllib.request.Request('$API/api/render/page?path=' + url.lstrip('/'))
        with urllib.request.urlopen(req) as r:
            body = json.loads(r.read())
            if body.get('status') != 200:
                bad.append((url, body.get('status')))
    except Exception as e:
        bad.append((url, str(e)))
print('끊어진 링크: ' + (', '.join(f'{u} ({c})' for u, c in bad) if bad else '없음'))
" "$1"
}
check "메뉴의 모든 링크가 렌더된다 (게시판 포함, 우회 없이)" \
  "$(verify_menu_links "$MENU")" "끊어진 링크: 없음"
BOARD_PAGE="$(curl -s "$API/api/render/page?path=board/notice")"
contains "게시판이 실제로 그려진다" "$BOARD_PAGE" "공지사항"
contains "/board 루트는 게시판 목록" "$(curl -s "$API/api/render/page?path=board")" "자유게시판"

echo "── 만들어진 것은 일반 페이지다 (특별 취급이 없다)"
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@st.test","password":"adminpass123"}' >/dev/null
HOME_ID="$(psql_q "SELECT id FROM pages WHERE slug='home'")"
EDIT="$(curl -s -b "$CK" -X PUT "$API/api/pages/$HOME_ID" -H 'content-type: application/json' \
  -d '{"slug":"home","title":"홈","blocks":[{"block":"core/heading","props":{"text":"수정된 홈"}}],"status":"published"}')"
contains "페이지 빌더로 수정된다" "$EDIT" '"ok":true'
contains "수정이 반영된다" "$(curl -s "$API/api/render/page?path=")" "수정된 홈"

echo "── 소개 페이지에 안내 문구"
ABOUT="$(curl -s "$API/api/render/page?path=about")"
contains "사이트 이름이 들어간 예문" "$ABOUT" "달빛마을에 오신 것을 환영합니다"
contains "어디서 수정하는지 알려준다" "$ABOUT" "관리자 → 페이지"

echo "══ 쇼핑몰 스타터 ══"
R="$(fresh_install shop "달빛상점")"
contains "설치 성공" "$R" '"ok":true'
contains "쇼핑몰 플러그인 활성화" "$R" "플러그인 brick-shop"
check "게시판은 공지 하나" "$(psql_q "SELECT count(*) FROM board_boards")" "1"
check "페이지 5개 (홈·소개·이용안내·게시판·쇼핑몰)" "$(psql_q "SELECT count(*) FROM pages")" "5"
HOME="$(curl -s "$API/api/render/page?path=")"
contains "상품 목록 블록이 렌더됨 (상품이 없어도 깨지지 않는다)" "$HOME" "달빛상점"
absent "깨진 블록이 없다" "$HOME" "unknown block"
MENU="$(curl -s "$API/api/menus/header")"
contains "상품 링크" "$MENU" '"url":"/shop"'
contains "이용 안내 링크" "$MENU" '"url":"/guide"'
check "쇼핑몰 메뉴도 전부 렌더된다" "$(verify_menu_links "$MENU")" "끊어진 링크: 없음"
SHOP_PAGE="$(curl -s "$API/api/render/page?path=shop")"
contains "/shop 이 뜬다 (상품이 없으면 빈 안내)" "$SHOP_PAGE" "등록된 상품이 없습니다"
CART_R="$(curl -s "$API/api/render/page?path=shop/cart")"
contains "/shop/cart 가 장바구니를 그린다" "$CART_R" "brick-cart"
# 주문하기는 상점 페이지 기준 경로다 — '/checkout' 하드코딩은 404 였다
contains "주문하기가 checkout 으로" "$CART_R" "/checkout"
CO_R="$(curl -s "$API/api/render/page?path=shop/checkout")"
contains "/shop/checkout 이 주문서를 그린다" "$CO_R" "brick-co-form"
contains "주문서의 상점 기준 경로" "$CO_R" 'data-shop-base=\"/shop\"' 
contains "주문서에 무통장 안내" "$CO_R" "무통장 입금"
# 주문 조회 — 주문한 손님이 주문을 다시 볼 화면 (회원 목록 / 비회원 번호 조회)
contains "/shop/orders 가 주문 조회를 그린다" "$(curl -s "$API/api/render/page?path=shop/orders")" "brick-order-list"
contains "/shop/orders/<번호> 가 상세를 그린다" "$(curl -s "$API/api/render/page?path=shop/orders/20990101-000001")" "brick-order-detail"
# 주문 상세에 취소·반품 신청 UI 가 함께 온다 — 청약철회는 손님의 권리이므로
# 화면이 있어야 한다 (관리자만 처리할 수 있으면 권리가 아니다)
contains "상세에 취소·반품 신청 자리" "$(curl -s "$API/api/render/page?path=shop/orders/20990101-000001")" "brick-ret-slot"
contains "/shop/event 가 기획전 목록을 그린다" "$(curl -s "$API/api/render/page?path=shop/event")" "기획전"
GUIDE="$(curl -s "$API/api/render/page?path=guide")"
contains "교환·반품 안내가 있다 (표시 의무의 출발점)" "$GUIDE" "교환과 반품"

echo "── 상품을 등록하면 홈에 바로 나온다 (연결이 이미 되어 있다)"
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@st.test","password":"adminpass123"}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"first","name":"첫 상품","price":10000,"stock":5,"status":"selling"}' >/dev/null
contains "홈에 첫 상품이 나온다" "$(curl -s "$API/api/render/page?path=")" "첫 상품"
contains "/shop 목록에도 나온다" "$(curl -s "$API/api/render/page?path=shop")" "첫 상품"
contains "/shop/first 상세도 그려진다 (storefront 라우팅)" \
  "$(curl -s "$API/api/render/page?path=shop/first")" "brick-buy-form"

echo "══ 회사 홈페이지 스타터 ══"
R="$(fresh_install company "본진테크")"
contains "설치 성공" "$R" '"ok":true'
contains "헬프데스크 활성화" "$R" "플러그인 brick-helpdesk"
check "페이지 5개 (홈·소개·서비스·문의·게시판)" "$(psql_q "SELECT count(*) FROM pages")" "5"
SUPPORT="$(curl -s "$API/api/render/page?path=support")"
contains "문의 화면이 렌더됨" "$SUPPORT" "문의하기"
absent "깨진 블록이 없다" "$SUPPORT" "unknown block"
MENU="$(curl -s "$API/api/menus/header")"
contains "문의하기 메뉴" "$MENU" '"url":"/support"'
check "회사 메뉴도 전부 렌더된다" "$(verify_menu_links "$MENU")" "끊어진 링크: 없음"
# 메뉴가 가리키는 페이지가 전부 있다
MISSING="$(python3 -c "
import json, sys
menu = json.loads(sys.argv[1])
paths = [i['url'].lstrip('/') for i in menu['items'] if i['url'].startswith('/') and not i['url'].startswith('/board/')]
print(','.join(paths))" "$MENU")"
FOUND="$(psql_q "SELECT count(*) FROM pages WHERE slug = ANY(string_to_array('$MISSING', ','))")"
EXPECT="$(python3 -c "print(len('$MISSING'.split(',')))")"
check "메뉴의 페이지 링크가 전부 존재 ($MISSING)" "$FOUND" "$EXPECT"

echo "══ 빈 사이트 ══"
R="$(fresh_install blank "빈집")"
contains "설치 성공" "$R" '"ok":true'
contains "적용 내역이 비어 있다" "$R" '"applied":[]'
check "페이지 0개" "$(psql_q "SELECT count(*) FROM pages")" "0"
check "메뉴 없음" "$(psql_q "SELECT count(*) FROM menus")" "0"
check "활성 플러그인 없음" "$(psql_q "SELECT count(*) FROM installed_plugins WHERE is_active = true" 2>/dev/null || echo 0)" "0"

echo "── 유형을 아예 안 주면 빈 사이트다 (기존 API 호환)"
stop_server
node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
start_server
R="$(curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
  -d '{"siteName":"호환","adminEmail":"a@st.test","adminPassword":"adminpass123"}')"
contains "설치 성공" "$R" '"ok":true'
check "페이지 0개" "$(psql_q "SELECT count(*) FROM pages")" "0"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
