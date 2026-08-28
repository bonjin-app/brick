#!/usr/bin/env bash
#
# create-brick-plugin E2E 스모크 — "남이 만들 수 있다"를 실제로 해 본다.
#
# 템플릿을 생성하고, 모노레포 밖의 프로젝트처럼 빌드하고, ZIP 으로 묶어
# 실제 서버에 업로드 설치·활성화한 뒤, 템플릿이 쓰는 계약 전부를
# 사용자 입장에서 눌러 본다:
#
#   라우트 · 블록(escapeHtml 포함) · 관리 화면 · 마이그레이션 ·
#   개인정보 파기(실제 탈퇴로) · 비활성화
#
# 템플릿이 죽은 예제가 되는 것을 막는 수트다 — 계약이 바뀌면 여기가 먼저
# 빨간불이 들어와야 한다.
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-create-plugin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
GB="$API/api/plugins/guestbook"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  # 설치 테스트가 저장소의 plugins/ 에 전개한 플러그인을 치운다
  rm -rf "$ROOT/plugins/guestbook"
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

echo "▶ create-brick-plugin 스모크 테스트"

CREATE="node $ROOT/packages/create-brick-plugin/index.mjs"

echo "── 생성기 검증"
check "이름 없이 실행하면 거절" "$($CREATE >/dev/null 2>&1; echo $?)" "1"
check "잘못된 이름 거절 (대문자)" "$($CREATE MyPlugin --dir "$TMP" >/dev/null 2>&1; echo $?)" "1"
check "잘못된 이름 거절 (한글)" "$($CREATE 방명록 --dir "$TMP" >/dev/null 2>&1; echo $?)" "1"

# 모노레포 **밖**에서 생성한다 — 외부 개발자의 경로를 그대로 밟는다
$CREATE guestbook --display "방명록" --dir "$TMP" >/dev/null
for f in brick.plugin.json package.json tsconfig.json src/index.ts migrations/0001_init.sql README.md; do
  [[ -f "$TMP/guestbook/$f" ]] && ok "생성: $f" || bad "생성: $f 없음"
done
check "이미 있으면 거절 (덮어쓰지 않는다)" "$($CREATE guestbook --dir "$TMP" >/dev/null 2>&1; echo $?)" "1"
contains "밖에서는 자체 tsconfig (extends 없음)" "$(cat "$TMP/guestbook/tsconfig.json")" '"module": "NodeNext"'
absent  "밖에서는 workspace 프로토콜을 쓰지 않는다" "$(cat "$TMP/guestbook/package.json")" "workspace:"

echo "── 외부 프로젝트처럼 빌드 (npm 레지스트리 없이 — 로컬 의존성 링크)"
# 외부 개발자는 npm install 을 하지만, 스모크는 네트워크 없이 같은 결과를 만든다:
# Brick 이 함께 설치하는 세 의존성을 링크한다. (@brick/plugin-sdk 는 아직
# npm 에 없다 — 공개는 사용자 결정 사항. 링크는 공개 뒤의 설치와 등가다)
mkdir -p "$TMP/guestbook/node_modules/@brick"
ln -s "$ROOT/packages/plugin-sdk" "$TMP/guestbook/node_modules/@brick/plugin-sdk"
ln -s "$(python3 -c "import os;print(os.path.realpath('$ROOT/plugins/brick-memo/node_modules/drizzle-orm'))")" \
      "$TMP/guestbook/node_modules/drizzle-orm"
ln -s "$(python3 -c "import os;print(os.path.realpath('$ROOT/plugins/brick-memo/node_modules/uuidv7'))")" \
      "$TMP/guestbook/node_modules/uuidv7"

if (cd "$TMP/guestbook" && "$ROOT/node_modules/.bin/tsc" -p tsconfig.json > "$TMP/tsc.log" 2>&1); then
  ok "템플릿이 그대로 컴파일된다 (strict)"
else
  bad "컴파일 실패: $(head -5 "$TMP/tsc.log")"
fi
[[ -f "$TMP/guestbook/dist/index.js" ]] && ok "dist/index.js 생성" || bad "dist/index.js 없음"

echo "── ZIP 으로 묶기 (README 의 절차 그대로)"
(cd "$TMP/guestbook" && zip -qr "$TMP/guestbook.zip" brick.plugin.json package.json migrations dist)
[[ -s "$TMP/guestbook.zip" ]] && ok "ZIP 생성" || bad "ZIP 생성 실패"

echo "── 서버 기동"
if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi
export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-create-secret-1}"
export BRICK_CAPTCHA=off
rm -rf "$ROOT/plugins/guestbook"  # 이전 실행의 잔재가 "설치 성공"을 위조하지 않게

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
    -d '{"siteName":"템플릿","adminEmail":"admin@cbp.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@cbp.test","password":"adminpass123"}' >/dev/null
printf '{"email":"m@cbp.test","password":"password123",%s"displayName":"방문자"}' "$CONSENT" > "$TMP/reg.json"
curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json" >/dev/null
curl -s -c "$TMP/m.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"m@cbp.test","password":"password123"}' >/dev/null
M="$TMP/m.txt"

echo "── ZIP 업로드 설치 · 활성화"
UP="$(curl -s -b "$CK" -X POST "$API/api/plugins/upload" -F "file=@$TMP/guestbook.zip;type=application/zip")"
contains "업로드 설치" "$UP" '"name":"guestbook"'
contains "활성화" "$(curl -s -b "$CK" -X POST "$API/api/plugins/guestbook/activate")" '"ok":true'
contains "마이그레이션 적용 (테이블 존재)" \
  "$(curl -s "$GB/entries")" '"items":[]'
contains "데이터 파기 등록 로그" "$(grep -c 'guestbook" registers data eraser' "$TMP/api.log" || true)" "1"

echo "── 라우트 계약"
check "비로그인 쓰기 401" "$(code -X POST "$GB/entries" -H 'content-type: application/json' -d '{"message":"x"}')" "401"
check "빈 내용 400" "$(code -b "$M" -X POST "$GB/entries" -H 'content-type: application/json' -d '{"message":""}')" "400"
printf '{"message":"안녕하세요 <b>태그</b> 입니다"}' > "$TMP/msg.json"
E1="$(curl -s -b "$M" -X POST "$GB/entries" -H 'content-type: application/json' --data-binary "@$TMP/msg.json")"
E1_ID="$(echo "$E1" | jq_get "['id']")"
[[ -n "$E1_ID" ]] && ok "회원 글 작성" || bad "회원 글 작성 ($E1)"
LIST="$(curl -s "$GB/entries")"
contains "목록에 보인다" "$LIST" "안녕하세요"
contains "작성자는 표시 이름" "$LIST" "방문자"

echo "── 블록 계약 (escapeHtml 이 실제로 동작하는가)"
PAGE="$(curl -s -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' \
  -d '{"slug":"guests","title":"방명록","status":"published","blocks":[{"block":"guestbook/entries","props":{}}]}')"
contains "블록 페이지 생성" "$PAGE" '"id"'
HTML="$(curl -s "$API/api/render/page?path=guests")"
contains "블록이 렌더된다" "$HTML" "안녕하세요"
contains "사용자 입력이 이스케이프된다" "$HTML" "&lt;b&gt;태그&lt;/b&gt;"
absent  "날 태그가 그대로 나가지 않는다" "$HTML" "<b>태그</b>"

echo "── 관리 화면 계약"
check "관리 메뉴에 나타난다" "$(curl -s -b "$CK" "$API/api/admin/nav" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(any(r['name']=='entries' and r.get('plugin')=='guestbook' for r in d['resources']))" 2>/dev/null || \
  curl -s -b "$CK" "$API/api/admin/nav" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(any(r['name']=='entries' for r in d['resources']))")" "True"
contains "관리자 목록" "$(curl -s -b "$CK" "$GB/admin/entries")" "안녕하세요"
check "비관리자는 403" "$(code -b "$M" "$GB/admin/entries")" "403"
contains "관리자 삭제" "$(curl -s -b "$CK" -X DELETE "$GB/admin/entries/$E1_ID")" '"ok":true'
contains "삭제 후 빈 목록" "$(curl -s "$GB/entries")" '"items":[]'

echo "── 개인정보 파기 계약 (실제 탈퇴로)"
printf '{"message":"파기 테스트 글"}' > "$TMP/msg2.json"
curl -s -b "$M" -X POST "$GB/entries" -H 'content-type: application/json' --data-binary "@$TMP/msg2.json" >/dev/null
WD="$(curl -s -b "$M" -X POST "$API/api/me/withdraw" -H 'content-type: application/json' \
  -d '{"password":"password123"}')"
contains "탈퇴 성공" "$WD" '"ok":true'
contains "탈퇴 내역에 플러그인의 파기가 나온다" "$WD" "방명록 1건 익명화"
AFTER="$(curl -s "$GB/entries")"
contains "글은 남고 작성자는 익명" "$AFTER" "탈퇴한 회원"
absent  "표시 이름이 사라졌다" "$AFTER" "방문자"

echo "── 비활성화하면 라우트가 닫힌다"
curl -s -b "$CK" -X POST "$API/api/plugins/guestbook/deactivate" >/dev/null
NOTFOUND="$(code "$GB/entries")"
[[ "$NOTFOUND" == "404" || "$NOTFOUND" == "400" ]] && ok "비활성화 후 라우트 없음 ($NOTFOUND)" || bad "비활성화 후에도 라우트가 산다 ($NOTFOUND)"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
