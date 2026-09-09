#!/usr/bin/env bash
#
# 사업자정보 표시 · 위시리스트 · 최근 본 상품 · 지역별 배송비 E2E 스모크.
#
# 못박는 것:
#   - 사업자정보가 **공개**로 조회되는가 (관리자만 보면 표시 의무가 아니다)
#   - 사업자등록번호 체크섬이 실제로 검증되는가 (오타가 통과하면 안 된다)
#   - 테마 푸터에 실제로 렌더되는가
#   - 위시리스트가 비회원에게도 되는가, 로그인 시 이어받는가
#   - 남의 위시리스트가 보이지 않는가
#   - 지역 추가비가 **실제 주문 금액**에 반영되는가 (표시만 하고 안 받으면 손해)
#
# 주의: 변수 이름에 HOME 을 쓰지 않는다 — 환경변수 $HOME 을 큰 HTML 로 덮으면
#       node 가 OpenSSL 설정 파일의 $HOME 확장에서 "variable expansion too long" 으로 죽는다.
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-storefront.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

# DB 를 직접 바꾼 뒤에는 렌더 캐시를 비워야 한다 — 상품 목록은 비로그인 렌더라 캐시에 들어가고,
# psql 로 고친 값은 무효화 훅을 거치지 않는다(옛 HTML 을 검사해 엉뚱한 결과가 나왔다).
bust_cache() { curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{}' -o /dev/null; sleep 0.3; }

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

echo "▶ 사업자정보 · 위시리스트 · 지역 배송비 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-store-secret-value}"
export BRICK_CAPTCHA=off

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
    -d '{"siteName":"스토어","adminEmail":"admin@st.test","adminPassword":"adminpass123","starter":"shop"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@st.test","password":"adminpass123"}' >/dev/null
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'

for n in 1 2; do
  printf '{"email":"s%s@st.test","password":"password123",%s"displayName":"고객%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"s%s@st.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/c$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
C1="$TMP/c1.txt"; C2="$TMP/c2.txt"

echo "══ 사업자정보 (전자상거래법 제13조) ══"
INIT="$(curl -s "$API/api/business-info")"
contains "비어 있어도 조회 가능 (설치 직후)" "$INIT" '"commerceReady":false'
contains "빠진 항목을 알려준다" "$INIT" '"missing":['
contains "항목 라벨 제공" "$INIT" '"businessNo":"사업자등록번호"'
check "비관리자는 수정 불가" \
  "$(code -X PUT "$API/api/business-info" -H 'content-type: application/json' -d '{"companyName":"침입"}')" "401"

echo "── 사업자등록번호 체크섬 (오타가 통과하면 안 된다)"
check "체크섬 틀린 번호 거부" \
  "$(code -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
      -d '{"companyName":"테스트","businessNo":"123-45-67890"}')" "400"
contains "무엇이 잘못됐는지 알려준다" \
  "$(curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
      -d '{"companyName":"테스트","businessNo":"123-45-67890"}')" "사업자등록번호가 올바르지 않습니다"
check "자리수 부족 거부" \
  "$(code -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
      -d '{"businessNo":"123-45"}')" "400"
check "전부 0 거부 (칸만 채우는 것)" \
  "$(code -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
      -d '{"businessNo":"000-00-00000"}')" "400"
check "잘못된 이메일 거부" \
  "$(code -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
      -d '{"email":"not-an-email"}')" "400"

echo "── 정상 저장"
cat > "$TMP/biz.json" <<'JSON'
{"companyName":"본진주식회사","representative":"홍길동","businessNo":"2208162517",
 "mailOrderNo":"제2026-서울강남-01234호","address":"서울특별시 강남구 테헤란로 1",
 "phone":"02-1234-5678","email":"help@bonjin.test",
 "privacyOfficer":"김보호","hostingProvider":"본진클라우드",
 "escrow":"결제대금예치 가입 (본진에스크로)"}
JSON
SAVE="$(curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' --data-binary "@$TMP/biz.json")"
contains "저장 성공" "$SAVE" '"ok":true'
contains "쇼핑몰 개설 가능 상태" "$SAVE" '"commerceReady":true'
GET="$(curl -s "$API/api/business-info")"
contains "하이픈 없이 넣어도 형식을 맞춰준다" "$GET" '"businessNo":"220-81-62517"'
contains "통신판매업 신고번호" "$GET" "제2026-서울강남-01234호"
contains "개인정보 보호책임자" "$GET" "김보호"
contains "호스팅 제공자" "$GET" "본진클라우드"
# 전자상거래법 제24조 — 결제대금예치·소비자피해보상보험 가입 사실 표시
contains "결제대금예치 안내" "$GET" "본진에스크로"
contains "항목 라벨을 준다" "$(curl -s -b "$CK" "$API/api/business-info")" "결제대금예치·피해보상보험"

echo "── 일부만 채우면 경고 (표시 의무를 절반만 지킨 상태)"
PARTIAL="$(curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
  -d '{"companyName":"부분입력","representative":"대표"}')"
contains "빠진 항목을 경고로 알려준다" "$PARTIAL" "전자상거래법 제13조"
contains "개인정보 보호책임자 안내" "$PARTIAL" "개인정보보호법 제31조"
contains "쇼핑몰 개설 불가 상태" "$PARTIAL" '"commerceReady":false'
# 원복
curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' --data-binary "@$TMP/biz.json" >/dev/null

echo "── 테마 푸터에 실제로 렌더되는가"
HOME_HTML="$(curl -s "$API/api/render/page?path=")"
contains "상호 렌더" "$HOME_HTML" "본진주식회사"
contains "사업자등록번호 렌더" "$HOME_HTML" "220-81-62517"
contains "통신판매업 신고번호 렌더" "$HOME_HTML" "제2026-서울강남-01234호"
contains "대표자 렌더" "$HOME_HTML" "홍길동"
contains "전화번호 렌더" "$HOME_HTML" "02-1234-5678"
contains "전용 영역으로 감싸짐" "$HOME_HTML" "brick-business"
contains "에스크로 안내가 화면에 나온다 (표시 의무)" "$HOME_HTML" "본진에스크로"
# 값이 없으면 라벨만 남지 않아야 한다
curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
  -d '{"companyName":"이름만있음"}' >/dev/null
ONLY="$(curl -s "$API/api/render/page?path=")"
contains "채운 항목은 렌더" "$ONLY" "이름만있음"
absent "빈 항목의 라벨은 렌더되지 않음" "$ONLY" "통신판매업신고 <"
absent "빈 대표자 라벨 없음" "$ONLY" "대표 </span>"
# 전부 비우면 영역 자체가 사라진다
curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' -d '{}' >/dev/null
EMPTY="$(curl -s "$API/api/render/page?path=")"
absent "전부 비면 영역이 사라짐" "$EMPTY" "brick-business"
contains "Brick 크레딧은 남음" "$EMPTY" "Powered by"
curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' --data-binary "@$TMP/biz.json" >/dev/null

echo "── 화면마다 제 이름을 가진다 (장바구니가 \"쇼핑몰\"이면 안 된다)"
# 이 수트는 스타터 없이 설치하므로 상점 라우터 페이지를 직접 만든다
printf '{"slug":"shop","title":"쇼핑몰","status":"published","blocks":[{"block":"brick-shop/storefront","props":{}}]}' > "$TMP/shop-page.json"
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  --data-binary "@$TMP/shop-page.json" -o /dev/null
# /api/render/page 는 HTML 을 JSON 으로 감싸 준다
sf_render() {
  curl -s "$API/api/render/page?path=$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))"
}
# 담은 다음에 갈 곳이 헤더에 있어야 한다 — 비회원도 담으므로 로그인 전에도
contains "헤더에 장바구니 링크" "$(sf_render "")" '<a href="/shop/cart"><svg class="brick-ico" aria-hidden="true"><use href="#i-cart"></use></svg><span>장바구니</span></a>'

CART_PAGE="$(sf_render "shop/cart")"
contains "장바구니의 문서 제목" "$CART_PAGE" "<title>장바구니 —"
contains "장바구니에도 화면 제목이 있다" "$CART_PAGE" "<h1>장바구니</h1>"
absent "라우터 페이지 제목이 새지 않는다" "$CART_PAGE" "<h1>쇼핑몰</h1>"
WISH_PAGE="$(sf_render "shop/wishlist")"
contains "위시리스트 문서 제목" "$WISH_PAGE" "<title>위시리스트 —"
ORDERS_PAGE="$(sf_render "shop/orders")"
contains "주문 내역 문서 제목" "$ORDERS_PAGE" "<title>주문 내역 —"

echo "══ 위시리스트 ══"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"wish-item","name":"위시 상품","price":20000,"stock":10,"status":"selling"}' | jq_get "['id']")"
PID2="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"wish-item2","name":"두번째 위시","price":30000,"stock":0,"status":"soldout"}' | jq_get "['id']")"
PID3="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"draft-wish","name":"임시 상품","price":1000,"status":"draft"}' | jq_get "['id']")"
[[ -n "$PID" && -n "$PID2" ]] && ok "상품 등록" || bad "상품 등록"

echo "── 비회원도 담을 수 있다 (로그인 요구하면 아무도 안 쓴다)"
printf '{"productId":"%s"}' "$PID" > "$TMP/w1.json"
GADD="$(curl -s -X POST "$SHOP/wishlist" -H 'content-type: application/json' --data-binary "@$TMP/w1.json")"
GT="$(echo "$GADD" | jq_get "['guestToken']")"
[[ -n "$GT" ]] && ok "비회원 토큰 발급" || bad "비회원 토큰 발급"
contains "담기 성공" "$GADD" '"added":true'
contains "비회원 목록 조회" "$(curl -s "$SHOP/wishlist?guest=$GT")" "위시 상품"
# 두 번 눌러도 오류가 아니다
printf '{"productId":"%s","guestToken":"%s"}' "$PID" "$GT" > "$TMP/w1again.json"
AGAIN="$(curl -s -X POST "$SHOP/wishlist" -H 'content-type: application/json' --data-binary "@$TMP/w1again.json")"
contains "이미 담긴 상품은 조용히 넘어감" "$AGAIN" '"added":false'
COUNT="$(psql_q "SELECT count(*) FROM shop_wishlist WHERE guest_token='$GT'")"
check "중복 행이 생기지 않음" "$COUNT" "1"
check "없는 상품 담기 차단" \
  "$(code -X POST "$SHOP/wishlist" -H 'content-type: application/json' \
      -d '{"productId":"00000000-0000-7000-8000-000000000000"}')" "404"
printf '{"productId":"%s","guestToken":"%s"}' "$PID3" "$GT" > "$TMP/wdraft.json"
check "임시 상품 담기 차단" \
  "$(code -X POST "$SHOP/wishlist" -H 'content-type: application/json' --data-binary "@$TMP/wdraft.json")" "404"
check "상품 없이 담기 차단" \
  "$(code -X POST "$SHOP/wishlist" -H 'content-type: application/json' -d '{}')" "400"

echo "── 품절 표시 (담아둔 뒤 품절될 수 있다)"
printf '{"productId":"%s","guestToken":"%s"}' "$PID2" "$GT" > "$TMP/w2.json"
curl -s -X POST "$SHOP/wishlist" -H 'content-type: application/json' --data-binary "@$TMP/w2.json" >/dev/null
WL="$(curl -s "$SHOP/wishlist?guest=$GT")"
contains "품절 상품도 목록에 남음" "$WL" "두번째 위시"
contains "품절 표시" "$WL" '"soldout":true'
contains "판매중은 품절 아님" "$WL" '"soldout":false'

echo "── 하트 상태 조회 (목록 화면이 한 번에 물어본다)"
CHECK="$(curl -s "$SHOP/wishlist/check?guest=$GT&ids=$PID,$PID2,$PID3")"
contains "담은 상품 포함" "$CHECK" "$PID"
absent "담지 않은 상품 제외" "$CHECK" "$PID3"
contains "소유자 없으면 빈 목록" "$(curl -s "$SHOP/wishlist/check?ids=$PID")" '"ids":[]'

echo "── 남의 위시리스트는 보이지 않는다"
printf '{"productId":"%s"}' "$PID" > "$TMP/wc1.json"
curl -s -b "$C1" -X POST "$SHOP/wishlist" -H 'content-type: application/json' --data-binary "@$TMP/wc1.json" >/dev/null
C1_LIST="$(curl -s -b "$C1" "$SHOP/wishlist")"
contains "고객1 목록" "$C1_LIST" "위시 상품"
C2_LIST="$(curl -s -b "$C2" "$SHOP/wishlist")"
contains "고객2 목록은 비어 있음" "$C2_LIST" '"total":0'
contains "소유자 정보 없으면 빈 목록 (전체 노출 방지)" "$(curl -s "$SHOP/wishlist")" '"total":0'

echo "── 삭제"
contains "삭제" "$(curl -s -b "$C1" -X DELETE "$SHOP/wishlist/$PID")" '"ok":true'
contains "삭제 후 비어 있음" "$(curl -s -b "$C1" "$SHOP/wishlist")" '"total":0'
contains "없는 상품 삭제도 성공 (멱등)" "$(curl -s -b "$C1" -X DELETE "$SHOP/wishlist/$PID")" '"ok":true'

echo "── 로그인 시 비회원 것을 이어받는다"
BEFORE="$(psql_q "SELECT count(*) FROM shop_wishlist WHERE guest_token='$GT'")"
check "비회원 위시리스트 2건" "$BEFORE" "2"
printf '{"guestToken":"%s"}' "$GT" > "$TMP/merge.json"
MERGE="$(curl -s -b "$C1" -X POST "$SHOP/wishlist/merge" -H 'content-type: application/json' --data-binary "@$TMP/merge.json")"
contains "2건 이어받음" "$MERGE" '"merged":2'
AFTER="$(psql_q "SELECT count(*) FROM shop_wishlist WHERE guest_token='$GT'")"
check "비회원 기록은 정리됨" "$AFTER" "0"
contains "회원 목록에 이어짐" "$(curl -s -b "$C1" "$SHOP/wishlist")" '"total":2'
check "비로그인은 이어받기 불가" \
  "$(code -X POST "$SHOP/wishlist/merge" -H 'content-type: application/json' --data-binary "@$TMP/merge.json")" "401"
contains "토큰 없으면 0건" \
  "$(curl -s -b "$C2" -X POST "$SHOP/wishlist/merge" -H 'content-type: application/json' -d '{}')" '"merged":0'

echo "══ 최근 본 상품 ══"
# 상품 상세를 보면 기록된다
curl -s -b "$C2" "$SHOP/products/wish-item" >/dev/null
curl -s -b "$C2" "$SHOP/products/wish-item2" >/dev/null
RECENT="$(curl -s -b "$C2" "$SHOP/recent-views")"
contains "최근 본 상품 기록" "$RECENT" "위시 상품"
contains "두 번째도 기록" "$RECENT" "두번째 위시"
RCOUNT="$(psql_q "SELECT count(*) FROM shop_recent_views rv JOIN users u ON u.id=rv.user_id WHERE u.email='s2@st.test'")"
check "2건 기록" "$RCOUNT" "2"
# 같은 상품을 다시 보면 행이 늘지 않고 시각만 갱신된다
curl -s -b "$C2" "$SHOP/products/wish-item" >/dev/null
RCOUNT2="$(psql_q "SELECT count(*) FROM shop_recent_views rv JOIN users u ON u.id=rv.user_id WHERE u.email='s2@st.test'")"
check "다시 봐도 2건 (행이 쌓이지 않음)" "$RCOUNT2" "2"
FIRST="$(curl -s -b "$C2" "$SHOP/recent-views" | python3 -c "
import sys,json;print(json.load(sys.stdin)['items'][0]['name'])" 2>/dev/null || echo "")"
check "가장 최근에 본 것이 먼저" "$FIRST" "위시 상품"
contains "소유자 없으면 빈 목록" "$(curl -s "$SHOP/recent-views")" '"items":[]'

echo "══ 지역별 배송비 ══"
ZONES="$(curl -s -b "$CK" "$SHOP/admin/shipping-zones")"
contains "기본 구간 심어짐 (제주)" "$ZONES" "제주"
contains "울릉도 구간" "$ZONES" "울릉도"
contains "관리 리소스 등록" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"name":"shipping-zones"'
check "비관리자 접근 차단" "$(code "$SHOP/admin/shipping-zones")" "403"

echo "── 우편번호 조회"
contains "제주 우편번호 → 추가비" "$(curl -s "$SHOP/shipping-zone?postcode=63000")" '"extraFee":3000'
contains "제주 구간 끝" "$(curl -s "$SHOP/shipping-zone?postcode=63644")" '"extraFee":3000'
contains "구간 밖은 0원" "$(curl -s "$SHOP/shipping-zone?postcode=06236")" '"extraFee":0'
contains "울릉도는 5000원" "$(curl -s "$SHOP/shipping-zone?postcode=40200")" '"extraFee":5000'
contains "잘못된 우편번호는 0원" "$(curl -s "$SHOP/shipping-zone?postcode=abc")" '"extraFee":0'
contains "우편번호 없으면 0원" "$(curl -s "$SHOP/shipping-zone")" '"extraFee":0'

echo "── 구간 관리 검증"
check "우편번호 5자리 아니면 거부" \
  "$(code -b "$CK" -X POST "$SHOP/admin/shipping-zones" -H 'content-type: application/json' \
      -d '{"name":"테스트","postcode_from":"123","postcode_to":"456","extra_fee":1000}')" "400"
check "시작이 끝보다 크면 거부" \
  "$(code -b "$CK" -X POST "$SHOP/admin/shipping-zones" -H 'content-type: application/json' \
      -d '{"name":"역순","postcode_from":"99999","postcode_to":"11111","extra_fee":1000}')" "400"
check "음수 배송비 거부" \
  "$(code -b "$CK" -X POST "$SHOP/admin/shipping-zones" -H 'content-type: application/json' \
      -d '{"name":"음수","postcode_from":"11111","postcode_to":"22222","extra_fee":-100}')" "400"
check "지역명 없으면 거부" \
  "$(code -b "$CK" -X POST "$SHOP/admin/shipping-zones" -H 'content-type: application/json' \
      -d '{"name":"","postcode_from":"11111","postcode_to":"22222","extra_fee":100}')" "400"
# 겹치는 구간은 비싼 쪽이 적용된다 (겹친 것은 실수일 가능성이 높다)
NEWZ="$(curl -s -b "$CK" -X POST "$SHOP/admin/shipping-zones" -H 'content-type: application/json' \
  -d '{"name":"제주 특정지역","postcode_from":"63100","postcode_to":"63200","extra_fee":6000}' | jq_get "['id']")"
[[ -n "$NEWZ" ]] && ok "구간 추가" || bad "구간 추가"
contains "겹치면 비싼 쪽 적용 (덜 받으면 사업자 손해)" "$(curl -s "$SHOP/shipping-zone?postcode=63150")" '"extraFee":6000'
contains "겹치지 않는 곳은 원래 값" "$(curl -s "$SHOP/shipping-zone?postcode=63000")" '"extraFee":3000'
contains "구간 수정" \
  "$(curl -s -b "$CK" -X PUT "$SHOP/admin/shipping-zones/$NEWZ" -H 'content-type: application/json' \
      -d '{"name":"제주 특정지역","postcode_from":"63100","postcode_to":"63200","extra_fee":1000,"is_active":false}')" '"ok":true'
contains "비활성 구간은 적용되지 않음" "$(curl -s "$SHOP/shipping-zone?postcode=63150")" '"extraFee":3000'
contains "구간 삭제" "$(curl -s -b "$CK" -X DELETE "$SHOP/admin/shipping-zones/$NEWZ")" '"ok":true'

echo "── 견적과 주문에 실제로 반영되는가 (표시만 하고 안 받으면 손해)"
printf '{"items":[{"productId":"%s","quantity":1}],"postcode":"63000"}' "$PID" > "$TMP/q_jeju.json"
QJ="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q_jeju.json")"
contains "지역비가 별도 항목으로 (합치면 항의가 들어온다)" "$QJ" '"zoneFee":3000'
contains "지역명 표시" "$QJ" '"zoneName":"제주"'
contains "총액에 포함 (20000+3000+3000)" "$QJ" '"total":26000'
printf '{"items":[{"productId":"%s","quantity":1}],"postcode":"06236"}' "$PID" > "$TMP/q_seoul.json"
QS="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q_seoul.json")"
contains "서울은 지역비 없음" "$QS" '"zoneFee":0'
contains "총액 23000" "$QS" '"total":23000'

# 무료배송 기준을 넘겨도 지역 추가비는 붙는다
printf '{"items":[{"productId":"%s","quantity":3}],"postcode":"63000"}' "$PID" > "$TMP/q_free.json"
QF="$(curl -s -X POST "$SHOP/quote" -H 'content-type: application/json' --data-binary "@$TMP/q_free.json")"
contains "무료배송이어도 지역비는 붙는다 (실제 발생 비용)" "$QF" '"shippingFee":0'
contains "지역비 유지" "$QF" '"zoneFee":3000'
contains "총액 63000" "$QF" '"total":63000'

echo "── 주문에 기록되는가"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"고객1","ordererPhone":"010-1111-2222","postcode":"63000","address1":"제주시"}}' "$PID" > "$TMP/order_jeju.json"
NOJ="$(curl -s -b "$C1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/order_jeju.json" | jq_get "['orderNo']")"
[[ -n "$NOJ" ]] && ok "제주 배송 주문" || bad "제주 배송 주문"
AMT="$(psql_q "SELECT shipping_fee, zone_fee, zone_name, total FROM shop_orders WHERE order_no='$NOJ'")"
check "주문에 지역비 저장 (3000|3000|제주|26000)" "$AMT" "3000|3000|제주|26000"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"고객1","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울시"}}' "$PID" > "$TMP/order_seoul.json"
NOS="$(curl -s -b "$C1" -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/order_seoul.json" | jq_get "['orderNo']")"
AMT2="$(psql_q "SELECT zone_fee, total FROM shop_orders WHERE order_no='$NOS'")"
check "서울 주문은 지역비 0 (23000)" "$AMT2" "0|23000"

echo
echo "── 상품 목록 페이지 나누기 (limit 를 넘는 상품에 닿을 수 있는가)"
# 상품을 limit 보다 많이 만든다 — 전에는 25번째 상품부터 사이트에 있어도 볼 방법이 없었다
node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
const { randomUUID } = require('crypto');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (let i = 1; i <= 30; i++) {
    await c.query(
      \"INSERT INTO shop_products (id, slug, name, description, price, stock, status, sort_order) \" +
      \"VALUES (\$1, \$2, \$3, '', \$4, 10, 'selling', \$5) ON CONFLICT (slug) DO NOTHING\",
      [randomUUID(), 'pg' + String(i).padStart(2, '0'), '쪽나눔 ' + i, 1000 * i, 500 + i],
    );
  }
  await c.end();
})();
" 2>/dev/null
bust_cache
count_cards() { /usr/bin/python3 -c "
import sys, re
print(len(re.findall(r'brick-product-name\">', sys.stdin.read())))
"; }
PAGE1="$(sf_render "shop")"
check "1쪽은 limit(24)만큼" "$(echo "$PAGE1" | count_cards)" "24"
contains "총 개수를 알려준다" "$PAGE1" 'class="brick-shop-total">'
contains "페이저가 나온다 (게시판과 같은 프리미티브)" "$PAGE1" 'class="brick-pager"'
contains "다음 쪽 링크" "$PAGE1" 'href="/shop?page=2"'
PAGE2="$(sf_render "shop&page=2")"
[[ "$(echo "$PAGE2" | count_cards)" -gt 0 ]] && ok "2쪽에 나머지 상품이 있다" || bad "2쪽에 나머지 상품이 있다"
contains "2쪽에서 현재 위치 표시" "$PAGE2" "<strong>2</strong>"
contains "1쪽 링크에는 page 를 붙이지 않는다 (정규 주소)" "$PAGE2" 'href="/shop">1</a>'
# 1쪽과 2쪽의 상품이 겹치지 않아야 한다 — OFFSET 이 틀리면 같은 상품을 두 번 보여준다
FIRST1="$(echo "$PAGE1" | /usr/bin/python3 -c "
import sys, re
m = re.findall(r'brick-product-name\">([^<]+)', sys.stdin.read())
print(m[0] if m else '')
")"
FIRST2="$(echo "$PAGE2" | /usr/bin/python3 -c "
import sys, re
m = re.findall(r'brick-product-name\">([^<]+)', sys.stdin.read())
print(m[0] if m else '')
")"
[[ -n "$FIRST1" && "$FIRST1" != "$FIRST2" ]] && ok "쪽마다 다른 상품 ($FIRST1 / $FIRST2)" || bad "쪽마다 다른 상품 ($FIRST1 / $FIRST2)"
# 없는 쪽을 요청하면 마지막 쪽 (빈 화면보다 낫다 — 주소를 손으로 고친 경우)
contains "없는 쪽은 마지막 쪽으로" "$(sf_render "shop&page=999")" 'class="brick-pager"'
# 정렬과 함께 쓸 수 있다
SORT_PAGE="$(sf_render "shop&sort=price_desc")"
contains "페이저 링크가 정렬을 유지한다" "$SORT_PAGE" 'sort=price_desc&amp;page=2'
contains "정렬 링크는 쪽을 1 로 되돌린다" "$(sf_render "shop&sort=recent&page=2")" 'href="/shop?sort=popular"'
# 홈의 진열 섹션에는 페이저가 없다 (limit 만큼 보여주고 끝)
absent "홈에는 페이저가 없다" "$(sf_render "&page=2")" 'class="brick-pager"'
absent "홈에는 총 개수도 없다" "$(sf_render "&page=2")" 'class="brick-shop-total">'

echo "── 상품 정렬 (손님이 고른다 · 링크라 주소가 공유된다)"
psql_q "UPDATE shop_products SET sold_count = 40 WHERE slug = 'sample-tote'" >/dev/null
bust_cache
SORT_DEFAULT="$(sf_render "shop")"
contains "목록 화면에 정렬 막대" "$SORT_DEFAULT" 'class="brick-sort"'
contains "기본은 신상품순" "$SORT_DEFAULT" 'class="is-on" aria-current="true">신상품순'
contains "네 가지 정렬" "$SORT_DEFAULT" 'sort=price_desc'
names_of() { /usr/bin/python3 -c "
import sys, re
print(','.join(re.findall(r'brick-product-name\">([^<]+)', sys.stdin.read())))
"; }
ORDER_ASC="$(sf_render "shop&sort=price_asc" | names_of)"
ORDER_DESC="$(sf_render "shop&sort=price_desc" | names_of)"
[[ -n "$ORDER_ASC" && "$ORDER_ASC" != "$ORDER_DESC" ]] && ok "가격 오름/내림 순서가 다르다" || bad "가격 오름/내림 순서가 다르다 ($ORDER_ASC vs $ORDER_DESC)"
contains "인기순은 많이 팔린 것이 먼저" "$(sf_render "shop&sort=popular" | names_of)" "캔버스 토트백 (샘플),"
contains "고른 정렬이 표시된다" "$(sf_render "shop&sort=price_asc")" 'class="is-on" aria-current="true">낮은 가격순'
# 모르는 값은 기본으로 — 주소를 손으로 고쳐도 깨지지 않는다
contains "모르는 정렬 값은 기본으로" "$(sf_render "shop&sort=../etc")" 'class="is-on" aria-current="true">신상품순'
# 홈의 진열 섹션은 운영자가 정한 순서를 지킨다 (sortable 이 꺼져 있다)
absent "홈의 진열 섹션에는 정렬 막대가 없다" "$(sf_render "&sort=price_desc")" 'class="brick-sort"'
# 다른 쿼리는 유지하고 page 는 버린다 (정렬을 바꾸면 1페이지가 맞다)
SORT_LINKS="$(sf_render "shop&category=none&page=3")"
contains "정렬 링크가 분류를 유지한다" "$SORT_LINKS" 'href="/shop?category=none&amp;sort=recent"'
absent "정렬 링크에 page 는 남기지 않는다" "$SORT_LINKS" 'page=3&amp;sort'
contains "빈 결과에도 막대가 남는다 (되돌릴 수단)" "$SORT_LINKS" 'class="brick-sort"'

echo "── 가격대로 좁히기 (눈금을 상품 값에서 만든다)"
# 위에서 1,000~30,000원 상품 30개 + 샘플(12,000·19,000·28,000)을 넣었다.
# 폭 29,000 → 눈금 10,000 → "10,000원 미만 / 10,000~20,000 / 20,000원 이상"이 기대값이다.
# 값을 빈칸으로 둘러 내보낸다 — "9,000" 은 "19,000" 의 부분문자열이라 그냥 찾으면 늘 맞는다
prices_of() { /usr/bin/python3 -c "
import sys, re
h = sys.stdin.read()
print(' ' + ' '.join(m + '원' for m in re.findall(r'<strong>([0-9,]+)원</strong>', h)) + ' ')
"; }
# 기대 개수는 DB 에 물어본다 — 위 절들이 상품을 더 넣을 수 있으므로 숫자를 박으면 곧 썩는다
band_count() { psql_q "SELECT count(*) FROM shop_products WHERE status IN ('selling','soldout') AND $1"; }
FILTER_PAGE="$(sf_render "shop")"
contains "목록 화면에 가격 막대" "$FILTER_PAGE" 'class="brick-filter"'
contains "기본은 전체" "$FILTER_PAGE" 'class="is-on" aria-current="true">전체'
contains "눈금이 사람이 읽는 값이다 (미만)" "$FILTER_PAGE" '>10,000원 미만 ('
contains "가운데 구간" "$FILTER_PAGE" '>10,000원 ~ 20,000원 ('
contains "마지막은 열린 구간 (이상)" "$FILTER_PAGE" '>20,000원 이상 ('
absent "홈의 진열 섹션에는 가격 막대가 없다" "$(sf_render "")" 'class="brick-filter"'

# 좁히면 그 가격대만 남는다 — 상한은 **미만**이다(막대 문구와 결과가 같은 뜻이어야 한다)
MID="$(sf_render "shop&min=10000&max=20000")"
MID_PRICES="$(echo "$MID" | prices_of)"
MID_N="$(band_count "price >= 10000 AND price < 20000")"
OVER_N="$(band_count "price >= 20000")"
contains "고른 구간이 표시된다" "$MID" 'class="is-on" aria-current="true">10,000원 ~ 20,000원'
contains "경계 바로 아래는 포함" "$MID_PRICES" " 19,000원 "
contains "하한은 포함" "$MID_PRICES" " 10,000원 "
absent "상한은 미만 — 20,000원은 빠진다" "$MID_PRICES" " 20,000원 "
absent "구간 밖(9,000원)은 빠진다" "$MID_PRICES" " 9,000원 "
contains "총 개수가 좁힌 결과를 따른다" "$MID" ">총 ${MID_N}개<"
contains "구간별 개수도 보여 준다" "$MID" ">10,000원 ~ 20,000원 (${MID_N})<"
# 열린 구간
OVER="$(sf_render "shop&min=20000")"
contains "이상 구간도 좁혀진다" "$OVER" ">총 ${OVER_N}개<"
absent "이상 구간에 그 아래 상품이 없다" "$(echo "$OVER" | prices_of)" " 19,000원 "

# 링크 규칙 — 정렬과 같은 규칙을 쓴다(현재 쿼리를 유지하고 page 만 버린다)
contains "가격대 링크가 정렬을 유지한다" "$(sf_render "shop&sort=price_desc")" 'sort=price_desc&amp;min=20000'
absent "가격대 링크는 쪽을 1 로 되돌린다" "$(sf_render "shop&page=2")" 'page=2&amp;min='
contains "정렬 링크가 가격대를 유지한다" "$MID" 'min=10000&amp;max=20000&amp;sort=popular'
contains "전체는 가격대를 지운다" "$MID" 'href="/shop">전체</a>'

# 주소를 손으로 고친 경우
contains "뒤집힌 범위는 상한을 버린다" "$(sf_render "shop&min=20000&max=5000")" ">총 ${OVER_N}개<"
contains "숫자가 아닌 값은 무시한다" "$(sf_render "shop&min=abc")" 'class="is-on" aria-current="true">전체'
# 좁힐 것이 없으면 막대를 내지 않는다 (구간이 하나뿐이거나 상품이 없을 때)
absent "빈 분류에는 가격 막대가 없다" "$(sf_render "shop&category=none")" 'class="brick-filter"'

echo "── 상품 뱃지 NEW · BEST · 할인율 (진열대의 관례)"
# 샘플 상품으로 세 경우를 만든다: 많이 팔린 것(BEST) · 오래된 것(NEW 아님) · 품절(뱃지 없음)
psql_q "UPDATE shop_products SET sold_count = 33 WHERE slug = 'sample-tote'" >/dev/null
psql_q "UPDATE shop_products SET created_at = now() - interval '60 days' WHERE slug = 'sample-mug'" >/dev/null
bust_cache
BADGE_HTML="$(sf_render "shop")"
contains "새 상품에 NEW" "$BADGE_HTML" 'brick-tag brick-tag-new">NEW'
contains "많이 팔린 상품에 BEST" "$BADGE_HTML" 'brick-tag brick-tag-best">BEST'
contains "정가가 있으면 할인율" "$BADGE_HTML" 'brick-tag brick-tag-sale">'
# 카드 하나만 정확히 자른다 — 상품 카드에는 중첩 <a> 가 없으므로 href 부터 첫 </a> 까지다.
# (넉넉히 자르면 옆 카드의 뱃지까지 삼켜, 정렬이 바뀔 때 엉뚱하게 통과·실패한다 — 실제로 그랬다)
card_of() { /usr/bin/python3 -c "
import sys, re
h = sys.stdin.read()
m = re.search(r'<a class=\"brick-product-card[^\"]*\" href=\"/shop/' + re.escape(sys.argv[1]) + r'\"(?:.|\n)*?</a>', h)
print(m.group(0) if m else '')
" "$1"; }
absent "60일 전 상품에는 NEW 를 붙이지 않는다" "$(echo "$BADGE_HTML" | card_of "sample-mug")" "brick-tag-new"
contains "품절 상품은 품절 표시가 먼저" "$(echo "$BADGE_HTML" | card_of "sample-candle")" "brick-badge-soldout"
absent "품절 상품에는 뱃지를 겹치지 않는다" "$(echo "$BADGE_HTML" | card_of "sample-candle")" "brick-tags"

echo "── 쇼핑몰 스타터의 샘플 상품 (빈 진열대로 시작하지 않는다)"
# 이 수트는 설치 때 shop 스타터를 고른다 (위 install 호출) — 그것이 넣은 것을 본다
SAMPLES="$(node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(\"SELECT name, price, list_price, stock, status, image_url FROM shop_products WHERE slug LIKE 'sample-%' ORDER BY sort_order\");
  console.log(JSON.stringify(rows));
  await c.end();
})();
" 2>/dev/null)"
[[ -n "$SAMPLES" && "$SAMPLES" != "[]" ]] && ok "shop 스타터가 샘플 상품을 넣는다" || bad "shop 스타터가 샘플 상품을 넣는다 (${SAMPLES:-없음})"
if [[ "$SAMPLES" != "[]" && -n "$SAMPLES" ]]; then
  contains "이름에 (샘플) 이 붙는다 — 지울 것을 찾기 쉽게" "$SAMPLES" "(샘플)"
  contains "할인 표시를 보여 주는 상품" "$SAMPLES" '"list_price":15000'
  contains "품절 상태를 보여 주는 상품" "$SAMPLES" '"status":"soldout"'
  contains "사진이 미디어에 함께 들어간다" "$SAMPLES" '"image_url":"/uploads/'
fi

echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -50 "$TMP/api.log"; exit 1; }
