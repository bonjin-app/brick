#!/usr/bin/env bash
#
# 다국어(i18n) E2E 스모크 — 카탈로그 규칙 + 코어 공개 화면 + 플러그인 공개
# 문자열(ctx.t) + 플러그인 관리 선언 라벨(gettext, 서빙 시점 번역).
#
# 못박는 것:
#   - site.locale 이 실제 렌더를 바꾸는가 (404 문구 · 테마 푸터 라벨 · lang)
#   - 지원하지 않는 언어는 저장이 거부되는가 ("설정했는데 그대로"가 없게)
#   - 언어를 바꾸면 **즉시** 반영되는가 (렌더 캐시 무효화 + 로더 캐시 훅)
#   - 빠진 키는 ko 로 폴백하고, ko 에도 없으면 키를 돌려주는가
#     (조용한 빈 문자열이 없어야 한다)
#   - 값(사업자 상호 등)은 번역되지 않고 라벨만 번역되는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-i18n.sh
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

echo "▶ 다국어 스모크 테스트"

echo "── 번역기 규칙 (폴백은 조용하면 안 된다)"
node - "$ROOT" <<'JS'
const { makeTranslator } = await import(`file://${process.argv[2]}/packages/core/dist/i18n.js`);
const missing = [];
const t = makeTranslator({
  locale: "en",
  catalogs: { ko: { a: "가 {n}", b: "나" }, en: { a: "A {n}" } },
  onMissing: (k, l) => missing.push(`${l}:${k}`),
});
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
if (t("a", { n: 1 }) !== "A 1") fail("en 카탈로그 우선");
if (t("b") !== "나") fail("en 에 없으면 ko 폴백");
if (t("c") !== "c") fail("둘 다 없으면 키 자체 (빈 문자열 금지)");
if (t("a", {}) !== "A {n}") fail("없는 파라미터는 그대로 (조용히 지우지 않는다)");
if (!missing.includes("en:b")) fail("ko 폴백이 로그된다");
if (!missing.includes("en:c")) fail("완전 부재가 로그된다");
console.log("OK");
JS
[[ $? -eq 0 ]] && ok "폴백·파라미터·로그 규칙" || bad "번역기 규칙"

echo "── 테마 템플릿 엔진 규칙 (같은 종류 중첩 · 주석 · 주입 금지 · fail-closed)"
node - "$ROOT" <<'JS'
const { renderTemplate } = await import(`file://${process.argv[2]}/packages/theme-sdk/dist/index.js`);
const fail = (m, got) => { console.error("FAIL:", m, JSON.stringify(got)); process.exit(1); };
let r = renderTemplate("A{{#if biz}}X{{#if biz.a}}B{{/if}}Y{{/if}}Z", {});
if (r !== "AZ") fail("같은 종류 중첩 — 바깥 falsy 면 통째로 사라진다", r);
r = renderTemplate("{{#if biz}}[{{#if biz.a}}{{ biz.a }}{{/if}}{{#if biz.b}}·{{ biz.b }}{{/if}}]{{/if}}", { biz: { a: "가" } });
if (r !== "[가]") fail("같은 종류 중첩 — 바깥 truthy + 안쪽 선택", r);
r = renderTemplate("A{{!-- 비밀 메모 --}}B", {});
if (r !== "AB") fail("주석은 응답에도 없다", r);
r = renderTemplate("{{#each items}}{{#if on}}{{ name }} {{/if}}{{/each}}", { items: [{ name: "x", on: true }, { name: "y", on: false }] });
if (r !== "x ") fail("each 안 if 중첩", r);
// 삽입된 값은 다시 파싱하지 않는다 — 게시글 본문의 "{{ site.name }}" 이 값으로 바뀌면 주입이다
r = renderTemplate("{{{ content }}}|{{ title }}", { content: "본문 {{ secret }}", title: "제목 {{ secret }}", secret: "유출" });
if (r !== "본문 {{ secret }}|제목 {{ secret }}") fail("값 안의 {{ }} 는 재치환되지 않는다", r);
// 짝 없는 여는 태그는 fail-closed — 감싸려던 내용이 조건 없이 노출되면 안 된다
r = renderTemplate("공개{{#if admin}}비밀{{#if x}}y{{/if}}", { x: true });
if (r.includes("비밀") || r.includes("y")) fail("짝 없는 블록의 내용은 렌더되지 않는다", r);
if (!r.includes("{{#if admin}}")) fail("짝 없는 태그는 화면에 남아 오류가 보인다", r);
console.log("OK");
JS
[[ $? -eq 0 ]] && ok "중첩·주석·주입 금지·fail-closed" || bad "테마 엔진 규칙"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-i18n-secret-val}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"다국어","adminEmail":"admin@i18n.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@i18n.test","password":"adminpass123"}' >/dev/null

# 사업자정보 설정 **전** — 바깥 {{#if site.business}} 가 falsy 인 경로.
# 같은 종류 블록 중첩을 non-greedy 로 자르던 엔진 버그가 정확히 여기서
# {{/if}} 와 {{!-- --}} 주석을 화면에 노출시켰다.
PRE="$(curl -s "$API/api/render/page?path=no-such-page")"
absent "설정 전 푸터에 템플릿 잔해 없음" "$PRE" "{{"
absent "템플릿 주석은 응답에도 없다" "$PRE" "전자상거래법 제24조"

# 푸터 라벨 검증용 사업자정보 (값은 번역되면 안 된다)
curl -s -b "$CK" -X PUT "$API/api/business-info" -H 'content-type: application/json' \
  -d '{"companyName":"브릭상사","representative":"홍길동","phone":"02-1234-5678"}' >/dev/null

echo "── 설정 검증"
contains "지원하지 않는 언어는 거부" \
  "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
      -d '{"site.locale":"xx"}')" "지원하지 않는 언어"
check "비로그인은 설정 불가" \
  "$(code -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{"site.locale":"en"}')" "401"

echo "── 기본은 한국어"
contains "locale 기본값 ko" "$(curl -s "$API/api/i18n")" '"locale":"ko"'
KO404="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "404 문구" "$KO404" "페이지를 찾을 수 없습니다"
contains "lang 속성" "$KO404" 'lang=\"ko\"'
contains "푸터 라벨" "$KO404" "상호 <b>브릭상사</b>"
contains "대표 라벨" "$KO404" "대표 홍길동"
absent  "설정 후에도 템플릿 잔해 없음" "$KO404" "{{"

echo "── 영어로 전환 — 즉시 반영되어야 한다"
contains "언어 저장" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"site.locale":"en"}')" '"ok":true'
contains "공개 locale 엔드포인트 (웹 로그인·가입 화면이 쓴다)" "$(curl -s "$API/api/i18n")" '"locale":"en"'
EN404="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "404 문구가 영어" "$EN404" "There is no page at /no-such-page."
contains "제목도 영어" "$EN404" "Page not found"
contains "lang 속성" "$EN404" 'lang=\"en\"'
contains "푸터 라벨이 영어" "$EN404" "Company <b>브릭상사</b>"
contains "전화 라벨" "$EN404" "Tel 02-1234-5678"
absent  "값은 번역되지 않는다 (상호는 그대로)" "$EN404" "Brick Trading"
absent  "한국어 라벨이 남지 않는다" "$EN404" "사업자등록번호"

echo "── 플러그인(게시판)도 언어를 따라간다 — 동봉 카탈로그"
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/activate" >/dev/null
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"board","title":"게시판","status":"published","blocks":[{"block":"brick-board/board","props":{}}]}' >/dev/null
BOARD_EN="$(curl -s "$API/api/render/page?path=board")"
contains "게시판 빈 안내가 영어" "$BOARD_EN" "There are no boards yet."
absent  "한국어가 남지 않는다" "$BOARD_EN" "아직 게시판이"
# 게시판 하나 만들면 목록 헤더도 영어여야 한다
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/admin/boards" -H 'content-type: application/json' \
  -d '{"slug":"news","title":"News","read_role":"guest","write_role":"member"}' >/dev/null
LIST_EN="$(curl -s "$API/api/render/page?path=board/news")"
contains "목록 헤더가 영어" "$LIST_EN" ">Title</th>"
contains "빈 목록 안내가 영어" "$LIST_EN" "Be the first to write a post."
contains "글 수가 영어" "$LIST_EN" "0 posts"

echo "── 플러그인(쇼핑몰)도 언어를 따라간다"
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate" >/dev/null
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"shop","title":"쇼핑몰","status":"published","blocks":[{"block":"brick-shop/storefront","props":{}}]}' >/dev/null
SHOP_EN="$(curl -s "$API/api/render/page?path=shop")"
contains "빈 상품 안내가 영어" "$SHOP_EN" "No products yet."
contains "기획전 목록도 영어" "$(curl -s "$API/api/render/page?path=shop/event")" "No events running."
curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' \
  -d '{"slug":"tea","name":"Green Tea","price":9000,"stock":0,"status":"selling","free_shipping":true}' >/dev/null
DETAIL_EN="$(curl -s "$API/api/render/page?path=shop/tea")"
contains "품절 배지가 영어" "$DETAIL_EN" "Sold out"
contains "재입고 폼이 영어" "$DETAIL_EN" "Notify me on restock"
contains "후기 탭이 영어" "$DETAIL_EN" "Reviews"

echo "── 관리 선언 라벨도 언어를 따라간다 (gettext — 원문이 키, 서빙 시점 번역)"
NAV_EN="$(curl -s -b "$CK" "$API/api/admin/nav")"
contains "리소스 제목이 영어 (주문→Orders)" "$NAV_EN" '"title":"Orders"'
contains "게시판도 영어 (게시판→Boards)" "$NAV_EN" '"title":"Boards"'
absent  "원문이 남지 않는다" "$NAV_EN" '"title":"주문"'
RES_EN="$(curl -s -b "$CK" "$API/api/admin/resources/brick-shop/orders")"
contains "필드 라벨이 영어" "$RES_EN" '"label":"Order no."'
contains "옵션 라벨이 영어" "$RES_EN" '"label":"Paid"'
contains "설명(help)도 영어" "$RES_EN" "restores stock automatically"
DASH_EN="$(curl -s -b "$CK" "$API/api/admin/dashboard")"
contains "대시보드 카드 제목도 영어" "$DASH_EN" '"title":"Orders today"'
contains "카드 부가문구(ctx.t)도 영어" "$DASH_EN" "Awaiting payment: 0"

echo "── 한국어로 복귀"
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"site.locale":"ko"}' >/dev/null
BACK="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "다시 한국어" "$BACK" "페이지를 찾을 수 없습니다"
contains "게시판도 한국어 복귀" "$(curl -s "$API/api/render/page?path=board/news")" "첫 글을 작성해보세요."
contains "쇼핑몰도 한국어 복귀" "$(curl -s "$API/api/render/page?path=shop/tea")" "재입고 알림 신청"
contains "lang 복귀" "$BACK" 'lang=\"ko\"'
contains "관리 라벨도 원문 복귀" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"title":"주문"'

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -30 "$TMP/api.log"; exit 1; }
