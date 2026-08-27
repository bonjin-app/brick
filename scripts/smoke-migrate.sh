#!/usr/bin/env bash
#
# 그누보드5 데이터 이전 E2E 스모크.
#
# 못박는 것:
#   - 덤프 파서가 실제 데이터에서 깨지지 않는가 (`),(` · 이스케이프 · 줄바꿈)
#   - 리허설이 무엇이 옮겨지고 무엇이 안 옮겨지는지 정확히 보고하는가
#   - 레벨 매핑이 조정 가능한가 (관리자였던 사람이 조용히 회원이 되지 않는가)
#   - **비밀번호가 보존되는가** — 그누보드 비밀번호로 그대로 로그인되는가
#   - 첫 로그인 후 argon2 로 승급되는가
#   - 다시 실행해도 중복이 생기지 않는가 (멱등)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-migrate.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
MG="$API/api/admin/migrate"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
FIXTURE="$ROOT/scripts/fixtures/gnuboard5-sample.sql"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }

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

# 덤프를 JSON 본문으로 감싼다 — 셸에서 이스케이프하면 반드시 깨진다
make_body() {  # make_body <출력파일> [추가 JSON 키=값 ...]
  local out="$1"; shift
  python3 -c '
import json, sys
dump = open(sys.argv[2], encoding="utf-8").read()
body = {"dump": dump}
for pair in sys.argv[3:]:
    k, v = pair.split("=", 1)
    body[k] = json.loads(v)
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(body))
' "$out" "$FIXTURE" "$@"
}

echo "▶ 그누보드 이전 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-migrate-secret-value}"
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
    -d '{"siteName":"이전테스트","adminEmail":"new-admin@brick.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"new-admin@brick.test","password":"adminpass123"}' >/dev/null
for pl in brick-board brick-point; do
  contains "$pl 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/$pl/activate")" '"ok":true'
done

echo "── 권한"
make_body "$TMP/body.json"
check "비관리자는 이전 불가" \
  "$(code -X POST "$MG/analyze" -H 'content-type: application/json' --data-binary "@$TMP/body.json")" "401"
check "빈 덤프 거부" \
  "$(code -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' -d '{"dump":""}')" "400"
check "그누보드가 아닌 SQL 거부" \
  "$(code -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' \
      -d '{"dump":"CREATE TABLE foo (id int); INSERT INTO foo VALUES (1);"}')" "400"
contains "무엇이 잘못됐는지 알려준다" \
  "$(curl -s -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' \
      -d '{"dump":"SELECT 1;"}')" "mysqldump"

echo "── 리허설 (아무것도 쓰지 않는다)"
AN="$(curl -s -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' --data-binary "@$TMP/body.json")"
contains "접두어 자동 감지" "$AN" '"prefix":"g5_"'
contains "회원 7명" "$AN" '"total":7'
contains "이메일 없는 회원 집계" "$AN" '"withoutEmail":1'
contains "이메일 충돌 보고" "$AN" "hong@old.test"
contains "레벨 10 → admin" "$AN" '{"level":10,"count":1,"role":"admin"}'
contains "레벨 8 → manager" "$AN" '{"level":8,"count":1,"role":"manager"}'
contains "레벨 2 → member" "$AN" '"role":"member"'
contains "게시판 4개 감지" "$AN" '"title":"공지사항"'
contains "글·댓글 수 집계" "$AN" '"posts":2'
contains "읽기 권한 접힘 (레벨1 → guest)" "$AN" '"readRole":"guest"'
contains "비밀게시판은 manager 이상" "$AN" '"readRole":"manager"'
contains "글 테이블 없는 게시판 표시" "$AN" '"hasData":false'
contains "포인트 잔액 계산" "$AN" '"members":2'
contains "옮기지 않는 것 안내 (쪽지)" "$AN" "쪽지"
contains "옮기지 않는 것 안내 (방문기록·IP)" "$AN" "IP 원문"
contains "설문 미지원 안내" "$AN" "설문조사"
contains "비밀번호 형식 불명 경고" "$AN" "비밀번호 형식을 알 수 없어"
contains "이메일 중복 경고" "$AN" "이메일이 겹치는"
# 리허설은 아무것도 쓰지 않아야 한다
MEMBER_COUNT="$(psql_q "SELECT count(*) FROM users")"
check "리허설 후에도 회원은 관리자 1명뿐" "$MEMBER_COUNT" "1"
BOARD_COUNT="$(psql_q "SELECT count(*) FROM board_boards")"
check "리허설 후에도 게시판 0개" "$BOARD_COUNT" "0"

echo "── 레벨 매핑 조정 (조용히 결정하지 않는다)"
make_body "$TMP/lv.json" 'levelMapping={"adminFrom":8,"managerFrom":2}'
AN2="$(curl -s -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' --data-binary "@$TMP/lv.json")"
contains "경계를 낮추면 레벨 8도 admin" "$AN2" '{"level":8,"count":1,"role":"admin"}'
contains "레벨 2가 manager 로" "$AN2" '{"level":2,"count":4,"role":"manager"}'
make_body "$TMP/lvbad.json" 'levelMapping={"adminFrom":3,"managerFrom":9}'
AN3="$(curl -s -b "$CK" -X POST "$MG/analyze" -H 'content-type: application/json' --data-binary "@$TMP/lvbad.json")"
absent "manager 경계가 admin 보다 높으면 바로잡는다" "$AN3" '"role":"manager"'

echo "── 실제 이전"
RUN="$(curl -s -b "$CK" -X POST "$MG/run" -H 'content-type: application/json' --data-binary "@$TMP/body.json")"
contains "회원 이전" "$RUN" '"members":{"created":6'
contains "게시판 4개 생성" "$RUN" '"boards":{"created":4'
contains "글 이전" "$RUN" '"posts":{"created":5}'
contains "댓글 이전" "$RUN" '"comments":{"created":2}'
contains "포인트 이월" "$RUN" '"granted":2'

echo "── 회원 검증"
ROLES="$(psql_q "SELECT email, role, is_active FROM users WHERE email LIKE '%old.test' OR email LIKE '%gnuboard.invalid' ORDER BY email")"
contains "최고관리자 → admin" "$ROLES" "admin@old.test|admin|true"
contains "레벨8 → manager" "$ROLES" "staff@old.test|manager|true"
contains "일반회원 → member" "$ROLES" "hong@old.test|member|true"
contains "탈퇴 회원은 비활성" "$ROLES" "left@old.test|member|false"
contains "이메일 없는 회원은 내부 주소" "$ROLES" "noemail@gnuboard.invalid"
DUP="$(psql_q "SELECT count(*) FROM users WHERE display_name = '중복회원'")"
check "이메일이 겹친 회원은 건너뜀" "$DUP" "0"
NICK="$(psql_q "SELECT display_name FROM users WHERE email = 'hong@old.test'")"
check "닉네임을 표시명으로 쓴다" "$NICK" "길동"
WEIRD="$(psql_q "SELECT password_hash LIKE 'unusable:%' FROM users WHERE email = 'weird@old.test'")"
check "형식 불명 해시는 쓸 수 없는 값으로" "$WEIRD" "true"
LEGACY="$(psql_q "SELECT password_hash LIKE 'legacy:%' FROM users WHERE email = 'hong@old.test'")"
check "레거시 해시로 보존" "$LEGACY" "true"

echo "── 비밀번호 보존 (이전 도구의 성패)"
# 그누보드 MD5('password') = 5f4dcc3b5aa765d61d8327deb882cf99
LOGIN_MD5="$(curl -s -c "$TMP/hong.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"hong@old.test","password":"password"}')"
contains "구형 MD5 비밀번호로 로그인 성공" "$LOGIN_MD5" '"role":"member"'
check "틀린 비밀번호는 거부" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"hong@old.test","password":"wrongpassword"}')" "401"
# bcrypt($2y$) 해시는 'password' 를 담고 있다
LOGIN_BCRYPT="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@old.test","password":"password"}')"
contains "bcrypt(\$2y\$) 비밀번호로 로그인 성공" "$LOGIN_BCRYPT" '"role":"admin"'
check "형식 불명 계정은 비밀번호 로그인 불가" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"weird@old.test","password":"plaintext-not-a-hash"}')" "401"
check "탈퇴 회원은 로그인 불가" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"left@old.test","password":"password"}')" "401"

echo "── 자동 승급 (약한 해시를 영구히 두지 않는다)"
UPGRADED="$(psql_q "SELECT password_hash LIKE '\$argon2%' FROM users WHERE email = 'hong@old.test'")"
check "첫 로그인 후 argon2 로 승급" "$UPGRADED" "true"
NOT_YET="$(psql_q "SELECT password_hash LIKE 'legacy:%' FROM users WHERE email = 'staff@old.test'")"
check "로그인하지 않은 계정은 아직 레거시" "$NOT_YET" "true"
contains "승급 후에도 같은 비밀번호로 로그인" \
  "$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"hong@old.test","password":"password"}')" '"role":"member"'

echo "── 게시판 검증"
BOARDS="$(psql_q "SELECT slug, read_role, write_role, allow_secret FROM board_boards ORDER BY slug")"
contains "공지: 읽기 guest, 쓰기 admin" "$BOARDS" "notice|guest|admin"
contains "자유: 읽기 guest, 쓰기 member" "$BOARDS" "free|guest|member"
contains "비밀게시판: 읽기 manager" "$BOARDS" "secret-room|manager|manager"
contains "비밀글 설정 이어짐" "$BOARDS" "free|guest|member|true"
SLUG="$(psql_q "SELECT count(*) FROM board_boards WHERE slug = 'secret-room'")"
check "밑줄이 하이픈으로 정규화 (secret_room → secret-room)" "$SLUG" "1"
EMPTY_BOARD="$(psql_q "SELECT count(*) FROM board_boards WHERE slug = 'empty'")"
check "글 없는 게시판도 만들어짐" "$EMPTY_BOARD" "1"

echo "── 게시글 검증 (파서가 실제 데이터에서 깨지지 않는가)"
HTML_POST="$(psql_q "SELECT content FROM board_posts WHERE title = '사이트 이용 안내'")"
contains "HTML 글은 그대로" "$HTML_POST" "<p>안녕하세요.</p>"
PLAIN_POST="$(psql_q "SELECT content FROM board_posts WHERE title = '줄바꿈이 있는 평문 공지'")"
contains "평문 줄바꿈이 <br> 로" "$PLAIN_POST" "첫째 줄입니다.<br />"
absent "백슬래시-n 이 문자로 남지 않음" "$PLAIN_POST" '\n둘째'
PAREN="$(psql_q "SELECT content FROM board_comments WHERE content LIKE '%괄호%'")"
contains "본문의 ),( 가 온전히 보존" "$PAREN" "(1,2),(3,4)"
QUOTE="$(psql_q "SELECT content FROM board_comments WHERE content LIKE '%따옴표%'")"
contains "이스케이프된 작은따옴표 복원" "$QUOTE" "It's a test, isn't it?"
contains "이스케이프된 큰따옴표 복원" "$QUOTE" '"큰따옴표"'
ORPHAN="$(psql_q "SELECT count(*) FROM board_comments WHERE content LIKE '%고아 댓글%'")"
check "원글 없는 댓글은 버려짐" "$ORPHAN" "0"
CMT_COUNT="$(psql_q "SELECT comment_count FROM board_posts WHERE title = '사이트 이용 안내'")"
check "댓글 수 재계산" "$CMT_COUNT" "2"
AUTHOR="$(psql_q "SELECT u.email FROM board_posts p JOIN users u ON u.id = p.author_id WHERE p.title = '사이트 이용 안내'")"
check "작성자가 이전된 회원에 연결" "$AUTHOR" "admin@old.test"
GUEST_POST="$(psql_q "SELECT author_id IS NULL, author_name FROM board_posts WHERE title = '비회원이 쓴 글'")"
check "비회원 글은 작성자 없이 이름만" "$GUEST_POST" "true|손님"
SECRET_POST="$(psql_q "SELECT is_secret FROM board_posts WHERE title = '비밀글입니다'")"
check "비밀글 표시 이어짐" "$SECRET_POST" "true"
BAD_DATE="$(psql_q "SELECT created_at IS NOT NULL FROM board_posts WHERE title = '날짜가 이상한 글'")"
check "0000-00-00 날짜는 현재 시각으로 대체" "$BAD_DATE" "true"
HIT="$(psql_q "SELECT view_count, up_count FROM board_posts WHERE title = '사이트 이용 안내'")"
check "조회수·추천수 이어짐" "$HIT" "1523|12"
CATEGORY="$(psql_q "SELECT category FROM board_posts WHERE title = '사이트 이용 안내'")"
check "분류 이어짐" "$CATEGORY" "안내"

echo "── 포인트 이월"
PT_ADMIN="$(psql_q "SELECT sum(remaining) FROM point_ledger pl JOIN users u ON u.id = pl.user_id WHERE u.email = 'admin@old.test'")"
check "admin 잔액 800 (1000+100-300)" "$PT_ADMIN" "800"
PT_HONG="$(psql_q "SELECT count(*) FROM point_ledger pl JOIN users u ON u.id = pl.user_id WHERE u.email = 'hong@old.test'")"
check "전액 사용한 회원은 이월 없음" "$PT_HONG" "0"
PT_REASON="$(psql_q "SELECT DISTINCT reason FROM point_ledger WHERE ref_type = 'gnuboard.carryover'")"
check "이월 사유 표기" "$PT_REASON" "그누보드 이월"
PT_EXP="$(psql_q "SELECT count(*) FROM point_ledger WHERE ref_type = 'gnuboard.carryover' AND expires_at IS NOT NULL")"
check "이월 포인트에 임의 만료를 붙이지 않음" "$PT_EXP" "0"

echo "── 멱등성 (다시 실행해도 중복이 없다)"
RUN2="$(curl -s -b "$CK" -X POST "$MG/run" -H 'content-type: application/json' --data-binary "@$TMP/body.json")"
contains "두 번째 실행은 회원을 건너뜀" "$RUN2" '"created":0'
contains "게시판도 건너뜀" "$RUN2" '"boards":{"created":0'
DUP_MEMBERS="$(psql_q "SELECT count(*) FROM users WHERE email = 'hong@old.test'")"
check "회원 중복 없음" "$DUP_MEMBERS" "1"
DUP_BOARDS="$(psql_q "SELECT count(*) FROM board_boards WHERE slug = 'notice'")"
check "게시판 중복 없음" "$DUP_BOARDS" "1"
PT_AFTER="$(psql_q "SELECT sum(remaining) FROM point_ledger pl JOIN users u ON u.id = pl.user_id WHERE u.email = 'admin@old.test'")"
check "포인트가 두 배로 늘지 않음" "$PT_AFTER" "800"

echo "── 선택 이전 (게시판 골라 옮기기)"
node "$ROOT/scripts/reset-test-db.mjs" >/dev/null
# 서버를 재시작해 새 DB로 붙인다
kill "$API_PID" 2>/dev/null || true
sleep 2
node "$ROOT/apps/api/dist/main.js" > "$TMP/api2.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do curl -fsS "$API/readyz" >/dev/null 2>&1 && break; sleep 1; done
curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
  -d '{"siteName":"이전2","adminEmail":"a2@brick.test","adminPassword":"adminpass123"}' >/dev/null
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"a2@brick.test","password":"adminpass123"}' >/dev/null
curl -s -b "$CK" -X POST "$API/api/plugins/brick-board/activate" >/dev/null

make_body "$TMP/sel.json" 'boards=["notice"]' 'points=false'
RUN3="$(curl -s -b "$CK" -X POST "$MG/run" -H 'content-type: application/json' --data-binary "@$TMP/sel.json")"
contains "고른 게시판만 생성" "$RUN3" '"boards":{"created":1'
ONLY="$(psql_q "SELECT count(*) FROM board_boards")"
check "게시판 1개만" "$ONLY" "1"
NO_POINT="$(psql_q "SELECT to_regclass('point_ledger') IS NULL")"
check "포인트 플러그인이 없으면 테이블도 없음" "$NO_POINT" "true"
# 사용자가 points=false 로 명시적으로 껐으므로 경고할 것이 없다.
# 경고를 내면 "내가 끈 것"에 대해 잔소리하는 셈이다.
absent "명시적으로 끈 포인트에는 경고하지 않음" "$RUN3" "포인트 플러그인이 활성화"
contains "고르지 않은 게시판의 글은 이전되지 않음" "$RUN3" '"posts":{"created":2}' 

echo "── 감사 로그"
AUDIT="$(psql_q "SELECT count(*) FROM audit_logs WHERE action = 'migrate.gnuboard'")"
[[ "$AUDIT" -ge 1 ]] && ok "이전 작업이 감사 로그에 남음" || bad "이전 작업이 감사 로그에 남음"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
