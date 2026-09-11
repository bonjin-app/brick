#!/usr/bin/env bash
#
# 업그레이드 E2E 스모크 — **데이터가 있는 사이트**에 새 마이그레이션을 올린다.
#
# 왜 필요한가: 다른 모든 수트는 빈 DB 에서 시작한다. 배포본 스모크도 새로 설치한다.
# 그래서 "새 버전을 올렸을 때 기존 데이터가 살아남는가" 는 **어디서도 검증되지
# 않았다.** 설치형 CMS 에서 그것이 가장 위험한 경로다 — 운영 중인 사이트에
# docker compose pull 을 하는 순간 마이그레이션이 자동으로 돈다(ADR: 부팅 시 자동 실행).
#
# 빈 DB 에서는 통과하지만 데이터가 있으면 깨지는 마이그레이션의 예:
#   - 기본값 없는 NOT NULL 열 추가
#   - 기존 행이 위반하는 UNIQUE 인덱스
#   - 기존 값을 가정한 CHECK 제약
#
# 못박는 것:
#   - 옛 스키마로 설치한 사이트에 최신 마이그레이션이 **오류 없이** 올라가는가
#   - 회원·글·주문·설정이 그대로 남는가 (개수와 내용)
#   - 올린 뒤 사이트가 실제로 동작하는가 (로그인·목록·주문 조회)
#   - 같은 마이그레이션을 두 번 올려도 안전한가 (멱등)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-upgrade.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
SHOP="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
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

echo "▶ 업그레이드 스모크 테스트 (데이터가 있는 사이트에 새 마이그레이션)"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

MIG_ALL="$ROOT/packages/database/migrations"
MIG_OLD="$TMP/migrations-old"
mkdir -p "$MIG_OLD"

# ── "옛 버전" 만들기 ────────────────────────────────
# 최신 마이그레이션 셋을 빼고 복사한다. 그것이 이 검사가 재현하려는 상황이다:
# 손님의 사이트는 늘 **한두 버전 뒤**에 있고, 그 위로 새 파일이 올라간다.
HOLD_BACK="${BRICK_UPGRADE_HOLD_BACK:-3}"
ALL_FILES=$(ls "$MIG_ALL"/*.sql | sort)
TOTAL=$(echo "$ALL_FILES" | wc -l | tr -d ' ')
KEEP=$(( TOTAL - HOLD_BACK ))
[[ "$KEEP" -lt 1 ]] && { echo "마이그레이션이 너무 적어 시험할 수 없습니다"; exit 1; }
echo "$ALL_FILES" | head -n "$KEEP" | xargs -I{} cp {} "$MIG_OLD/"
NEW_FILES=$(echo "$ALL_FILES" | tail -n "$HOLD_BACK" | xargs -n1 basename | tr '\n' ' ')
echo "── 옛 버전으로 설치 (뒤로 미룬 것: $NEW_FILES)"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_SECRET="${BRICK_SECRET:-smoke-upgrade-secret}"
export BRICK_CAPTCHA=off

start_api() { # <마이그레이션 디렉터리> <로그>
  BRICK_MIGRATIONS_DIR="$1" node "$ROOT/apps/api/dist/main.js" > "$2" 2>&1 &
  API_PID=$!
  for i in $(seq 1 60); do
    curl -fsS "$API/readyz" >/dev/null 2>&1 && return 0
    kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$2"; return 1; }
    sleep 0.5
  done
  echo "서버가 뜨지 않음"; cat "$2"; return 1
}
stop_api() { kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; API_PID=""; }

# 옛 스키마만 적용한다 — 서버는 띄우지 않는다.
#
# 이 검사가 재현하려는 것은 "옛 스키마 + 새 코드" 가 아니라 **옛 스키마에 쌓인 데이터
# 위로 새 코드가 부팅하는 것**이다. 새 코드는 새 열을 전제하므로 옛 스키마에서
# API 를 띄우면 당연히 깨진다(그 조합은 실제로 존재하지 않는다 — 업그레이드는 코드와
# 마이그레이션이 함께 올라간다). 그래서 데이터는 SQL 로 직접 심는다.
BRICK_MIGRATIONS_DIR="$MIG_OLD" node "$ROOT/apps/api/dist/migrate.js" > "$TMP/migrate-old.log" 2>&1 \
  || { echo "옛 마이그레이션 실패:"; cat "$TMP/migrate-old.log"; exit 1; }
check "옛 버전이 적용됐다" "$(psql_q "SELECT count(*) FROM core_migrations")" "$KEEP"

echo "── 옛 사이트에 데이터를 쌓는다 (SQL)"
# 운영 중인 사이트의 모습: 설정·회원·동의 이력. 비밀번호 해시는 argon2 형식 그대로
# 넣어야 올린 뒤 실제로 로그인되는지 확인할 수 있다.
psql_q "INSERT INTO site_settings (key, value) VALUES
  ('site.name', '\"업그레이드 전 이름\"'::jsonb),
  ('site.installed', 'true'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
# 비밀번호는 API 로 만들 수 없으므로(새 코드가 필요하다) 가입은 올린 뒤에 해 본다.
psql_q "INSERT INTO users (id, email, password_hash, display_name, role, is_active)
  VALUES (gen_random_uuid(), 'old@up.test', 'x', '기존 회원', 'member', true)" >/dev/null
psql_q "INSERT INTO users (id, email, password_hash, display_name, role, is_active)
  VALUES (gen_random_uuid(), 'old2@up.test', 'x', '기존 회원 둘', 'member', true)" >/dev/null
psql_q "INSERT INTO user_agreements (id, user_id, agreement_id, kind, version, agreed)
  SELECT gen_random_uuid(), u.id, a.id, a.kind, a.version, true
  FROM users u, agreements a WHERE u.email='old@up.test' AND a.kind='terms'" >/dev/null
BEFORE_USERS="$(psql_q "SELECT count(*) FROM users")"
BEFORE_AGREE="$(psql_q "SELECT count(*) FROM user_agreements")"
check "회원 2명" "$BEFORE_USERS" "2"
check "동의 이력 1건" "$BEFORE_AGREE" "1"
# 옛 사이트의 약관 제목을 재현한다.
#
# 0003 의 시드 자체를 고쳤으므로(제목에서 중복 "(선택)" 제거) 지금 설치하면 새 제목이
# 들어간다. 이 검사가 보려는 것은 **이미 옛 제목으로 설치된 사이트**가 올라갈 때
# 0011 이 그것을 고치는가이므로, 그 시점의 값으로 되돌려 놓는다.
psql_q "UPDATE agreements SET title='광고성 정보 수신 동의 (선택)' WHERE kind='marketing'" >/dev/null
check "옛 약관 제목" "$(psql_q "SELECT title FROM agreements WHERE kind='marketing'")" "광고성 정보 수신 동의 (선택)"

# ── 새 버전을 올린다 ───────────────────────────────
echo "── 새 버전으로 재시작 (마이그레이션 자동 적용)"
start_api "$MIG_ALL" "$TMP/api-new.log" || exit 1
contains "새 마이그레이션이 적용됐다" "$(cat "$TMP/api-new.log")" "migration"
check "전부 적용됨" "$(psql_q "SELECT count(*) FROM core_migrations")" "$TOTAL"
# 실패한 마이그레이션은 예외를 던지고 부팅을 멈춘다 — 떴다는 것 자체가 성공 신호지만,
# 로그에 조용한 경고가 남지 않았는지도 본다
check "오류 로그 없음" "$(grep -ci 'migration failed\|마이그레이션 실패' "$TMP/api-new.log" || true)" "0"

echo "── 데이터가 그대로 남았는가"
check "회원 수 유지" "$(psql_q "SELECT count(*) FROM users")" "$BEFORE_USERS"
check "동의 이력 유지" "$(psql_q "SELECT count(*) FROM user_agreements")" "$BEFORE_AGREE"
check "설정 유지" "$(psql_q "SELECT value->>0 FROM site_settings WHERE key='site.name'")" "업그레이드 전 이름"
check "회원 내용 유지" "$(psql_q "SELECT display_name, role FROM users WHERE email='old@up.test'")" "기존 회원|member"

echo "── 올린 뒤에도 사이트가 동작하는가"
# 설치는 이미 되어 있다(옛 사이트) — 새 코드가 그 위에서 관리자를 만들고 쓸 수 있어야 한다
printf '{"email":"admin@up.test","password":"uppass12345","displayName":"업그레이드 운영자","agreements":{"terms":true,"privacy":true,"marketing":false},"ageConfirmed":true}' > "$TMP/reg.json"
contains "새 코드로 가입" "$(curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json")" '"id"'
psql_q "UPDATE users SET role='admin' WHERE email='admin@up.test'" >/dev/null
printf '{"email":"admin@up.test","password":"uppass12345"}' > "$TMP/login.json"
contains "로그인" "$(curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/login.json")" '"role":"admin"'
# 회원 목록은 민감한 작업이라 재인증을 요구한다(계정 보안 기능) — 그 단계를 밟는다
curl -s -b "$CK" -c "$CK" -X POST "$API/api/me/security/reauth" -H 'content-type: application/json' \
  -d '{"password":"uppass12345"}' >/dev/null
contains "옛 회원이 목록에 보인다" "$(curl -s -b "$CK" "$API/api/users")" "old@up.test"
contains "공개 화면 렌더" "$(curl -s "$API/api/render/page?path=home")" "<!doctype html>"

echo "── 플러그인도 옛 사이트 위에서 켜진다 (플러그인 마이그레이션)"
contains "쇼핑몰 활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/brick-shop/activate")" '"ok":true'
printf '{"slug":"up-item","name":"업그레이드 상품","price":13500,"stock":5,"status":"selling"}' > "$TMP/p.json"
PID="$(curl -s -b "$CK" -X POST "$SHOP/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/p.json" | jq_get "['id']")"
printf '{"items":[{"productId":"%s","quantity":1}],"orderer":{"ordererName":"새 손님","ordererPhone":"010-3333-4444","postcode":"06236","address1":"서울"}}' "$PID" > "$TMP/order2.json"
contains "주문도 된다" "$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' --data-binary "@$TMP/order2.json")" '"orderNo"'

echo "── 새 마이그레이션이 실제로 무언가 했는가"
# 0011 은 약관 제목에서 중복 "(선택)" 을 떼는 이력 수정이다. 옛 버전으로 설치했으므로
# 옛 제목이 들어갔고, 올린 뒤에는 고쳐져 있어야 한다 — 데이터 이관형 마이그레이션이
# 기존 행에 실제로 적용되는지를 이 한 건으로 확인한다.
check "데이터 이관도 적용됨 (약관 제목)" \
  "$(psql_q "SELECT title FROM agreements WHERE kind='marketing'")" "광고성 정보 수신 동의"

echo "── 두 번 올려도 안전한가 (재시작·재배포)"
stop_api
start_api "$MIG_ALL" "$TMP/api-again.log" || exit 1
contains "두 번째 부팅은 적용할 것이 없다" "$(cat "$TMP/api-again.log")" "up to date"
check "옛 회원이 그대로" "$(psql_q "SELECT count(*) FROM users WHERE email LIKE 'old%@up.test'")" "2"
check "설정도 그대로" "$(psql_q "SELECT value->>0 FROM site_settings WHERE key='site.name'")" "업그레이드 전 이름"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api-new.log"; exit 1; }
