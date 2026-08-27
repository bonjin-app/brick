#!/usr/bin/env bash
#
# 설문조사 E2E 스모크.
#
# 못박는 것:
#   - 중복 투표가 막히는가 (회원 · 비회원 IP)
#   - **IP 원문이 저장되지 않는가** (해시만)
#   - 결과 공개 시점이 지켜지는가 — 숨겨야 할 때 득표 수가 응답에 없어야 한다
#     (화면에서 가리는 방식이면 개발자 도구로 보인다)
#   - 남의 설문 선택지로 투표할 수 없는가 (집계 오염)
#   - 기간(시작 전 · 종료 후)이 지켜지는가
#   - 선택지 문구를 고쳐도 표가 유지되는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-poll.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
PL="$API/api/plugins/brick-poll"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:220})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }
render_html() { python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))" 2>/dev/null || echo ""; }

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

echo "▶ 설문조사 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-poll-secret-value}"
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
    -d '{"siteName":"설문","adminEmail":"admin@pl.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@pl.test","password":"adminpass123"}' >/dev/null
contains "플러그인 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-poll/activate")" '"ok":true'

for n in 1 2; do
  printf '{"email":"p%s@pl.test","password":"password123",%s"displayName":"참여자%s"}' "$n" "$CONSENT" "$n" > "$TMP/r$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/r$n.json" >/dev/null
  printf '{"email":"p%s@pl.test","password":"password123"}' "$n" > "$TMP/l$n.json"
  curl -s -c "$TMP/u$n.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/l$n.json" >/dev/null
done
U1="$TMP/u1.txt"; U2="$TMP/u2.txt"

echo "── 관리자 리소스"
contains "설문 리소스 등록" "$(curl -s -b "$CK" "$API/api/admin/nav")" '"name":"polls"'
check "비관리자는 설문 생성 불가" \
  "$(code -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"x","question":"q","options_text":"a\nb"}')" "403"

echo "── 검증"
check "선택지 1개는 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"one","question":"질문","options_text":"하나만"}')" "400"
contains "두 개 이상 필요하다고 알려준다" \
  "$(curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"one","question":"질문","options_text":"하나만"}')" "두 개 이상"
check "선택지 중복 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"dup","question":"질문","options_text":"같음\n같음"}')" "400"
check "질문 없으면 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"noq","question":"","options_text":"a\nb"}')" "400"
check "잘못된 slug 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"한글","question":"질문","options_text":"a\nb"}')" "400"
check "종료가 시작보다 빠르면 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"bad-period","question":"질문","options_text":"a\nb","starts_at":"2026-12-01T00:00:00Z","ends_at":"2026-01-01T00:00:00Z"}')" "400"
check "잘못된 결과 공개 값 거부" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
      -d '{"slug":"badvis","question":"질문","options_text":"a\nb","result_visibility":"nope"}')" "400"

echo "── 설문 생성"
cat > "$TMP/poll1.json" <<'JSON'
{"slug":"favorite","question":"가장 좋아하는 색은?","description":"하나만 골라주세요",
 "options_text":"빨강\n파랑\n초록","result_visibility":"after_vote","vote_role":"guest",
 "allow_comment":true}
JSON
P1="$(curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll1.json" | jq_get "['id']")"
[[ -n "$P1" ]] && ok "설문 생성" || bad "설문 생성"
check "slug 중복 차단" \
  "$(code -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll1.json")" "409"
OPT_COUNT="$(psql_q "SELECT count(*) FROM poll_options WHERE poll_id='$P1'")"
check "선택지 3개 생성" "$OPT_COUNT" "3"

echo "── 투표 전에는 결과가 응답에 없다 (화면에서 가리면 개발자 도구로 보인다)"
VIEW="$(curl -s "$PL/polls/favorite")"
contains "질문 조회" "$VIEW" "가장 좋아하는 색은?"
contains "선택지 조회" "$VIEW" "빨강"
contains "투표 가능" "$VIEW" '"canVote":true'
contains "결과 숨김 표시" "$VIEW" '"showResults":false'
absent "득표 수가 응답에 없음" "$VIEW" '"voteCount":0,"percent"'
absent "percent 필드 없음" "$VIEW" '"percent"'

echo "── 투표"
RED="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P1' AND label='빨강'")"
BLUE="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P1' AND label='파랑'")"
printf '{"optionId":"%s","comment":"빨강이 제일 좋아요"}' "$RED" > "$TMP/v1.json"
V1="$(curl -s -b "$U1" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")"
contains "투표 성공" "$V1" '"ok":true'
contains "투표 직후 결과 공개 (after_vote)" "$V1" '"showResults":true'
contains "득표 반영" "$V1" '"voteCount":1'
contains "내 선택 표시" "$V1" '"mine":true'
contains "참여자 수 1" "$V1" '"voteCount":1'
contains "기타 의견 저장" "$V1" "빨강이 제일 좋아요"

echo "── 중복 투표 차단 (회원)"
check "같은 회원 재투표 차단" \
  "$(code -b "$U1" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")" "409"
contains "이미 참여했다고 알려준다" \
  "$(curl -s -b "$U1" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/v1.json")" "이미 참여"
AFTER_DUP="$(psql_q "SELECT vote_count FROM poll_polls WHERE id='$P1'")"
check "중복 시도로 표가 늘지 않음" "$AFTER_DUP" "1"
MY="$(curl -s -b "$U1" "$PL/polls/favorite")"
contains "이미 참여 상태" "$MY" '"hasVoted":true'
contains "투표 불가 이유 안내" "$MY" "이미 참여하셨습니다"

echo "── 중복 투표 차단 (비회원 IP)"
printf '{"optionId":"%s"}' "$BLUE" > "$TMP/v2.json"
G1="$(curl -s -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/v2.json")"
contains "비회원 투표 성공" "$G1" '"ok":true'
check "같은 IP 재투표 차단" \
  "$(code -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/v2.json")" "409"
TOTAL="$(psql_q "SELECT vote_count FROM poll_polls WHERE id='$P1'")"
check "참여자 2명 (회원1 + 비회원1)" "$TOTAL" "2"

echo "── IP 원문이 저장되지 않는다 (개인정보)"
RAW_IP="$(psql_q "SELECT count(*) FROM poll_votes WHERE voter_hash LIKE '%127.0.0.1%' OR voter_hash LIKE '%::1%'")"
check "IP 원문 없음" "$RAW_IP" "0"
HASHED="$(psql_q "SELECT count(*) FROM poll_votes WHERE voter_hash ~ '^[0-9a-f]{64}\$'")"
check "sha256 해시로만 저장" "$HASHED" "1"
# 같은 IP 가 다른 설문에서 같은 해시를 갖지 않아야 한다 (설문 목록을 만들 수 없게)
cat > "$TMP/poll2.json" <<'JSON'
{"slug":"second","question":"두번째 설문","options_text":"예\n아니오","result_visibility":"always"}
JSON
P2="$(curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll2.json" | jq_get "['id']")"
YES="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P2' AND label='예'")"
printf '{"optionId":"%s"}' "$YES" > "$TMP/v3.json"
curl -s -X POST "$PL/polls/second/vote" -H 'content-type: application/json' --data-binary "@$TMP/v3.json" >/dev/null
DISTINCT="$(psql_q "SELECT count(DISTINCT voter_hash) FROM poll_votes WHERE voter_hash IS NOT NULL")"
check "같은 IP도 설문마다 다른 해시 (참여 이력을 모을 수 없다)" "$DISTINCT" "2"

echo "── 남의 설문 선택지로 투표 차단 (집계 오염)"
printf '{"optionId":"%s"}' "$YES" > "$TMP/cross.json"
check "다른 설문의 선택지 거부" \
  "$(code -b "$U2" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/cross.json")" "400"
check "없는 선택지 거부" \
  "$(code -b "$U2" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' \
      -d '{"optionId":"00000000-0000-7000-8000-000000000000"}')" "400"
check "선택지 없이 투표 거부" \
  "$(code -b "$U2" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' -d '{}')" "400"
NO_POLLUTE="$(psql_q "SELECT vote_count FROM poll_options WHERE id='$YES'")"
check "오염 시도로 득표가 늘지 않음" "$NO_POLLUTE" "1"

echo "── 결과 공개 시점: always"
ALWAYS="$(curl -s -b "$U2" "$PL/polls/second")"
contains "투표 전에도 결과 공개" "$ALWAYS" '"showResults":true'
contains "득표 수 포함" "$ALWAYS" '"voteCount":1'

echo "── 결과 공개 시점: after_close"
cat > "$TMP/poll3.json" <<'JSON'
{"slug":"closed-only","question":"종료 후 공개","options_text":"가\n나",
 "result_visibility":"after_close"}
JSON
P3="$(curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll3.json" | jq_get "['id']")"
GA="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P3' AND label='가'")"
printf '{"optionId":"%s"}' "$GA" > "$TMP/v4.json"
V4="$(curl -s -b "$U2" -X POST "$PL/polls/closed-only/vote" -H 'content-type: application/json' --data-binary "@$TMP/v4.json")"
contains "투표는 되지만" "$V4" '"ok":true'
contains "결과는 아직 숨김" "$V4" '"showResults":false'
absent "득표 수 미노출" "$V4" '"percent"'
# 종료시키면 결과가 열린다
psql_q "UPDATE poll_polls SET ends_at = now() - interval '1 hour' WHERE id='$P3'" >/dev/null
CLOSED="$(curl -s -b "$U2" "$PL/polls/closed-only")"
contains "종료 후 결과 공개" "$CLOSED" '"showResults":true'
contains "득표 수 노출" "$CLOSED" '"voteCount":1'
contains "종료 상태" "$CLOSED" '"phase":"closed"'
contains "관리자는 언제나 결과를 본다" "$(curl -s -b "$CK" "$PL/polls/closed-only")" '"showResults":true'

echo "── 기간"
FUTURE="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat())")"
printf '{"slug":"future","question":"미래 설문","options_text":"a\\nb","starts_at":"%s"}' "$FUTURE" > "$TMP/poll4.json"
curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll4.json" >/dev/null
FUT="$(curl -s "$PL/polls/future")"
contains "시작 전 상태" "$FUT" '"phase":"before"'
contains "투표 불가" "$FUT" '"canVote":false'
contains "이유 안내" "$FUT" "아직 시작되지 않은"
FUT_OPT="$(psql_q "SELECT id FROM poll_options WHERE poll_id=(SELECT id FROM poll_polls WHERE slug='future') LIMIT 1")"
printf '{"optionId":"%s"}' "$FUT_OPT" > "$TMP/v5.json"
check "시작 전 투표 차단" \
  "$(code -b "$U1" -X POST "$PL/polls/future/vote" -H 'content-type: application/json' --data-binary "@$TMP/v5.json")" "409"
P3_OPT="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P3' LIMIT 1")"
printf '{"optionId":"%s"}' "$P3_OPT" > "$TMP/v6.json"
check "종료 후 투표 차단" \
  "$(code -b "$U1" -X POST "$PL/polls/closed-only/vote" -H 'content-type: application/json' --data-binary "@$TMP/v6.json")" "409"

echo "── 회원 전용 설문"
cat > "$TMP/poll5.json" <<'JSON'
{"slug":"members-only","question":"회원만","options_text":"찬성\n반대","vote_role":"member",
 "result_visibility":"always"}
JSON
curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll5.json" >/dev/null
MO="$(curl -s "$PL/polls/members-only")"
contains "비로그인은 투표 불가" "$MO" '"canVote":false'
contains "로그인 안내" "$MO" "로그인 후 참여"
MO_OPT="$(psql_q "SELECT id FROM poll_options WHERE poll_id=(SELECT id FROM poll_polls WHERE slug='members-only') AND label='찬성'")"
printf '{"optionId":"%s"}' "$MO_OPT" > "$TMP/v7.json"
check "비로그인 투표 차단" \
  "$(code -X POST "$PL/polls/members-only/vote" -H 'content-type: application/json' --data-binary "@$TMP/v7.json")" "401"
contains "회원은 투표 가능" \
  "$(curl -s -b "$U1" -X POST "$PL/polls/members-only/vote" -H 'content-type: application/json' --data-binary "@$TMP/v7.json")" '"ok":true'

echo "── 복수 선택"
cat > "$TMP/poll6.json" <<'JSON'
{"slug":"multi","question":"관심 분야 (최대 2개)","options_text":"개발\n디자인\n기획\n마케팅",
 "allow_multiple":true,"max_choices":2,"result_visibility":"always"}
JSON
P6="$(curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' --data-binary "@$TMP/poll6.json" | jq_get "['id']")"
DEV="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P6' AND label='개발'")"
DES="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P6' AND label='디자인'")"
PLN="$(psql_q "SELECT id FROM poll_options WHERE poll_id='$P6' AND label='기획'")"
printf '{"optionIds":["%s","%s","%s"]}' "$DEV" "$DES" "$PLN" > "$TMP/over.json"
check "최대 선택 수 초과 차단" \
  "$(code -b "$U1" -X POST "$PL/polls/multi/vote" -H 'content-type: application/json' --data-binary "@$TMP/over.json")" "400"
printf '{"optionIds":["%s","%s"]}' "$DEV" "$DES" > "$TMP/two.json"
MULTI="$(curl -s -b "$U1" -X POST "$PL/polls/multi/vote" -H 'content-type: application/json' --data-binary "@$TMP/two.json")"
contains "복수 선택 투표 성공" "$MULTI" '"ok":true'
CHOICES="$(psql_q "SELECT count(*) FROM poll_vote_choices vc JOIN poll_votes v ON v.id=vc.vote_id WHERE v.poll_id='$P6'")"
check "선택 2건 기록" "$CHOICES" "2"
PARTICIPANTS="$(psql_q "SELECT vote_count FROM poll_polls WHERE id='$P6'")"
check "참여자는 1명 (선택 수와 다르다)" "$PARTICIPANTS" "1"
# 단일 선택 설문에 두 개를 보내면 거부
printf '{"optionIds":["%s","%s"]}' "$RED" "$BLUE" > "$TMP/single2.json"
check "단일 선택 설문에 복수 전송 차단" \
  "$(code -b "$U2" -X POST "$PL/polls/favorite/vote" -H 'content-type: application/json' --data-binary "@$TMP/single2.json")" "400"

echo "── 선택지 문구 수정: 표가 유지되어야 한다"
BEFORE_RED="$(psql_q "SELECT vote_count FROM poll_options WHERE id='$RED'")"
check "빨강 득표 1" "$BEFORE_RED" "1"
cat > "$TMP/poll1edit.json" <<'JSON'
{"slug":"favorite","question":"가장 좋아하는 색은? (수정)","description":"하나만 골라주세요",
 "options_text":"빨강\n파랑\n노랑","result_visibility":"after_vote","vote_role":"guest",
 "allow_comment":true}
JSON
contains "설문 수정" \
  "$(curl -s -b "$CK" -X PUT "$PL/admin/polls/$P1" -H 'content-type: application/json' --data-binary "@$TMP/poll1edit.json")" '"ok":true'
KEPT="$(psql_q "SELECT vote_count FROM poll_options WHERE id='$RED'")"
check "이름이 같은 선택지의 표는 유지" "$KEPT" "1"
GONE="$(psql_q "SELECT count(*) FROM poll_options WHERE poll_id='$P1' AND label='초록'")"
check "목록에서 뺀 선택지는 삭제" "$GONE" "0"
NEW="$(psql_q "SELECT count(*) FROM poll_options WHERE poll_id='$P1' AND label='노랑'")"
check "새 선택지 추가" "$NEW" "1"
STILL="$(psql_q "SELECT vote_count FROM poll_polls WHERE id='$P1'")"
check "참여자 수는 그대로 (실제로 참여했다)" "$STILL" "2"

echo "── 기타 의견 (관리자만, 작성자 없이)"
COMMENTS="$(curl -s -b "$CK" "$PL/admin/polls/$P1/comments")"
contains "의견 조회" "$COMMENTS" "빨강이 제일 좋아요"
absent "작성자 정보 없음 (설문은 익명이 전제)" "$COMMENTS" "user_id"
absent "이메일 없음" "$COMMENTS" "p1@pl.test"
check "비관리자는 의견 조회 불가" "$(code -b "$U1" "$PL/admin/polls/$P1/comments")" "403"

echo "── 관리 목록"
ADMIN="$(curl -s -b "$CK" "$PL/admin/polls")"
contains "선택지 텍스트 역변환" "$ADMIN" "빨강\\n파랑"
contains "공개 시점 라벨" "$ADMIN" '"visibility_label"'
contains "자격 라벨" "$ADMIN" '"role_label"'

echo "── 비활성 설문"
curl -s -b "$CK" -X PUT "$PL/admin/polls/$P2" -H 'content-type: application/json' \
  -d '{"slug":"second","question":"두번째 설문","options_text":"예\n아니오","is_active":false}' >/dev/null
check "비활성 설문은 공개 조회 404" "$(code "$PL/polls/second")" "404"
contains "관리자는 볼 수 있다" "$(curl -s -b "$CK" "$PL/polls/second")" "두번째 설문"
absent "진행 중 목록에서 제외" "$(curl -s "$PL/polls")" "두번째 설문"
contains "진행 중 목록에는 활성 설문" "$(curl -s "$PL/polls")" "가장 좋아하는 색은"

echo "── 블록 렌더"
BLOCKS="$(curl -s "$API/api/blocks")"
contains "설문 블록 등록" "$BLOCKS" "brick-poll/poll"
contains "설문 목록 블록 등록" "$BLOCKS" "brick-poll/poll-list"
HTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-poll/poll","props":{"slug":"favorite"}}' | render_html)"
contains "질문은 서버 렌더 (검색엔진·JS 실패 대비)" "$HTML" "가장 좋아하는 색은? (수정)"
contains "참여자 수 렌더" "$HTML" "참여 2명"
# 인라인 스크립트에 클래스명이 문자열로 들어 있어 클래스명 대조는 무의미하다.
# 실제 불변식은 "서버는 자리표시자만 내고 결과는 클라이언트가 채운다"다.
contains "서버는 자리표시자만 렌더 (결과는 캐시에 담기지 않는다)" "$HTML" "불러오는 중"
absent "득표 수가 서버 HTML 에 없음" "$HTML" "참여 2명</p>\n  <div class=\"brick-poll-body\"><div class=\"brick-poll-result\""
LIST="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-poll/poll-list","props":{"title":"진행 중"}}' | render_html)"
contains "목록 블록" "$LIST" "진행 중"
contains "활성 설문 표시" "$LIST" "가장 좋아하는 색은"
NONE="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-poll/poll","props":{"slug":"nonexistent"}}' | render_html)"
contains "없는 설문은 안내" "$NONE" "진행 중인 설문이 없습니다"

echo "── XSS"
curl -s -b "$CK" -X POST "$PL/admin/polls" -H 'content-type: application/json' \
  -d '{"slug":"xss","question":"<script>alert(1)</script> 질문","options_text":"<img src=x onerror=alert(1)>\n정상","result_visibility":"always"}' >/dev/null
XHTML="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-poll/poll","props":{"slug":"xss"}}' | render_html)"
absent "질문의 스크립트 태그 이스케이프" "$XHTML" "<script>alert(1)</script>"
contains "이스케이프된 형태" "$XHTML" "&lt;script&gt;"
XLIST="$(curl -s -X POST "$API/api/blocks/render" -H 'content-type: application/json' \
  -d '{"name":"brick-poll/poll-list","props":{}}' | render_html)"
absent "목록에서도 이스케이프" "$XLIST" "<script>alert(1)</script>"

echo "── 사이트맵"
ALL=""
for n in $(seq 1 6); do
  R="$(curl -s "$API/sitemap-$n.xml" 2>/dev/null || true)"
  [[ "$R" == *urlset* ]] && ALL="$ALL$R"
done
contains "활성 설문이 사이트맵에 포함" "$ALL" "/poll/favorite"
absent "비활성 설문은 제외" "$ALL" "/poll/second"

echo "── 탈퇴 시 표는 남고 사람만 지운다"
PRE="$(curl -s -b "$U1" "$API/api/me/withdraw/preview")"
contains "탈퇴 안내에 설문 참여 포함" "$PRE" "설문 참여"
VOTES_BEFORE="$(psql_q "SELECT vote_count FROM poll_options WHERE id='$RED'")"
WD="$(curl -s -b "$U1" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
contains "표는 집계에 남는다고 알려준다" "$WD" "집계에 남습니다"
VOTES_AFTER="$(psql_q "SELECT vote_count FROM poll_options WHERE id='$RED'")"
check "득표가 바뀌지 않음 (발표된 결과가 소급 변경되면 안 된다)" "$VOTES_AFTER" "$VOTES_BEFORE"
# 익명화된 표는 user_id 가 없고, voter_hash 는 무작위 값으로 채워진다
ANON="$(psql_q "SELECT count(*) FROM poll_votes WHERE user_id IS NULL")"
[[ "$ANON" -ge 1 ]] && ok "참여자 정보 익명화" || bad "참여자 정보 익명화 (실제 $ANON)"
COMMENT_GONE="$(psql_q "SELECT count(*) FROM poll_votes WHERE comment = '빨강이 제일 좋아요'")"
check "기타 의견은 삭제 (자유 서술은 개인 특정 가능)" "$COMMENT_GONE" "0"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -50 "$TMP/api.log"; exit 1; }
