#!/usr/bin/env bash
#
# 다국어(i18n) E2E 스모크 — 1단계(카탈로그) + 2단계(코어 공개 화면).
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
KO404="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "404 문구" "$KO404" "페이지를 찾을 수 없습니다"
contains "lang 속성" "$KO404" 'lang=\"ko\"'
contains "푸터 라벨" "$KO404" "상호 <b>브릭상사</b>"
contains "대표 라벨" "$KO404" "대표 홍길동"

echo "── 영어로 전환 — 즉시 반영되어야 한다"
contains "언어 저장" "$(curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"site.locale":"en"}')" '"ok":true'
EN404="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "404 문구가 영어" "$EN404" "There is no page at /no-such-page."
contains "제목도 영어" "$EN404" "Page not found"
contains "lang 속성" "$EN404" 'lang=\"en\"'
contains "푸터 라벨이 영어" "$EN404" "Company <b>브릭상사</b>"
contains "전화 라벨" "$EN404" "Tel 02-1234-5678"
absent  "값은 번역되지 않는다 (상호는 그대로)" "$EN404" "Brick Trading"
absent  "한국어 라벨이 남지 않는다" "$EN404" "사업자등록번호"

echo "── 한국어로 복귀"
curl -s -b "$CK" -X PUT "$API/api/settings" -H 'content-type: application/json' \
  -d '{"site.locale":"ko"}' >/dev/null
BACK="$(curl -s "$API/api/render/page?path=no-such-page")"
contains "다시 한국어" "$BACK" "페이지를 찾을 수 없습니다"
contains "lang 복귀" "$BACK" 'lang=\"ko\"'

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -30 "$TMP/api.log"; exit 1; }
