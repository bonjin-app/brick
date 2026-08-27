#!/usr/bin/env bash
#
# 배포본(FTP 설치) E2E 스모크 테스트.
#
# 검증하는 것: "그누보드처럼 올려서 브라우저로 설치"가 실제로 되는가.
#   - 빌드/의존성 설치 없이 실행되는가
#   - DATABASE_URL 없이 설치 모드로 뜨는가
#   - 브라우저에서 DB 정보를 받아 설정 파일을 쓰는가
#   - 재시작 후 마이그레이션이 자동 적용되는가
#   - 프록시가 런타임 포트로 붙는가 (빌드 타임 고정 아님)
#   - 플러그인이 동작하는가 (node_modules 위치 문제)
#   - 강제 종료 후 재시작이 되는가 (고아 프로세스 정리)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-release.sh
#   (DATABASE_URL은 설치 마법사에 입력할 DB를 가리킨다)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BRICK_RELEASE_TEST_PORT:-4310}"
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
CK="$WORK/ck.txt"
PASS=0; FAIL=0
LAUNCHER_PID=""

cleanup() {
  stop_app
  # 실패했으면 진단을 위해 작업 디렉터리를 남긴다
  if [[ $FAIL -eq 0 ]]; then
    rm -rf "$WORK"
  else
    echo "진단용 작업 디렉터리를 남겨둡니다: $WORK"
  fi
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }

# 런처 PID를 파일로 받아둔다.
# pkill -f "server.js" 같은 패턴은 실제 커맨드라인과 어긋나거나 다른 프로세스를
# 잡을 수 있어 신뢰할 수 없다.
# start_app <태그> <준비조건>
#
# 준비조건:
#   setup  — 설치 모드로 응답 (DB 미설정)
#   ready  — /readyz 가 200 (DB 연결 완료)
#
# 왜 조건을 나누는가: 죽어가는 이전 인스턴스가 /api/install/status 에 응답할 수 있어,
# 그것만 보면 "새 인스턴스가 떴다"고 오판한다(실제로 겪은 오탐).
# 고아가 낼 수 없는 신호를 기다려야 한다.
start_app() {
  local tag="$1" condition="${2:-setup}"
  (
    cd "$APP" || exit 1
    # DATABASE_URL을 앱에 넘기지 않는다 — FTP 설치 상황(환경변수 없음)을 재현해야 한다.
    # (이 스크립트의 DATABASE_URL은 설치 마법사에 "입력할" 값으로만 쓴다)
    env -u DATABASE_URL -u BRICK_SECRET -u BRICK_CONFIG_PATH \
        -u BRICK_PLUGINS_DIR -u BRICK_THEMES_DIR -u BRICK_UPLOADS_DIR -u BRICK_MIGRATIONS_DIR \
        -u BRICK_API_URL -u BRICK_API_PORT -u BRICK_SITE_URL \
        BRICK_CAPTCHA=off PORT="$PORT" node server.js > "$WORK/run-$tag.log" 2>&1 &
    echo $! > "$WORK/launcher.pid"
  )
  LAUNCHER_PID="$(cat "$WORK/launcher.pid" 2>/dev/null || echo "")"

  for _ in $(seq 1 90); do
    if [[ "$condition" == "ready" ]]; then
      [[ "$(code "$BASE/readyz")" == "200" ]] && return 0
    else
      curl -fsS "$BASE/api/setup/status" >/dev/null 2>&1 && return 0
    fi
    # 런처가 죽었으면 더 기다릴 필요가 없다
    if [[ -n "$LAUNCHER_PID" ]] && ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  echo "앱이 시작되지 않았습니다 (조건: $condition, log: $WORK/run-$tag.log):"
  sed 's/\x1b\[[0-9;]*m//g' "$WORK/run-$tag.log" | tail -25 || true
  return 1
}

stop_app() {
  [[ -n "${LAUNCHER_PID:-}" ]] && kill "$LAUNCHER_PID" 2>/dev/null || true
  sleep 2
  # 자식(api/web)이 남아 있으면 포트로 찾아 정리
  for p in $(lsof -nP -iTCP:"$PORT" -iTCP:"$((PORT+1))" 2>/dev/null | awk 'NR>1{print $2}' | sort -u); do
    kill -9 "$p" 2>/dev/null || true
  done
  sleep 1
}

# ── DB 접속 정보 파싱 (설치 마법사에 넣을 값) ──────────
DB_URL="${DATABASE_URL:?DATABASE_URL이 필요합니다 (설치 마법사에 입력할 DB)}"
eval "$(node -e "
const u = new URL(process.env.DATABASE_URL);
const q = (s) => JSON.stringify(decodeURIComponent(s));
console.log('DB_HOST=' + q(u.hostname));
console.log('DB_PORT=' + (u.port || 5432));
console.log('DB_NAME=' + q(u.pathname.slice(1)));
console.log('DB_USER=' + q(u.username));
console.log('DB_PASS=' + q(u.password));
")"

echo "▶ 배포본(FTP 설치) 스모크 테스트"

# 매번 빈 DB에서 시작한다 — 스모크 테스트는 "설치 전" 상태를 전제로 한다.
# (로컬 반복 실행 시 이전 데이터가 남아 실패하는 것을 막는다)
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi


echo "── 배포본 생성"
bash "$ROOT/scripts/build-release.sh" 0.0.0-smoke >/dev/null 2>&1
TARBALL="$ROOT/dist-release/brick-0.0.0-smoke.tar.gz"
[[ -f "$TARBALL" ]] && ok "tarball 생성" || { bad "tarball 생성"; exit 1; }

echo "── 격리 디렉터리에 전개 (FTP 업로드 재현)"
tar xzf "$TARBALL" -C "$WORK"
APP="$WORK/brick"
[[ -f "$APP/server.js" ]] && ok "server.js 포함" || bad "server.js 포함"
[[ -d "$APP/node_modules/drizzle-orm" ]] && ok "node_modules가 루트에 있음(플러그인 공유)" || bad "node_modules가 루트에 있음"
[[ -d "$APP/node_modules/@brick/plugin-sdk" ]] && ok "plugin-sdk 포함" || bad "plugin-sdk 포함"
[[ -d "$APP/api/dist" && -f "$APP/web/apps/web/server.js" ]] && ok "api·web 빌드 산출물 포함" || bad "api·web 빌드 산출물 포함"
[[ ! -d "$APP/api/src" ]] && ok "소스는 제외됨" || bad "소스는 제외됨"

echo "── 1차 실행 (환경변수는 PORT만 — 설치 모드여야 한다)"
start_app 1 setup
contains "설치 모드로 부팅" "$(curl -s "$BASE/api/install/status")" "needs_database"
check "healthz는 200 (프로세스 생존)" "$(code "$BASE/healthz")" "200"
check "readyz는 503 (아직 트래픽 불가)" "$(code "$BASE/readyz")" "503"
check "홈은 설치 화면으로 리다이렉트" "$(code "$BASE/")" "302"
SETUP="$(curl -s "$BASE/api/setup/status")"
contains "설정 파일 경로 안내" "$SETUP" "brick.config.json"
contains "쓰기 가능 확인" "$SETUP" '"configWritable":true'

echo "── 프록시가 런타임 포트로 붙는가 (빌드 타임 고정이면 실패)"
# 공개 포트는 $PORT, 내부 API는 $PORT+1. 빌드 시점 값(3001)이 박혀 있으면 502가 난다.
check "/api/* 프록시 동작" "$(code "$BASE/api/setup/status")" "200"

echo "── DB 연결 테스트 (설치 마법사가 하는 호출)"
printf '{"host":"%s","port":%s,"database":"%s","user":"%s","password":"%s"}' \
  "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_USER" "$DB_PASS" > "$WORK/db.json"
contains "연결 성공" "$(curl -s -X POST "$BASE/api/setup/test" -H 'content-type: application/json' --data-binary "@$WORK/db.json")" '"ok":true'
printf '{"host":"%s","port":%s,"database":"%s","user":"%s","password":"definitely-wrong"}' \
  "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_USER" > "$WORK/bad.json"
contains "잘못된 비밀번호는 명확한 안내" "$(curl -s -X POST "$BASE/api/setup/test" -H 'content-type: application/json' --data-binary "@$WORK/bad.json")" "비밀번호"

echo "── DB 설정 저장"
contains "저장 성공" "$(curl -s -X POST "$BASE/api/setup/save" -H 'content-type: application/json' --data-binary "@$WORK/db.json")" '"restartRequired":true'
[[ -f "$APP/data/brick.config.json" ]] && ok "설정 파일 생성" || bad "설정 파일 생성"
PERM="$(stat -f "%Lp" "$APP/data/brick.config.json" 2>/dev/null || stat -c "%a" "$APP/data/brick.config.json")"
check "설정 파일 권한 600 (DB 비밀번호 보호)" "$PERM" "600"
contains "시크릿 자동 생성" "$(cat "$APP/data/brick.config.json")" '"secret"'

echo "── 강제 종료 후 재시작 (고아 프로세스 정리)"
# SIGKILL로 런처만 죽여 자식을 고아로 만든다 — 호스팅 패널의 강제 재시작 상황.
# 자식(api/web)은 살아남아 포트를 계속 점유한다.
ORPHAN_PIDS="$(cat "$APP/data/brick.pid" 2>/dev/null || echo '[]')"
kill -9 "$LAUNCHER_PID" 2>/dev/null || true
sleep 2
# 전제 확인: 고아가 실제로 포트를 물고 있어야 이 시나리오가 의미가 있다
ORPHANS_HOLDING="$(lsof -nP -iTCP:"$PORT" -iTCP:"$((PORT+1))" 2>/dev/null | awk 'NR>1' | wc -l | tr -d ' ')"
if [[ "$ORPHANS_HOLDING" -gt 0 ]]; then
  ok "강제 종료 후 고아가 포트 점유 (전제 성립)"
else
  bad "강제 종료 후 고아가 포트 점유 (전제 불성립 — 시나리오 재현 실패)"
fi
# 새 인스턴스는 DB가 연결된 상태여야 하므로 readyz 200 을 기다린다.
# (죽어가는 고아는 이 신호를 낼 수 없다 — 설치 모드였으므로 503)
if ! start_app 2 ready; then
  echo "  (재시작 실패)"
fi
contains "고아 정리 후 정상 시작" "$(cat "$WORK/run-2.log")" "이전 프로세스 정리"
contains "마이그레이션 자동 적용" "$(cat "$WORK/run-2.log")" "migration"
contains "설치 단계로 진행" "$(curl -s "$BASE/api/install/status")" "not_installed"
check "readyz 200 (DB 연결됨)" "$(code "$BASE/readyz")" "200"
check "설치 전에도 healthz는 200" "$(code "$BASE/healthz")" "200"

echo "── 사이트 설치"
printf '{"siteName":"Release Smoke","adminEmail":"admin@rel.test","adminPassword":"relpass1234"}' > "$WORK/inst.json"
contains "설치 완료" "$(curl -s -X POST "$BASE/api/install" -H 'content-type: application/json' --data-binary "@$WORK/inst.json")" '"ok":true'
printf '{"email":"admin@rel.test","password":"relpass1234"}' > "$WORK/login.json"
contains "관리자 로그인" "$(curl -s -c "$CK" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' --data-binary "@$WORK/login.json")" '"role":"admin"'

echo "── 동봉 플러그인 (node_modules 해석 검증)"
# 배포본에 무엇이 들어갔는지는 조용히 썩는 지점이다 — 한때 Docker 이미지에는
# 게시판만, 배포본에는 셋만 들어가서 쇼핑몰·포인트·쪽지가 없는 설치본이 나갔다.
# 저장소의 플러그인 전부가 들어왔는지 목록을 대조한다.
PLUGINS="$(curl -s "$BASE/api/plugins")"
EXPECTED=()
for dir in "$ROOT"/plugins/*/; do
  name="$(basename "$dir")"
  [[ -f "$dir/brick.plugin.json" && -f "$dir/dist/index.js" ]] && EXPECTED+=("$name")
done
[[ ${#EXPECTED[@]} -ge 6 ]] && ok "저장소 플러그인 ${#EXPECTED[@]}개 확인" \
  || bad "저장소 플러그인이 6개 미만 (${#EXPECTED[*]})"

for p in "${EXPECTED[@]}"; do
  contains "$p 동봉" "$PLUGINS" "$p"
done
for p in "${EXPECTED[@]}"; do
  contains "$p 활성화" "$(curl -s -b "$CK" -X POST "$BASE/api/plugins/$p/activate")" '"ok":true'
done

# 관리 리소스가 뜨는 것 = 플러그인이 코어 계약대로 로드됐다는 증거
NAV="$(curl -s -b "$CK" "$BASE/api/admin/nav")"
contains "쇼핑몰 관리 리소스 등록" "$NAV" '"name":"products"'
contains "후기 관리 리소스 등록" "$NAV" '"name":"reviews"'
contains "포인트 관리 리소스 등록" "$NAV" '"name":"balances"'

echo "── 실제 기능 (drizzle sql identity 확인)"
printf '{"slug":"rel-smoke","name":"배포본 상품","price":15000,"stock":5,"status":"selling"}' > "$WORK/prod.json"
contains "상품 등록" "$(curl -s -b "$CK" -X POST "$BASE/api/plugins/brick-shop/admin/products" -H 'content-type: application/json' --data-binary "@$WORK/prod.json")" '"id"'
contains "공개 상품 목록" "$(curl -s "$BASE/api/plugins/brick-shop/products")" "배포본 상품"

echo "── 업로드 · 정적 서빙 (프록시 스트리밍)"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$WORK/t.png"
UP="$(curl -s -b "$CK" -X POST "$BASE/api/media/upload" -F "file=@$WORK/t.png")"
contains "이미지 업로드" "$UP" '"url"'
UPURL="$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['url'])")"
check "업로드 파일 서빙" "$(code "$BASE$UPURL")" "200"
check "테마 자산 서빙" "$(code "$BASE/themes/default/assets/style.css")" "200"

echo "── 공개 사이트 렌더"
contains "테마가 문서 소유" "$(curl -s "$BASE/")" "doctype html"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 로그 ──"; tail -40 "$WORK/run-2.log"; exit 1; }
