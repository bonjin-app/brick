#!/usr/bin/env bash
#
# 백업·복원 E2E 스모크 — **덤프를 뜨고 실제로 되돌린다.**
#
# 왜 필요한가: docs/operations.md 가 `backup.js dump` / `restore` 를 안내하는데
# 어떤 수트도 그것을 왕복시키지 않았다. 덤프가 떠지는지, 복원이 실제로 내용을
# 되살리는지 아무도 확인한 적이 없고, 운영자는 **정말 필요한 순간에** 알게 된다.
# 설치형 CMS 에서 그보다 늦게 알면 안 되는 것은 없다.
#
# 못박는 것:
#   - 덤프 파일이 만들어지고 비어 있지 않은가
#   - 지운 데이터가 복원으로 돌아오는가 (회원·페이지·설정)
#   - 덤프 **이후에** 만든 데이터는 사라지는가 (복원의 의미를 운영자가 오해하지 않도록)
#   - 복원한 사이트가 실제로 동작하는가 (로그인·목록)
#   - 앱이 **돌고 있는 중에** 복원해도 되는가 — 문서가 그렇게 시키고 있다
#     (`docker compose exec brick ... restore`). 안 되면 그것이 이 수트의 발견이다.
#   - pg_dump 가 없을 때 사람이 조치할 수 있는 말을 하는가
#
# 필요한 것: pg_dump / pg_restore (PostgreSQL 클라이언트). 서버와 **주 버전이
# 같거나 더 새로워야** 한다 — 옛 클라이언트는 새 서버를 거부한다. CI 는
# postgresql-client 17 을 설치해 PATH 앞에 둔다.
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-backup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib-smoke.sh
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
DUMP="$TMP/site.dump"
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

echo "▶ 백업·복원 스모크 테스트 (덤프를 뜨고 실제로 되돌린다)"

# ── 도구 확인 ──────────────────────────────────────
# 없으면 건너뛰지 않고 **실패한다**. 건너뛴 검사는 검사가 아니고, 하필 이 수트가
# 확인하는 것이 "정말 필요한 순간에 되는가" 다.
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "  ❌ pg_dump/pg_restore 가 없습니다 — PostgreSQL 클라이언트를 설치하세요."
  echo "     서버와 주 버전이 같거나 더 새로워야 합니다 (예: apt install postgresql-client-17)."
  echo "     macOS: brew install libpq && brew link --force libpq"
  exit 1
fi
echo "  ✅ pg_dump $(pg_dump --version | awk '{print $3}') · pg_restore 있음"
PASS=$((PASS+1))

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-backup-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done
# 우리가 띄운 서버와 이야기하는지 확인한다 (scripts/lib-smoke.sh 의 설명 참고)
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"

# ── 백업할 내용 만들기 ─────────────────────────────
echo "── 사이트를 만든다"
if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  printf '{"siteName":"백업 시험","adminEmail":"admin@bak.test","adminPassword":"bakpass1234"}' > "$TMP/i.json"
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' --data-binary "@$TMP/i.json" >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@bak.test","password":"bakpass1234"}' >/dev/null
contains "관리자 로그인" "$(curl -s -b "$CK" "$API/api/auth/me")" "admin@bak.test"

curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"backup-page","title":"백업 전에 만든 페이지","status":"published","blocks":[]}' >/dev/null
# 가입은 필수 동의를 요구한다(그것이 이 사이트의 계약이다) — 화면이 보내는 그대로 보낸다
register() {  # register <이메일> <비밀번호> <이름>
  curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/register" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\",\"displayName\":\"$3\",\"agreements\":{\"terms\":true,\"privacy\":true}}"
}
check "백업 전 회원 가입" "$(register before@bak.test beforepass123 "백업 전 회원")" "201"
check "백업 전 페이지 1개" "$(psql_q "SELECT count(*) FROM pages WHERE slug='backup-page'")" "1"
check "백업 전 회원 있음" "$(psql_q "SELECT count(*) FROM users WHERE email='before@bak.test'")" "1"

# ── 덤프 ───────────────────────────────────────────
echo "── 백업을 뜬다"
node "$ROOT/apps/api/dist/backup.js" dump "$DUMP" > "$TMP/dump.log" 2>&1 \
  && ok "덤프 성공" || bad "덤프 실패 ($(tail -2 "$TMP/dump.log"))"
DUMP_SIZE="$(wc -c < "$DUMP" 2>/dev/null | tr -d ' ' || echo 0)"
[[ "$DUMP_SIZE" -gt 10000 ]] && ok "덤프 파일이 비어 있지 않다 (${DUMP_SIZE} 바이트)" \
  || bad "덤프 파일이 너무 작다 (${DUMP_SIZE} 바이트)"
contains "업로드 파일도 함께 보관하라고 알린다" "$(cat "$TMP/dump.log")" "업로드 파일도 함께 보관"

# ── 사고 ───────────────────────────────────────────
echo "── 사고를 낸다 (지우고, 덤프 뒤에 새 것을 만든다)"
psql_q "DELETE FROM pages WHERE slug='backup-page'" >/dev/null
psql_q "DELETE FROM users WHERE email='before@bak.test'" >/dev/null
check "덤프 뒤 새 회원 가입" "$(register after@bak.test afterpass123 "백업 후 회원")" "201"
check "지운 페이지가 없다" "$(psql_q "SELECT count(*) FROM pages WHERE slug='backup-page'")" "0"
# 지운 것이 정말 지워졌는지도 본다 — 삭제가 실패하면 뒤의 "돌아왔다" 가 거짓으로 통과한다
check "지운 회원이 없다" "$(psql_q "SELECT count(*) FROM users WHERE email='before@bak.test'")" "0"
check "덤프 뒤 만든 회원이 있다" "$(psql_q "SELECT count(*) FROM users WHERE email='after@bak.test'")" "1"

# ── 복원 ───────────────────────────────────────────
#
# **앱을 켠 채로** 복원한다 — 문서가 그렇게 시킨다
# (`docker compose exec brick node /app/api/dist/backup.js restore …`).
# 운영자는 서비스를 내리지 않고 이 명령을 친다. 여기서 되는지 못박는다.
echo "── 앱이 돌고 있는 채로 복원한다 (문서가 시키는 그대로)"
node "$ROOT/apps/api/dist/backup.js" restore "$DUMP" > "$TMP/restore.log" 2>&1 \
  && ok "복원 성공" || bad "복원 실패 ($(tail -3 "$TMP/restore.log"))"
contains "덮어쓴다고 먼저 알린다" "$(cat "$TMP/restore.log")" "기존 데이터를 덮어씁니다"

check "지웠던 페이지가 돌아왔다" "$(psql_q "SELECT count(*) FROM pages WHERE slug='backup-page'")" "1"
check "페이지 제목까지 그대로" "$(psql_q "SELECT title FROM pages WHERE slug='backup-page'")" "백업 전에 만든 페이지"
check "지웠던 회원이 돌아왔다" "$(psql_q "SELECT count(*) FROM users WHERE email='before@bak.test'")" "1"
# 복원은 "그 시점으로 되돌리는 것" 이다 — 그 뒤의 것은 사라진다. 운영자가 오해하면 안 되는 지점이라 못박는다.
check "덤프 뒤에 만든 회원은 사라진다" "$(psql_q "SELECT count(*) FROM users WHERE email='after@bak.test'")" "0"

# ── 복원한 사이트가 실제로 동작하는가 ──────────────
#
# 행 개수만 세면 "복원했는데 사이트가 안 뜬다" 를 놓친다. 연결 풀은 복원 중에
# 끊긴 커넥션을 들고 있을 수 있다 — 실제 요청으로 확인한다.
echo "── 복원한 사이트가 동작한다"
for _ in $(seq 1 15); do [[ "$(code "$API/readyz")" == "200" ]] && break; sleep 1; done
check "readyz 회복" "$(code "$API/readyz")" "200"
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@bak.test","password":"bakpass1234"}' >/dev/null
contains "복원 뒤에도 로그인된다" "$(curl -s -b "$CK" "$API/api/auth/me")" "admin@bak.test"
contains "복원한 페이지가 목록에 있다" "$(curl -s -b "$CK" "$API/api/pages")" "backup-page"
check "복원 전에 있던 회원으로도 로그인된다" \
  "$(code -X POST "$API/api/auth/login" -H 'content-type: application/json' \
      -d '{"email":"before@bak.test","password":"beforepass123"}')" "201"

# ── 사람이 조치할 수 있는 말을 하는가 ──────────────
echo "── 잘못 쓰면 알려준다"
USAGE="$(node "$ROOT/apps/api/dist/backup.js" 2>&1 || true)"
contains "인자 없이 부르면 사용법" "$USAGE" "사용법"
UNKNOWN="$(node "$ROOT/apps/api/dist/backup.js" bogus "$DUMP" 2>&1 || true)"
contains "모르는 명령을 알려준다" "$UNKNOWN" "알 수 없는 명령"
NOFILE="$(node "$ROOT/apps/api/dist/backup.js" restore "$TMP/none.dump" 2>&1 || true)"
contains "없는 파일이면 실패를 알린다" "$NOFILE" "[backup] 실패"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
# 실측을 남긴다(설정됐을 때만) — README 의 표가 실제와 같은지 CI 가 대조한다.
# 표의 숫자는 조용히 썩는다: 단언을 더해도 아무도 그 줄을 고치지 않는다.
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
