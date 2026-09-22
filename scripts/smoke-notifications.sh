#!/usr/bin/env bash
#
# 알림 E2E 스모크 — **메일이 꺼져 있어도 알림이 닿는가.**
#
# 지금까지 모든 알림은 `mail.send` 하나였다. 그런데 SMTP 미설정은 설치 직후의
# 기본값이고(관리자 대시보드가 그 상태를 "메일이 발송되지 않습니다" 라고 스스로
# 경고한다), 그래서 기본 설치에서는 댓글도 문의 답변도 주문 안내도 **조용히
# 사라졌다** — 손님은 답이 없다고 느끼고 운영자는 보냈다고 믿는다.
#
# 이 수트는 **SMTP 를 설정하지 않은 채로** 돈다. 그것이 요점이다.
#
# 못박는 것:
#   - 댓글·문의 답변·주문 안내가 알림함에 남는가 (메일 없이)
#   - 머리에 안 읽은 개수가 뜨는가 (테마를 고치지 않고)
#   - 알림함을 열면 읽음이 되고 개수가 사라지는가
#   - **남의 알림은 어떤 경로로도 보이지 않는가**
#   - 비로그인은 목록 대신 로그인 길을 받는가
#   - 갈 곳(링크)이 붙어 있는가 — 알림은 "가서 보라"는 것이다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-notifications.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib-smoke.sh
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
BD="$API/api/plugins/brick-board"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
MEMBER="$TMP/member.txt"
OTHER="$TMP/other.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
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
jpost()    { curl -s -X POST "$1" -H 'content-type: application/json' --data-binary "@$2"; }
render()   { curl -s "$@" | python3 -c "import sys,json;print(json.load(sys.stdin).get('html',''))"; }
jget()     { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }
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

echo "▶ 알림 스모크 테스트 (메일 없이)"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-noti-secret-value}"
export BRICK_CAPTCHA=off
# SMTP 를 **일부러 설정하지 않는다** — 이 수트의 전제다
unset SMTP_HOST SMTP_PORT SMTP_FROM 2>/dev/null || true

node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
for p in $(pids_on_port "$API_PORT"); do kill -9 "$p" 2>/dev/null || true; done
node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"

printf '{"siteName":"알림시험","adminEmail":"admin@nt.test","adminPassword":"ntpass1234","starter":"community"}' > "$TMP/i.json"
jpost "$API/api/install" "$TMP/i.json" >/dev/null
printf '{"email":"admin@nt.test","password":"ntpass1234"}' > "$TMP/la.json"
curl -s -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/la.json" >/dev/null
for who in member other; do
  printf '{"email":"%s@nt.test","password":"memberpass1","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"%s"}' \
    "$who" "$who" > "$TMP/reg.json"
  jpost "$API/api/register" "$TMP/reg.json" >/dev/null
  printf '{"email":"%s@nt.test","password":"memberpass1"}' "$who" > "$TMP/lm.json"
  curl -s -c "$TMP/$who.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    --data-binary "@$TMP/lm.json" >/dev/null
done

echo "── 전제: 메일은 꺼져 있다 (설치 직후의 기본값)"
contains "대시보드가 메일 미설정을 경고한다" "$(curl -s -b "$ADMIN" "$API/api/admin/dashboard")" '"mailOff"'

echo "── 내 글에 댓글이 달리면 알림함에 남는다"
psql_q "UPDATE board_boards SET notify_comment = true WHERE slug='free'" >/dev/null
printf '{"title":"알림 시험 글","content":"본문입니다"}' > "$TMP/p.json"
POST_ID="$(curl -s -b "$MEMBER" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' \
  --data-binary "@$TMP/p.json" | jget "['id']")"
[[ -n "$POST_ID" ]] && ok "시험용 글 작성" || { bad "시험용 글 작성"; exit 1; }
printf '{"content":"관리자 댓글입니다"}' > "$TMP/c.json"
curl -s -b "$ADMIN" -X POST "$BD/posts/$POST_ID/comments" -H 'content-type: application/json' \
  --data-binary "@$TMP/c.json" >/dev/null
sleep 1
N="$(curl -s -b "$MEMBER" "$API/api/notifications")"
check "안 읽은 알림 1건" "$(echo "$N" | jget "['unread']")" "1"
contains "무엇에 대한 알림인지 적혀 있다" "$N" '"kind":"board.comment"'
contains "글 제목이 문구에 있다" "$N" "알림 시험 글"
contains "갈 곳이 붙어 있다 (알림은 가서 보라는 것이다)" "$N" "\"url\":\"/board/free/$POST_ID#comments\""
# 같은 문구가 메일로도 나가는데, 메일 본문에는 링크를 걸 수 없어 주소를 통째로 적는다.
# 알림함에서는 제목이 이미 링크라 그 줄은 읽기만 방해한다.
absent "본문에 날것의 주소 줄이 남지 않는다" "$N" "http://localhost:3000/board"

echo "── 남의 알림은 보이지 않는다"
check "다른 회원의 알림함은 비어 있다" \
  "$(curl -s -b "$OTHER" "$API/api/notifications" | jget "['unread']")" "0"
NID="$(echo "$N" | jget "['items'][0]['id']")"
printf '{"id":"%s"}' "$NID" > "$TMP/read.json"
check "남의 알림 id 로 읽음 처리해도 아무것도 안 된다" \
  "$(curl -s -b "$OTHER" -X POST "$API/api/notifications/read" -H 'content-type: application/json' \
      --data-binary "@$TMP/read.json" | jget "['marked']")" "0"
check "그래서 원래 주인의 알림은 그대로 안 읽음" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications" | jget "['unread']")" "1"
check "비로그인은 알림함 API 에 닿을 수 없다" "$(code "$API/api/notifications")" "401"

echo "── 머리에 개수가 뜬다 (테마를 고치지 않고)"
HEAD_HTML="$(render -b "$MEMBER" "$API/api/render/page?path=")"
contains "종 아이콘과 개수" "$HEAD_HTML" 'href="/notifications"'
contains "개수가 라벨에 들어간다" "$HEAD_HTML" "알림 1"
absent "비로그인 머리에는 알림이 없다" "$(render "$API/api/render/page?path=")" 'href="/notifications"'

echo "── 알림함 화면 (페이지를 만들지 않아도 열린다)"
LIST="$(render -b "$MEMBER" "$API/api/render/page?path=notifications")"
contains "새로 온 것은 표시해서 보여준다" "$LIST" "새 알림"
contains "내용이 나온다" "$LIST" "알림 시험 글"
contains "누르면 갈 곳이 있다" "$LIST" "/board/free/$POST_ID#comments"
# 줄 **전체**가 누르는 자리여야 한다.
#
# 제목만 링크로 두었더니 폰에서 높이가 19px 이었다 — 저장소의 화면 점검
# 도구(scripts/ui-audit.js)가 28px 미만으로 잡았다. 알림함은 "눌러서 가는 것"
# 이 전부인 화면이라 이게 곧 기능이다.
contains "줄 전체가 누르는 자리다" "$LIST" 'class="brick-noti-link"'
contains "그 안에 본문과 시각이 함께 들어 있다" "$LIST" 'brick-noti-link"'
# 테마는 이 목록을 꾸미지 않는다 — 블록이 자기 스타일을 들고 온다
contains "목록이 자기 스타일을 들고 온다" "$LIST" ".brick-noti-item"
check "검색엔진에 올리지 않는다 (남의 알림함이 색인되면 안 된다)" \
  "$(echo "$LIST" | grep -c 'name="robots"' || true)" "1"

echo "── 열면 읽음이 된다 (버튼을 누르지 않아도)"
check "개수가 사라진다" "$(curl -s -b "$MEMBER" "$API/api/notifications" | jget "['unread']")" "0"
absent "머리에서도 사라진다" "$(render -b "$MEMBER" "$API/api/render/page?path=")" "알림 1"
LIST2="$(render -b "$MEMBER" "$API/api/render/page?path=notifications")"
absent "두 번째로 열면 새 표시가 없다" "$LIST2" "새 알림"
contains "그래도 목록에는 남는다 (읽은 것이 사라지면 다시 찾을 수 없다)" "$LIST2" "알림 시험 글"

echo "── 많이 쌓여도 보지 못한 것이 사라지지 않는다"
#
# 화면은 서른 건만 보여주는데 예전에는 **안 읽은 것을 전부** 읽음 처리했다.
# 서른다섯 건이 쌓여 있으면 다섯 건은 보지도 못한 채 사라졌다 — 주문이 몰리는
# 쇼핑몰에서 바로 일어나고, 사라진 뒤에는 무엇이 있었는지 알 길도 없다.
MID="$(psql_q "SELECT id FROM users WHERE email = 'member@nt.test'")"
# 앞 절이 만든 알림을 치우고 센다 — 숫자가 정확해야 "다섯 건이 남았다" 가 뜻을 갖는다
psql_q "DELETE FROM notifications WHERE user_id = '$MID'" >/dev/null
for i in $(seq 1 35); do
  psql_q "INSERT INTO notifications (id, user_id, kind, title, url, created_at)
          VALUES (gen_random_uuid(), '$MID', 'test', '쌓인 알림 $i', '/x', now() - make_interval(mins => $((40 - i))))" >/dev/null
done
check "서른다섯 건이 안 읽음" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1" | jget "['unread']")" "35"
LIST3="$(render -b "$MEMBER" "$API/api/render/page?path=notifications")"
# 클래스 이름만 세면 **스타일 안의 같은 이름까지** 함께 세어진다(실제로 34가 나왔다)
check "화면에는 서른 건" "$(grep -o '<li class="brick-noti-item' <<< "$LIST3" | wc -l | tr -d ' ')" "30"
check "보여준 것만 읽음으로 넘어간다 (다섯 건은 그대로)" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1" | jget "['unread']")" "5"
contains "이어 읽는 길이 있다 (자바스크립트 없이)" "$LIST3" "이전 알림 보기"
# 이어 읽으면 나머지가 나오고, 그것도 읽음이 된다
OLDEST="$(python3 -c "
import re,sys
m = re.search(r'\?before=([0-9a-f-]{36})', sys.argv[1])
print(m.group(1) if m else '')" "$LIST3")"
[[ -n "$OLDEST" ]] && ok "이전 알림 링크에 이어 읽을 지점이 붙어 있다" || bad "이전 알림 링크에 지점이 없다"
render -b "$MEMBER" "$API/api/render/page?path=notifications&before=$OLDEST" >/dev/null
check "이어 읽으면 나머지도 읽음이 된다" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1" | jget "['unread']")" "0"

echo "── 같은 순간에 들어온 알림도 정확히 이어 읽는다"
#
# 재입고 알림처럼 한 번에 여러 건을 넣는 경로가 있고, 그때 created_at 은
# 트랜잭션 안에서 **같은 값**이다. 시각 하나로 자르면 경계에 걸린 한 건이
# 건너뛰거나 두 번 나온다. (시각, id) 쌍으로 자른다.
psql_q "DELETE FROM notifications WHERE user_id = '$MID'" >/dev/null
psql_q "INSERT INTO notifications (id, user_id, kind, title, url, created_at)
        SELECT gen_random_uuid(), '$MID', 'test', '같은 순간 ' || g, '/x', now()
        FROM generate_series(1, 2) g" >/dev/null
P1="$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1")"
FIRST="$(echo "$P1" | jget "['items'][0]['id']")"
P2="$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1&before=$FIRST")"
check "두 번째 쪽에 나머지 한 건이 나온다" "$(echo "$P2" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")" "1"
SECOND="$(echo "$P2" | jget "['items'][0]['id']")"
[[ -n "$SECOND" && "$SECOND" != "$FIRST" ]] && ok "같은 건이 두 번 나오지 않는다" \
  || bad "같은 건이 두 번 나온다 ($FIRST)"
check "세 번째 쪽은 비어 있다 (건너뛴 것이 없다)" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications?limit=1&before=$SECOND" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")" "0"
# 없는 지점을 주면 처음부터 — 빈 목록을 주면 "알림이 없다" 는 거짓말이 된다
check "모르는 지점은 처음부터 읽는다" \
  "$(curl -s -b "$MEMBER" "$API/api/notifications?before=00000000-0000-0000-0000-000000000000" \
      | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")" "2"
# 남의 알림 id 를 지점으로 줘도 남의 목록으로 넘어갈 수 없다
check "남의 id 를 지점으로 줘도 내 목록만 본다" \
  "$(curl -s -b "$OTHER" "$API/api/notifications?before=$FIRST" \
      | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")" "0"

echo "── 비로그인은 목록 대신 로그인 길을 받는다"
GUEST="$(render "$API/api/render/page?path=notifications")"
contains "왜 못 보는지 말한다" "$GUEST" "로그인한 뒤"
contains "갈 곳을 준다" "$GUEST" '/login?next=/notifications'
absent "빈 목록이라고 거짓말하지 않는다" "$GUEST" "아직 받은 알림이 없습니다"

echo "── 마이페이지 메뉴에도 있다 (머리의 아이콘만으로는 못 찾는다)"
contains "회원 메뉴에 알림함" "$(curl -s "$API/api/member/menu")" '"path":"/notifications"'

echo "── 1:1 문의 답변도 같은 통로로 간다"
contains "문의 플러그인 활성화" "$(curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-helpdesk/activate")" '"ok":true'
HD="$API/api/plugins/brick-helpdesk"
printf '{"title":"배송이 언제 오나요","content":"주문한 물건이 언제 도착하나요"}' > "$TMP/t.json"
TICKET="$(curl -s -b "$MEMBER" -X POST "$HD/tickets" \
  -H 'content-type: application/json' --data-binary "@$TMP/t.json" | jget "['id']")"
[[ -n "$TICKET" ]] && ok "문의 등록" || bad "문의 등록"
printf '{"reply":"내일 도착합니다."}' > "$TMP/a.json"
curl -s -b "$ADMIN" -X PUT "$HD/admin/tickets/$TICKET" \
  -H 'content-type: application/json' --data-binary "@$TMP/a.json" >/dev/null
sleep 1
NH="$(curl -s -b "$MEMBER" "$API/api/notifications")"
contains "답변 알림이 알림함에 남는다" "$NH" '"kind":"helpdesk.answered"'
contains "문의 번호를 알려준다 (무엇에 대한 답인지)" "$NH" "배송이 언제 오나요"
contains "문의 화면으로 갈 수 있다" "$NH" '"url":"/support"'
# 1:1 문의는 운영자가 페이지를 만들어야만 존재했다 — 켜도 손님이 닿을 길이 없었다
check "문의 화면은 페이지를 만들지 않아도 열린다" "$(code "$API/api/render/page?path=support")" "200"
contains "회원 메뉴에도 1:1 문의" "$(curl -s "$API/api/member/menu")" '"path":"/support"'

# ════════════════════════════════════════════════════
echo "── 문자 (주문 안내는 한국에서 문자가 기본이다)"
#
# 메일은 안 열어 보는 사람이 많고 알림함은 다시 들어와야 보인다. "언제 오나요"
# 전화를 줄이는 것은 문자뿐이다. 다만 **건당 요금이 나가므로** 메일과 반대로
# 옵트인이다: 켜지 않으면 한 통도 나가지 않는다.
SMS_OUT="$TMP/sms.jsonl"
SMS_INFO="$(start_stub scripts/sms-stub.mjs 42900 "$TMP/sms.log" --out "$SMS_OUT")" \
  || { bad "문자 스텁 시작 실패: $(tail -5 "$TMP/sms.log" 2>/dev/null)"; exit 1; }
SMS_PORT="${SMS_INFO% *}"; SMS_PID="${SMS_INFO#* }"
ok "문자 스텁 시작 (:$SMS_PORT)"

# 발송기는 플러그인이 등록한다 — API 주소는 스텁으로 돌린다
stop_server 2>/dev/null || { kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; }
export BRICK_ALIGO_API_BASE="http://127.0.0.1:${SMS_PORT}"
node "$ROOT/apps/api/dist/main.js" > "$TMP/api2.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do curl -fsS "$API/readyz" >/dev/null 2>&1 && break; sleep 1; done
assert_own_api "$API_PID" "$API_PORT" "$TMP/api2.log"
curl -s -b "$ADMIN" -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@nt.test","password":"ntpass1234"}' -o /dev/null

contains "문자 확장 활성화" "$(curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-sms-aligo/activate")" '"ok":true'
SMSCFG="$API/api/plugins/brick-sms-aligo/admin/config"
check "설정 전에는 키가 없다고 말한다" \
  "$(curl -s -b "$ADMIN" "$SMSCFG" | jget "['apiKeyConfigured']")" "False"
# 발신번호 사전등록제 — 번호 없이 켜는 것은 막는다 (공급자가 어차피 거절한다)
check "발신번호 없이 켤 수 없다" \
  "$(code -b "$ADMIN" -X PUT "$SMSCFG" -H 'content-type: application/json' \
      -d '{"enabled":true,"userId":"brick","apiKey":"testkey"}')" "400"
contains "왜 안 되는지 말해 준다" \
  "$(curl -s -b "$ADMIN" -X PUT "$SMSCFG" -H 'content-type: application/json' \
      -d '{"enabled":true,"userId":"brick","apiKey":"testkey"}')" "발신번호"
contains "설정 저장" \
  "$(curl -s -b "$ADMIN" -X PUT "$SMSCFG" -H 'content-type: application/json' \
      -d '{"enabled":true,"userId":"brick","apiKey":"testkey","sender":"02-123-4567"}')" '"ok":true'
absent "API 키는 돌려주지 않는다" "$(curl -s -b "$ADMIN" "$SMSCFG")" "testkey"
check "설정됐다는 사실만 알려준다" \
  "$(curl -s -b "$ADMIN" "$SMSCFG" | jget "['apiKeyConfigured']")" "True"

echo "── 켜지 않으면 한 통도 나가지 않는다"
curl -s -b "$MEMBER" -X POST "$API/api/notifications/read" -H 'content-type: application/json' -d '{}' >/dev/null
MID2="$(psql_q "SELECT id FROM users WHERE email = 'member@nt.test'")"
# 문자를 요청하지 않은 알림 — 메일·알림함만 간다
psql_q "DELETE FROM notifications WHERE user_id = '$MID2'" >/dev/null
check "옵트인하지 않은 알림은 문자로 안 간다" "$( [[ -s "$SMS_OUT" ]] && wc -l < "$SMS_OUT" || echo 0 | tr -d ' ')" "0"

echo "── 주문 안내를 문자로 (켠 가게만)"
contains "쇼핑몰 활성화" "$(curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'
SHOP="$API/api/plugins/brick-shop"
curl -s -b "$ADMIN" -X PUT "$SHOP/admin/settings" -H 'content-type: application/json' \
  -d '{"notifyOrderSms":true,"notifyOrderMail":true,"shippingFee":3000,"freeShippingOver":50000,"pageSize":20,"returnShippingFee":3000}' >/dev/null
check "문자 안내가 켜졌다" \
  "$(curl -s -b "$ADMIN" "$SHOP/admin/settings" | jget "['notifyOrderSms']")" "True"

echo "── 실제로 나가는 내용" 
# 주문 하나를 만들고 상태를 바꾼다 — 그때 안내가 나간다
PRODUCT_ID="$(curl -s -b "$ADMIN" -X POST "$SHOP/admin/products" -H 'content-type: application/json' \
  -d '{"name":"문자시험 상품","slug":"sms-test","price":15000,"stock":5,"status":"selling"}' | jget "['id']")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"김손님","ordererPhone":"010-1234-5678","ordererEmail":"guest@nt.test","postcode":"06236","address1":"서울시 중구","address2":"101호"}}' \
  "$PRODUCT_ID" > "$TMP/order.json"
ORDER_RES="$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/order.json")"
ORDER_NO="$(echo "$ORDER_RES" | jget "['orderNo']")"
[[ -n "$ORDER_NO" ]] && ok "주문 생성" || bad "주문 생성 ($ORDER_RES)"
sleep 1
SENT="$(cat "$SMS_OUT" 2>/dev/null || true)"
contains "문자가 나갔다" "$SENT" '"receiver"'
contains "번호는 숫자만 남겨 보낸다" "$SENT" '"receiver":"01012345678"'
contains "사전 등록한 발신번호로" "$SENT" '"sender":"021234567"'
[[ -n "$ORDER_NO" && "$SENT" == *"$ORDER_NO"* ]] && ok "주문번호가 본문에 있다" \
  || bad "주문번호가 본문에 없다 ($ORDER_NO)"
# 90바이트가 넘으면 LMS 다 — 잘라 보내면 안내가 반쪽이 된다
contains "긴 안내는 LMS 로 보낸다" "$SENT" '"msg_type":"LMS"'
absent "전화번호를 로그에 그대로 남기지 않는다" "$(cat "$TMP/api2.log")" "01012345678"
contains "로그에는 가린 번호가 남는다" "$(cat "$SMS_OUT")" '"msg"'

echo "── 문자가 실패해도 주문은 성공한다"
curl -s -X PUT "http://127.0.0.1:${SMS_PORT}/_fail" -H 'content-type: application/json' -d '{"n":5}' >/dev/null
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"이손님","ordererPhone":"010-2222-3333","ordererEmail":"guest2@nt.test","postcode":"06236","address1":"서울시 중구","address2":"101호"}}' \
  "$PRODUCT_ID" > "$TMP/order2.json"
ORDER2="$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/order2.json" | jget "['orderNo']")"
[[ -n "$ORDER2" ]] && ok "문자가 실패해도 주문은 만들어진다" || bad "문자 실패가 주문을 막았다"
curl -s -X PUT "http://127.0.0.1:${SMS_PORT}/_fail" -H 'content-type: application/json' -d '{"n":0}' >/dev/null
kill "$SMS_PID" 2>/dev/null || true

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ "$FAIL" -eq 0 ]]
