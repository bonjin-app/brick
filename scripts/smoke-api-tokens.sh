#!/usr/bin/env bash
#
# 읽기 전용 API 토큰 · MCP 서버 E2E 스모크 — **도구에게 주는 열쇠가 좁고, 새도 안전한가.**
#
# 도구(MCP 서버·모니터링·에이전트)에 로그인 세션을 주면 그 세션은 쓰기까지 되는 전체 관리자 권한이다.
# 이 토큰은 읽기(GET) 전용이고, 진단용으로 허용한 경로만 열리고, 언제든 폐기되고, 만료가 있다.
#
# 못박는 것:
#   - 만들 때 비밀번호를 다시 묻는가 · 원문은 한 번만 보이고 DB 에는 해시뿐인가
#   - 허용한 읽기 경로는 열리고, **그 밖의 모든 것은 닫혀 있는가**(쓰기 메서드 · 개인정보가 있는 경로 · 토큰 관리 자체)
#   - 쿼리 문자열·끝 슬래시·경로 속임수로 허용목록을 넘지 못하는가
#   - 폐기 · 만료 · 만든 사람의 강등이 곧바로 토큰을 죽이는가
#   - 대시보드 응답에 회원 이메일이 섞여 있지 않은가 (토큰이 새도 개인정보는 새지 않는다)
#   - 감사 로그에 만들기·폐기가 남는가
#   - MCP 서버가 실제로 프로토콜을 말하고, 폐기된 토큰의 거절을 에이전트가 읽을 수 있는 글로 돌려주는가
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-api-tokens.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib-smoke.sh
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
MEMBER="$TMP/member.txt"
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
# CI(GitHub Actions)에서는 실패한 단언을 주석(::error::)으로도 남긴다 — 로그를 못 보는 계정도 어느 단언이 깨졌는지 볼 수 있다
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; [[ -z "${GITHUB_ACTIONS:-}" ]] || { local m="${1//$'\n'/ }"; echo "::error title=${0##*/}::${m:0:400}"; }; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jpost()    { curl -s -X POST "$1" -H 'content-type: application/json' --data-binary "@$2"; }
jget()     { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

echo "▶ 읽기 전용 API 토큰 · MCP 스모크 테스트"

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_CAPTCHA=off

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

printf '{"siteName":"토큰시험","adminEmail":"admin@tk.test","adminPassword":"tkpass1234","starter":"community"}' > "$TMP/i.json"
jpost "$API/api/install" "$TMP/i.json" >/dev/null
printf '{"email":"admin@tk.test","password":"tkpass1234"}' > "$TMP/la.json"
curl -s -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/la.json" >/dev/null
printf '{"email":"member@tk.test","password":"memberpass1","agreements":{"terms":true,"privacy":true,"third_party":true},"displayName":"회원"}' > "$TMP/reg.json"
jpost "$API/api/register" "$TMP/reg.json" >/dev/null
printf '{"email":"member@tk.test","password":"memberpass1"}' > "$TMP/lm.json"
curl -s -c "$MEMBER" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/lm.json" >/dev/null

TK="$API/api/admin/api-tokens"
mk() {  # mk <본문> → 응답 (관리자 세션으로)
  printf '%s' "$1" > "$TMP/mk.json"
  curl -s -b "$ADMIN" -X POST "$TK" -H 'content-type: application/json' --data-binary "@$TMP/mk.json"
}
mkcode() { printf '%s' "$1" > "$TMP/mk.json"; curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN" -X POST "$TK" -H 'content-type: application/json' --data-binary "@$TMP/mk.json"; }
bearer() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $1" "${@:2}"; }

echo "── 만들기: 비밀번호를 다시 묻고 입력을 검사한다"
check "비밀번호 없이는 만들 수 없다" "$(mkcode '{"name":"mcp"}')" "400"
check "틀린 비밀번호는 거절" "$(mkcode '{"name":"mcp","password":"wrong-pass"}')" "400"
check "이름이 없으면 거절" "$(mkcode '{"name":"  ","password":"tkpass1234"}')" "400"
check "유효 기간 0일은 거절" "$(mkcode '{"name":"mcp","expiresInDays":0,"password":"tkpass1234"}')" "400"
check "유효 기간 366일은 거절" "$(mkcode '{"name":"mcp","expiresInDays":366,"password":"tkpass1234"}')" "400"
check "소수 일수는 거절" "$(mkcode '{"name":"mcp","expiresInDays":1.5,"password":"tkpass1234"}')" "400"
check "회원은 토큰을 만들 수 없다" "$(printf '{"name":"x","password":"memberpass1"}' > "$TMP/m.json"; code -b "$MEMBER" -X POST "$TK" -H 'content-type: application/json' --data-binary "@$TMP/m.json")" "403"
check "비로그인은 만들 수 없다" "$(code -X POST "$TK" -H 'content-type: application/json' --data-binary "@$TMP/m.json")" "401"
check "만들어진 것이 없다" "$(psql_q "SELECT count(*) FROM api_tokens")" "0"

R="$(mk '{"name":"MCP 서버","expiresInDays":30,"password":"tkpass1234"}')"
TOKEN="$(echo "$R" | jget "['token']")"
TID="$(echo "$R" | jget "['id']")"
[[ "$TOKEN" == brk_* ]] && ok "brk_ 로 시작하는 토큰이 나온다" || bad "토큰 형식 (${TOKEN:0:12})"
[[ ${#TOKEN} -ge 36 ]] && ok "추측할 수 없는 길이 (${#TOKEN}자)" || bad "토큰이 짧다 (${#TOKEN}자)"
contains "열어 주는 경로 목록도 함께 준다" "$R" '"/api/admin/dashboard"'

echo "── DB 에는 해시만 있다"
check "원문이 어느 열에도 없다" "$(psql_q "SELECT count(*) FROM api_tokens WHERE token_hash = '$TOKEN' OR name = '$TOKEN' OR hint = '$TOKEN'")" "0"
check "저장된 것은 sha256(64자 16진수)" "$(psql_q "SELECT length(token_hash) || ':' || (token_hash ~ '^[0-9a-f]{64}$')::text FROM api_tokens")" "64:true"
check "목록용 끝 네 글자만 남는다" "$(psql_q "SELECT hint FROM api_tokens")" "${TOKEN: -4}"
LIST="$(curl -s -b "$ADMIN" "$TK")"
absent "목록 응답에 원문이 없다" "$LIST" "$TOKEN"
contains "목록에 이름과 만든 사람이 있다" "$LIST" '"createdByEmail":"admin@tk.test"'

echo "── 허용한 읽기 경로는 열린다"
for path in /api/admin/version /api/admin/dashboard /api/admin/areas /api/plugins /api/themes /api/openapi.json "/api/render/page?path="; do
  check "GET $path" "$(bearer "$TOKEN" "$API$path")" "200"
done

echo "── 그 밖의 모든 것은 닫혀 있다"
check "토큰으로 토큰 목록을 볼 수 없다" "$(bearer "$TOKEN" "$TK")" "401"
check "토큰으로 새 토큰을 만들 수 없다 (자기 복제 차단)" "$(bearer "$TOKEN" -X POST "$TK" -H 'content-type: application/json' --data-binary "@$TMP/mk.json")" "401"
check "토큰으로 토큰을 폐기할 수 없다" "$(bearer "$TOKEN" -X DELETE "$TK/$TID")" "401"
check "쓰기 메서드는 허용 경로에서도 거절 (POST)" "$(bearer "$TOKEN" -X POST "$API/api/admin/version/recheck")" "401"
check "프로필 수정(PUT)도 거절" "$(bearer "$TOKEN" -X PUT "$API/api/me" -H 'content-type: application/json' -d '{"displayName":"해킹"}')" "401"
check "감사 로그는 열리지 않는다 (행위자 이메일·IP 가 있다)" "$(bearer "$TOKEN" "$API/api/audit")" "401"
absent "내 정보를 물어도 사람으로 인식되지 않는다" "$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/auth/me")" "admin@tk.test"
check "알림함도 마찬가지" "$(bearer "$TOKEN" "$API/api/notifications")" "401"
check "관리자 전용 쓰기 경로 (플러그인 끄기)" "$(bearer "$TOKEN" -X POST "$API/api/plugins/brick-board/deactivate")" "401"
echo "── 허용목록을 속임수로 넘지 못한다"
check "쿼리에 허용 경로를 적어도 소용없다" "$(bearer "$TOKEN" "$API/api/audit?x=/api/plugins")" "401"
DOTS="$(bearer "$TOKEN" --path-as-is "$API/api/plugins/../audit")"
[[ "$DOTS" == "401" || "$DOTS" == "404" ]] && ok "점(..) 경로로 돌아가도 감사 로그는 열리지 않는다 ($DOTS)" || bad "점 경로 ($DOTS)"
check "허용 경로의 하위 경로는 열지 않는다" "$(bearer "$TOKEN" "$API/api/admin/dashboard/extra")" "404"
check "접두사가 같은 다른 경로" "$(bearer "$TOKEN" "$API/api/pluginsx")" "404"

echo "── 잘못된 열쇠"
check "지어낸 brk_ 토큰" "$(bearer "brk_$(printf 'a%.0s' $(seq 1 32))" "$API/api/admin/version")" "401"
check "접두사만" "$(bearer "brk_" "$API/api/admin/version")" "401"
check "토큰을 쿠키로 보내도 통하지 않는다" "$(code -H "Cookie: brick_session=$TOKEN" "$API/api/admin/version")" "401"
check "관리자 세션은 그대로 쓸 수 있다" "$(code -b "$ADMIN" "$API/api/admin/version")" "200"

echo "── 토큰이 새도 개인정보는 새지 않는다"
DASH="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/admin/dashboard")"
absent "대시보드에 회원 이메일이 없다" "$DASH" "member@tk.test"
absent "관리자 이메일도 없다" "$DASH" "admin@tk.test"
check "사용한 시각이 기록된다" "$(psql_q "SELECT (last_used_at IS NOT NULL)::text FROM api_tokens")" "true"

echo "── 만든 사람이 관리자가 아니게 되면 토큰도 죽는다"
psql_q "UPDATE users SET role='member' WHERE email='admin@tk.test'" >/dev/null
check "강등된 뒤에는 거절" "$(bearer "$TOKEN" "$API/api/admin/version")" "401"
psql_q "UPDATE users SET role='admin' WHERE email='admin@tk.test'" >/dev/null
check "복구하면 다시 열린다" "$(bearer "$TOKEN" "$API/api/admin/version")" "200"
psql_q "UPDATE users SET is_active=false WHERE email='admin@tk.test'" >/dev/null
check "비활성화된 사람의 토큰도 거절" "$(bearer "$TOKEN" "$API/api/admin/version")" "401"
psql_q "UPDATE users SET is_active=true WHERE email='admin@tk.test'" >/dev/null

echo "── 만료"
R2="$(mk '{"name":"곧 만료","expiresInDays":1,"password":"tkpass1234"}')"
T2="$(echo "$R2" | jget "['token']")"
check "만든 직후에는 열린다" "$(bearer "$T2" "$API/api/admin/version")" "200"
psql_q "UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE hint = '${T2: -4}'" >/dev/null
check "만료 시각이 지나면 거절" "$(bearer "$T2" "$API/api/admin/version")" "401"
contains "목록은 만료된 것을 사용 중으로 보이지 않는다" "$(curl -s -b "$ADMIN" "$TK")" '"active":false'

echo "── 폐기"
check "폐기 전에는 열린다" "$(bearer "$TOKEN" "$API/api/admin/version")" "200"
check "관리자가 폐기한다" "$(code -b "$ADMIN" -X DELETE "$TK/$TID")" "200"
check "폐기하면 곧바로 거절" "$(bearer "$TOKEN" "$API/api/admin/version")" "401"
check "이미 폐기한 것을 다시 폐기하면 404" "$(code -b "$ADMIN" -X DELETE "$TK/$TID")" "404"
check "형식이 아닌 id 는 404" "$(code -b "$ADMIN" -X DELETE "$TK/not-a-uuid")" "404"
check "회원은 폐기할 수 없다" "$(code -b "$MEMBER" -X DELETE "$TK/$TID")" "403"

echo "── 감사 로그"
AUD="$(curl -s -b "$ADMIN" "$API/api/audit?action=apitoken.create")"
contains "만들기가 남는다" "$AUD" "apitoken.create"
contains "폐기가 남는다" "$(curl -s -b "$ADMIN" "$API/api/audit?action=apitoken.revoke")" "apitoken.revoke"
absent "감사 로그에 토큰 원문이 없다" "$(curl -s -b "$ADMIN" "$API/api/audit")" "$TOKEN"

echo "── 개수 상한"
for i in $(seq 1 20); do mk "{\"name\":\"t$i\",\"password\":\"tkpass1234\"}" >/dev/null; done
ACTIVE="$(curl -s -b "$ADMIN" "$TK" | python3 -c "import sys,json;print(sum(1 for t in json.load(sys.stdin)['items'] if t['active']))")"
check "사용 중인 토큰이 20개가 될 때까지 만들 수 있다" "$ACTIVE" "20"
check "21번째는 거절 (쓰지 않는 것을 먼저 폐기하게)" "$(mkcode '{"name":"넘침","password":"tkpass1234"}')" "400"

echo "── MCP 서버"
# 상한에 걸려 있으니 시험용으로 채운 것을 정리하고 만든다
psql_q "UPDATE api_tokens SET revoked_at = now() WHERE name ~ '^t[0-9]+$'" >/dev/null
R3="$(mk '{"name":"MCP 시험","password":"tkpass1234"}')"
MT="$(echo "$R3" | jget "['token']")"
MT_ID="$(echo "$R3" | jget "['id']")"
cat > "$TMP/mcp-drive.mjs" <<'EOF'
// MCP 서버를 자식 프로세스로 띄워 JSON-RPC 를 주고받는다. 결과를 한 줄씩 JSON 으로 찍는다.
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [process.argv[2]], { env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
  }
});
let n = 0;
const rpc = (method, params) => new Promise((resolve) => {
  const id = ++n;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const out = {};
out.init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
out.list = await rpc("tools/list", {});
out.status = await rpc("tools/call", { name: "site_status", arguments: {} });
out.render = await rpc("tools/call", { name: "render_page", arguments: { path: "" } });
out.plugins = await rpc("tools/call", { name: "list_plugins", arguments: {} });
out.dashboard = await rpc("tools/call", { name: "dashboard", arguments: {} });
out.unknown = await rpc("tools/call", { name: "delete_everything", arguments: {} });
out.badMethod = await rpc("resources/read", {});
out.ping = await rpc("ping", {});
child.stdin.end();
console.log(JSON.stringify(out));
EOF
BRICK_URL="$API" BRICK_TOKEN="$MT" node "$TMP/mcp-drive.mjs" "$ROOT/scripts/brick-mcp.mjs" > "$TMP/mcp.json" 2>"$TMP/mcp.err" || true
MX() { python3 -c "import json;d=json.load(open('$TMP/mcp.json'));print($1)" 2>/dev/null || echo ""; }
M() { python3 -c "import sys,json;d=json.load(open('$TMP/mcp.json'));print(d$1)" 2>/dev/null || echo ""; }
check "initialize 에 서버 이름으로 답한다" "$(M "['init']['result']['serverInfo']['name']")" "brick"
check "클라이언트가 말한 프로토콜 버전을 따른다" "$(M "['init']['result']['protocolVersion']")" "2025-03-26"
check "도구를 광고한다" "$(M "['list']['result']['tools'].__len__() >= 7")" "True"
check "도구마다 입력 스키마가 있다" "$(MX "all('inputSchema' in t for t in d['list']['result']['tools'])")" "True"
check "쓰기 도구는 하나도 없다" "$(MX "any(w in t['name'].split('_') for t in d['list']['result']['tools'] for w in ('delete','create','update','write','set','post','install','activate','remove','revoke'))")" "False"
contains "site_status 가 서버 상태를 돌려준다" "$(M "['status']['result']['content'][0]['text']")" '"ready"'
contains "render_page 가 홈을 그린 결과를 준다" "$(M "['render']['result']['content'][0]['text']")" '"status": 200'
contains "list_plugins 가 게시판을 보여 준다" "$(M "['plugins']['result']['content'][0]['text']")" "brick-board"
check "없는 도구는 프로토콜 오류" "$(M "['unknown']['error']['code']")" "-32602"
check "모르는 메서드는 -32601" "$(M "['badMethod']['error']['code']")" "-32601"
check "ping 에 답한다" "$(M "['ping']['result']")" "{}"

curl -s -o /dev/null -b "$ADMIN" -X DELETE "$TK/$MT_ID"
BRICK_URL="$API" BRICK_TOKEN="$MT" node "$TMP/mcp-drive.mjs" "$ROOT/scripts/brick-mcp.mjs" > "$TMP/mcp.json" 2>"$TMP/mcp.err" || true
check "오류는 프로토콜 오류가 아니라 결과로 돌아온다 (에이전트가 읽고 고칠 수 있게)" "$(MX "'error' in d['dashboard']")" "False"
check "폐기된 토큰으로 인증이 필요한 도구를 부르면 오류 결과" "$(M "['dashboard']['result']['isError']")" "True"
contains "에이전트가 읽고 고칠 수 있는 이유를 말한다" "$(M "['dashboard']['result']['content'][0]['text']")" "폐기·만료"
absent "그 글에 토큰 원문이 없다" "$(cat "$TMP/mcp.json")" "$MT"
BRICK_URL="$API" BRICK_TOKEN="" node "$TMP/mcp-drive.mjs" "$ROOT/scripts/brick-mcp.mjs" > "$TMP/mcp.json" 2>"$TMP/mcp.err" || true
contains "토큰을 주지 않으면 시작하며 이유를 알린다" "$(cat "$TMP/mcp.err")" "BRICK_TOKEN"
check "그래도 프로토콜은 말한다 (도구 목록)" "$(M "['list']['result']['tools'].__len__() >= 7")" "True"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ "$FAIL" -eq 0 ]]
