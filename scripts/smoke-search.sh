#!/usr/bin/env bash
#
# 통합검색 · 검색 로그 E2E 스모크.
#
# **검색은 권한 검사를 우회하는 가장 흔한 경로다.** 목록에 제목만 나와도
# 내용이 새어 나가는 경우가 있다(비밀글 제목, 비공개 게시판의 존재,
# 미공개 상품의 이름과 가격).
#
# 못박는 것:
#   - 비밀글이 검색되지 않는가
#   - 읽기 권한이 없는 게시판의 글이 검색되지 않는가 (등급별로)
#   - draft·hidden 상품이 검색되지 않는가
#   - `%` 를 검색하면 전체가 나오지 않는가 (ILIKE 이스케이프)
#   - total 이 실제 전체 개수인가 (페이지네이션이 동작하는가)
#   - 페이지를 넘길 때 같은 항목이 두 번 나오지 않는가
#   - 결과 0건이 기록되는가 (이 기능의 핵심)
#   - 인기 검색어가 한 사람의 반복으로 오염되지 않는가
#   - 차단 규칙이 인기 검색어에서 빠지는가
#   - 치환 규칙이 동작하는가
#   - 검색어 로그에 IP 원본이 남지 않는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-search.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
BOARD="$API/api/plugins/brick-board"
SHOP="$API/api/plugins/brick-shop"
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

# 한글 검색어는 반드시 인코딩해서 보낸다 (브라우저는 항상 인코딩한다)
srch() {  # srch <쿠키파일|-> <검색어> [추가 쿼리...]
  local ck="$1"; shift
  local q="$1"; shift
  if [[ "$ck" == "-" ]]; then
    curl -s -G "$API/api/search" --data-urlencode "q=$q" "$@"
  else
    curl -s -b "$ck" -G "$API/api/search" --data-urlencode "q=$q" "$@"
  fi
}

echo "▶ 통합검색 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-search-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_TIMEZONE="Asia/Seoul"

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
    -d '{"siteName":"검색","adminEmail":"admin@se.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@se.test","password":"adminpass123"}' >/dev/null
for pl in brick-board brick-shop; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done

for n in 1 2; do
  printf '{"email":"m%s@se.test","password":"password123",%s"displayName":"회원%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"m%s@se.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/m$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
M1="$TMP/m1.txt"; M2="$TMP/m2.txt"

echo "── 분류 탭 (켜진 플러그인에 따라 달라진다)"
SCOPES="$(curl -s "$API/api/search/scopes")"
contains "페이지" "$SCOPES" '"code":"pages"'
contains "게시글 (플러그인이 등록)" "$SCOPES" '"code":"posts"'
contains "상품 (플러그인이 등록)" "$SCOPES" '"code":"products"'

echo "── 짧은 검색어"
SHORT="$(srch - "가")"
contains "한 글자는 거부한다 (거의 모든 문서에 걸린다)" "$SHORT" '"tooShort":true'
check "결과 0" "$(echo "$SHORT" | jq_get "['total']")" "0"
check "기록도 남기지 않는다" "$(psql_q "SELECT count(*) FROM search_logs")" "0"

echo "── 준비: 게시판 (읽기 권한을 다르게)"
mkboard() {  # mkboard <slug> <제목> <read_role>
  printf '{"slug":"%s","title":"%s","read_role":"%s","write_role":"member"}' "$1" "$2" "$3" > "$TMP/b.json"
  curl -s -b "$CK" -X POST "$BOARD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b.json" >/dev/null
}
mkboard "open" "공개게시판" "guest"
mkboard "members" "회원게시판" "member"
mkboard "staff" "운영진게시판" "manager"
check "게시판 3개" "$(psql_q "SELECT count(*) FROM board_boards WHERE slug IN ('open','members','staff')")" "3"

mkpost() {  # mkpost <쿠키> <board> <제목> <본문> [secret]
  local secret="false"; [[ "${5:-}" == "secret" ]] && secret="true"
  printf '{"title":"%s","content":"%s","isSecret":%s}' "$3" "$4" "$secret" > "$TMP/p.json"
  curl -s -b "$1" -X POST "$BOARD/boards/$2/posts" -H 'content-type: application/json' --data-binary "@$TMP/p.json" | jq_get "['id']"
}
# 관리자로 쓴다 (도배 방지에 걸리지 않게)
mkpost "$CK" "open" "공개 글 우산 안내" "<p>비 오는 날 우산을 챙기세요</p>" >/dev/null
mkpost "$CK" "members" "회원 전용 우산 할인" "<p>회원에게만 우산을 싸게 드립니다</p>" >/dev/null
mkpost "$CK" "staff" "운영진 우산 재고" "<p>우산 창고 재고 현황</p>" >/dev/null
mkpost "$CK" "open" "비밀 우산 문의" "<p>비밀로 우산에 대해 묻습니다</p>" "secret" >/dev/null
check "글 4개" "$(psql_q "SELECT count(*) FROM board_posts")" "4"

echo "══ 권한: 볼 수 없는 것이 검색되지 않는가 ══"
GUEST="$(srch - "우산")"
contains "비회원도 공개 글은 찾는다" "$GUEST" "공개 글 우산 안내"
absent "회원 전용 게시판 글은 안 나온다" "$GUEST" "회원 전용 우산 할인"
absent "운영진 게시판 글도 안 나온다" "$GUEST" "운영진 우산 재고"
absent "비밀글은 안 나온다" "$GUEST" "비밀 우산 문의"
GUEST_POSTS="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
g=[x for x in d['groups'] if x['code']=='posts']
print(g[0]['total'] if g else 0)" <<< "$GUEST")"
check "비회원에게 보이는 글은 1건" "$GUEST_POSTS" "1"

MEMBER="$(srch "$M1" "우산")"
contains "회원은 공개 글도" "$MEMBER" "공개 글 우산 안내"
contains "회원은 회원 게시판도 찾는다" "$MEMBER" "회원 전용 우산 할인"
absent "회원도 운영진 게시판은 못 본다" "$MEMBER" "운영진 우산 재고"
absent "회원도 남의 비밀글은 못 본다" "$MEMBER" "비밀 우산 문의"
MEMBER_POSTS="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
g=[x for x in d['groups'] if x['code']=='posts']
print(g[0]['total'] if g else 0)" <<< "$MEMBER")"
check "회원에게 보이는 글은 2건" "$MEMBER_POSTS" "2"

ADMIN="$(srch "$CK" "우산")"
contains "관리자는 운영진 게시판도" "$ADMIN" "운영진 우산 재고"
absent "관리자도 비밀글은 검색에서 제외 (화면 공유로 새어 나간다)" "$ADMIN" "비밀 우산 문의"
ADMIN_POSTS="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
g=[x for x in d['groups'] if x['code']=='posts']
print(g[0]['total'] if g else 0)" <<< "$ADMIN")"
check "관리자에게 보이는 글은 3건 (비밀글 제외)" "$ADMIN_POSTS" "3"

echo "══ 상품: 안 파는 것이 검색되지 않는가 ══"
mkproduct() {  # mkproduct <slug> <이름> <status> [summary]
  printf '{"slug":"%s","name":"%s","price":10000,"stock":10,"status":"%s","summary":"%s"}' "$1" "$2" "$3" "${4:-}" > "$TMP/pr.json"
  curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/pr.json" >/dev/null
}
mkproduct "umbrella-a" "3단 우산" "selling" "가벼운 3단 우산입니다"
mkproduct "umbrella-b" "장우산" "soldout" "튼튼한 장우산"
mkproduct "umbrella-secret" "미공개 우산 신상품" "draft" "아직 안 팝니다"
mkproduct "umbrella-old" "단종된 우산" "hidden" "더는 안 팝니다"

PROD="$(srch - "우산" --data-urlencode "scope=products")"
contains "판매중 상품" "$PROD" "3단 우산"
contains "품절 상품도 검색된다 (재입고를 기다리는 손님이 있다)" "$PROD" "장우산"
contains "품절 표시" "$PROD" "품절"
absent "작성 중 상품은 안 나온다 (미공개 노출은 정보 유출)" "$PROD" "미공개 우산 신상품"
absent "내린 상품도 안 나온다 (눌러도 404 다)" "$PROD" "단종된 우산"
check "상품 2건" "$(echo "$PROD" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['groups'][0]['total'])")" "2"
contains "가격을 함께 보여준다" "$PROD" "10,000원"

echo "── 분류를 지정하면 그것만 검색한다"
ONLY_POSTS="$(srch - "우산" --data-urlencode "scope=posts")"
check "게시글 그룹만" "$(echo "$ONLY_POSTS" | python3 -c "
import json,sys
print(len(json.load(sys.stdin)['groups']))")" "1"
contains "요청한 분류를 되돌려준다" "$ONLY_POSTS" '"scope":"posts"'

echo "══ ILIKE 이스케이프: % 로 전체를 긁을 수 없다 ══"
# 이스케이프하지 않으면 %가 와일드카드가 되어 전체 목록이 나온다 — 검색이 아니라 유출이다
PCT="$(srch - "%%")"
check "% 로는 아무것도 안 나온다" "$(echo "$PCT" | jq_get "['total']")" "0"
UNDER="$(srch - "__")"
check "_ 로도 안 나온다" "$(echo "$UNDER" | jq_get "['total']")" "0"

echo "══ 페이지네이션: total 이 실제 전체 개수인가 ══"
# 기존 코드는 total 에 그 페이지의 행 수를 넣어서, 500건이 맞아도 20을 돌려줬다.
# 화면은 항상 1페이지뿐이라고 판단한다.
for i in $(seq 1 25); do
  mkpost "$CK" "open" "페이지넘김 검증 글 $i" "<p>페이지넘김 본문 $i</p>" >/dev/null
done
PAGE1="$(srch - "페이지넘김" --data-urlencode "scope=posts" --data-urlencode "page=1")"
check "total 이 25 (그 페이지의 20이 아니다)" "$(echo "$PAGE1" | jq_get "['total']")" "25"
check "1페이지에 20건" "$(echo "$PAGE1" | python3 -c "
import json,sys
print(len(json.load(sys.stdin)['groups'][0]['items']))")" "20"
PAGE2="$(srch - "페이지넘김" --data-urlencode "scope=posts" --data-urlencode "page=2")"
check "2페이지에 5건" "$(echo "$PAGE2" | python3 -c "
import json,sys
print(len(json.load(sys.stdin)['groups'][0]['items']))")" "5"
check "2페이지도 total 은 25" "$(echo "$PAGE2" | jq_get "['total']")" "25"
# 정렬이 고정되지 않으면 같은 글이 두 페이지에 나온다
OVERLAP="$(python3 -c "
import json, sys
p1 = json.loads(sys.argv[1])['groups'][0]['items']
p2 = json.loads(sys.argv[2])['groups'][0]['items']
a = {x['path'] for x in p1}
b = {x['path'] for x in p2}
print(len(a & b))
" "$PAGE1" "$PAGE2")"
check "두 페이지에 겹치는 항목이 없다 (정렬 고정)" "$OVERLAP" "0"
ALL_PATHS="$(python3 -c "
import json, sys
p1 = json.loads(sys.argv[1])['groups'][0]['items']
p2 = json.loads(sys.argv[2])['groups'][0]['items']
print(len({x['path'] for x in p1} | {x['path'] for x in p2}))
" "$PAGE1" "$PAGE2")"
check "두 페이지 합쳐 25건 (빠진 것이 없다)" "$ALL_PATHS" "25"

echo "══ 검색 로그 ══"
LOGGED="$(psql_q "SELECT count(*) > 0 FROM search_logs WHERE query = '우산'")"
check "검색이 기록된다" "$LOGGED" "true"
check "결과 수도 기록된다" \
  "$(psql_q "SELECT result_count > 0 FROM search_logs WHERE query='우산' LIMIT 1")" "true"

echo "── IP 원본을 남기지 않는다 (검색어는 그 자체로 민감하다)"
check "IP 평문이 없다" "$(psql_q "SELECT count(*) FROM search_logs WHERE ip_hash = '127.0.0.1'")" "0"
check "해시는 기록된다" "$(psql_q "SELECT count(*) > 0 FROM search_logs WHERE ip_hash IS NOT NULL")" "true"

echo "── 정규화: 인기 검색어가 흩어지지 않는다"
srch - "  아이폰   케이스  " >/dev/null
srch - "아이폰 케이스" >/dev/null
srch - "아이폰 케이스" >/dev/null
check "세 번이 같은 검색어로 집계된다" \
  "$(psql_q "SELECT count(*) FROM search_logs WHERE query = '아이폰 케이스'")" "3"
contains "원문도 남긴다" "$(psql_q "SELECT raw_query FROM search_logs WHERE query='아이폰 케이스' ORDER BY created_at LIMIT 1")" "아이폰"

echo "══ 결과 0건 (이 기능의 핵심) ══"
srch - "존재하지않는물건" >/dev/null
srch - "존재하지않는물건" >/dev/null
check "0건도 기록된다" \
  "$(psql_q "SELECT count(*) FROM search_logs WHERE query='존재하지않는물건' AND result_count = 0")" "2"
NORES="$(curl -s -b "$CK" "$API/api/admin/search/no-results?days=30")"
contains "0건 목록에 나온다" "$NORES" "존재하지않는물건"
contains "무엇을 해야 하는지 알려준다" "$NORES" "치환 규칙으로 연결"
absent "결과가 있던 검색어는 안 나온다" "$NORES" '"query":"우산"'
check "0건 목록은 공개하지 않는다 (운영 정보다)" "$(code "$API/api/admin/search/no-results")" "401"
check "일반 회원도 못 본다" "$(code -b "$M1" "$API/api/admin/search/no-results")" "403"

echo "══ 인기 검색어 ══"
POP="$(curl -s "$API/api/search/popular?days=30&limit=20")"
contains "아이폰 케이스가 있다" "$POP" "아이폰 케이스"
contains "빈손 비율을 준다" "$POP" '"emptyRatio"'
EMPTY_RATIO="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
row=next((x for x in d['items'] if x['query']=='존재하지않는물건'), None)
print(row['emptyRatio'] if row else 'none')" <<< "$POP")"
check "0건 검색어의 빈손 비율은 100%" "$EMPTY_RATIO" "100"

echo "── 한 사람의 반복이 1위가 되지 않는다"
# 같은 IP·같은 날이면 한 번으로 센다
for i in $(seq 1 15); do srch - "반복검색어테스트" >/dev/null; done
check "로그는 15건 남는다" "$(psql_q "SELECT count(*) FROM search_logs WHERE query='반복검색어테스트'")" "15"
POP2="$(curl -s "$API/api/search/popular?days=30&limit=20")"
REPEAT_COUNT="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
row=next((x for x in d['items'] if x['query']=='반복검색어테스트'), None)
print(row['count'] if row else 'none')" <<< "$POP2")"
check "인기 집계에서는 1로 센다" "$REPEAT_COUNT" "1"

echo "══ 검색어 규칙 ══"
echo "── 차단: 인기 검색어에서 제외 (검색 자체는 막지 않는다)"
contains "차단 규칙 저장" "$(curl -s -b "$CK" -X POST "$API/api/admin/search/rules" \
  -H 'content-type: application/json' -d '{"term":"아이폰 케이스","kind":"block","note":"경쟁사 상품"}')" '"id"'
POP3="$(curl -s "$API/api/search/popular?days=30&limit=20")"
absent "인기 검색어에서 빠진다" "$POP3" "아이폰 케이스"
STILL="$(srch - "아이폰 케이스")"
contains "검색 자체는 된다" "$STILL" '"normalized":"아이폰 케이스"'

echo "── 치환: 부르는 이름이 달라서 못 찾은 것을 연결한다"
# "우비" 로 찾는 손님에게 "우산" 결과를 준다
NOTHING="$(srch - "우비")"
check "치환 전에는 0건" "$(echo "$NOTHING" | jq_get "['total']")" "0"
contains "치환 규칙 저장" "$(curl -s -b "$CK" -X POST "$API/api/admin/search/rules" \
  -H 'content-type: application/json' -d '{"term":"우비","kind":"replace","replacement":"우산","note":"같은 상품군"}')" '"id"'
REPLACED="$(srch - "우비")"
contains "치환되어 결과가 나온다" "$REPLACED" "3단 우산"
contains "원래 검색어를 알려준다 (손님에게 안내해야 한다)" "$REPLACED" '"replacedFrom":"우비"'
contains "실제 검색어" "$REPLACED" '"normalized":"우산"'

echo "── 규칙 검증"
check "종류가 잘못되면 400" \
  "$(code -b "$CK" -X POST "$API/api/admin/search/rules" -H 'content-type: application/json' \
      -d '{"term":"x","kind":"nonsense"}')" "400"
check "치환인데 바꿀 검색어가 없으면 400" \
  "$(code -b "$CK" -X POST "$API/api/admin/search/rules" -H 'content-type: application/json' \
      -d '{"term":"xy","kind":"replace"}')" "400"
contains "같은 검색어로 치환하면 400" \
  "$(curl -s -b "$CK" -X POST "$API/api/admin/search/rules" -H 'content-type: application/json' \
      -d '{"term":"같은말","kind":"replace","replacement":"같은말"}')" "같은 검색어로 바꿀 수 없습니다"
check "비관리자는 규칙을 만들 수 없다" \
  "$(code -b "$M1" -X POST "$API/api/admin/search/rules" -H 'content-type: application/json' \
      -d '{"term":"x","kind":"block"}')" "403"
check "규칙 목록도 관리자만" "$(code "$API/api/admin/search/rules")" "401"

echo "── 같은 검색어에 규칙을 다시 저장하면 덮어쓴다"
contains "차단을 치환으로 바꾼다" "$(curl -s -b "$CK" -X POST "$API/api/admin/search/rules" \
  -H 'content-type: application/json' -d '{"term":"아이폰 케이스","kind":"replace","replacement":"우산"}')" '"id"'
check "규칙이 하나뿐" "$(psql_q "SELECT count(*) FROM search_rules WHERE term='아이폰 케이스'")" "1"
check "종류가 바뀌었다" "$(psql_q "SELECT kind FROM search_rules WHERE term='아이폰 케이스'")" "replace"

echo "── 규칙 삭제"
RULE_ID="$(psql_q "SELECT id FROM search_rules WHERE term='우비'")"
contains "삭제" "$(curl -s -b "$CK" -X DELETE "$API/api/admin/search/rules/$RULE_ID")" '"ok":true'
AFTER="$(srch - "우비")"
check "치환이 사라져 다시 0건" "$(echo "$AFTER" | jq_get "['total']")" "0"

echo "══ 공급자 하나가 죽어도 나머지는 보여준다 ══"
# 상품 테이블을 잠깐 망가뜨려 공급자가 실패하게 만든다
psql_q "ALTER TABLE shop_products RENAME COLUMN summary TO summary_tmp" >/dev/null
BROKEN="$(srch - "우산")"
contains "게시글은 여전히 나온다" "$BROKEN" "공개 글 우산 안내"
BROKEN_GROUPS="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(','.join(g['code'] for g in d['groups']))" <<< "$BROKEN")"
absent "실패한 공급자는 빠진다" "$BROKEN_GROUPS" "products"
contains "검색 자체는 성공한다 (500 이 아니다)" "$BROKEN" '"groups"'
psql_q "ALTER TABLE shop_products RENAME COLUMN summary_tmp TO summary" >/dev/null
FIXED="$(srch - "우산" --data-urlencode "scope=products")"
contains "고치면 다시 나온다" "$FIXED" "3단 우산"

echo "══ 페이지 검색 (코어) ══"
PG_ID="$(curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"umbrella-guide","title":"우산 고르는 방법","blocks":[{"block":"core/paragraph","props":{"text":"좋은 우산을 고르는 방법을 안내합니다."}}],"status":"published"}' | jq_get "['id']")"
[[ -n "$PG_ID" ]] && ok "페이지 생성" || bad "페이지 생성"
# 잘못된 블록으로도 500 이 나지 않아야 한다.
# "unknown block" 주석으로 넘기려는 코드가 escapeHtml(undefined) 에서 터졌다.
check "블록 이름이 없어도 500 이 아니다" \
  "$(code -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"malformed-block","title":"잘못된 블록","blocks":[{"props":{"text":"x"}}],"status":"draft"}')" "201"
check "모르는 블록 이름도 500 이 아니다" \
  "$(code -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
      -d '{"slug":"unknown-block","title":"모르는 블록","blocks":[{"block":"nope/missing","props":{}}],"status":"draft"}')" "201"
PAGES="$(srch - "우산" --data-urlencode "scope=pages")"
contains "페이지가 검색된다" "$PAGES" "우산 고르는 방법"
# 비공개 페이지는 안 나와야 한다
curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"umbrella-draft","title":"임시 우산 문서","blocks":[],"status":"draft"}' >/dev/null
PAGES2="$(srch - "우산" --data-urlencode "scope=pages")"
absent "임시 페이지는 안 나온다" "$PAGES2" "임시 우산 문서"

echo "── 발췌문"
EXCERPT="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
items=d['groups'][0]['items']
row=next((x for x in items if '우산 고르는' in x['title']), None)
print(row['excerpt'] if row else 'none')" <<< "$PAGES")"
contains "검색어 주변을 잘라 준다" "$EXCERPT" "우산"
absent "HTML 태그가 섞이지 않는다" "$EXCERPT" "<p>"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
