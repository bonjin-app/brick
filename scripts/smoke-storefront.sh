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
    -d '{"siteName":"스토어","adminEmail":"admin@st.test","adminPassword":"adminpass123"}' >/dev/null
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
HOME="$(curl -s "$API/api/render/page?path=")"
contains "상호 렌더" "$HOME" "본진주식회사"
contains "사업자등록번호 렌더" "$HOME" "220-81-62517"
contains "통신판매업 신고번호 렌더" "$HOME" "제2026-서울강남-01234호"
contains "대표자 렌더" "$HOME" "홍길동"
contains "전화번호 렌더" "$HOME" "02-1234-5678"
contains "전용 영역으로 감싸짐" "$HOME" "brick-business"
contains "에스크로 안내가 화면에 나온다 (표시 의무)" "$HOME" "본진에스크로"
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
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -50 "$TMP/api.log"; exit 1; }
