#!/usr/bin/env bash
#
# 관리 리소스 왕복 E2E 스모크 — **선언한 칸이 실제로 저장되는가**.
#
# 왜 별도 수트인가: `kind: "settings"` 는 계약에 한 줄이 못박혀 있다 —
# **GET 과 PUT 의 응답 모양이 같아야 한다.** 화면이 저장 결과를 그대로 폼에
# 다시 채우기 때문이다. PUT 이 GET 에 없던 필드를 빼먹으면 그 칸은 저장하는
# 순간 빈칸이 된다(문의 분류가 실제로 그랬다). 그런데 이 계약을 지키는지
# 확인하던 것은 각 플러그인 스모크가 자기 설정의 **몇 칸만** 찔러 보는
# 방식이었다. 새 칸을 더하면 아무도 보지 않는다.
#
# 그래서 여기서는 **있는 설정 리소스 전부**를, **선언한 필드 전부**에 대해
# 기계적으로 왕복시킨다:
#   1. GET 으로 현재 값을 읽는다
#   2. 선언된 타입에 맞춰 **지금과 다른 값**을 만든다
#   3. PUT 한다
#   4. PUT 의 응답과 다시 읽은 GET 이 **같은지**, 그리고 보낸 값이
#      **그대로 또는 서버가 다듬은 값으로** 살아 있는지 본다
#
# 서버가 값을 다듬는 것(음수 배송비를 0으로, 목록 개수를 4~60으로)은 정상이다.
# 그래서 "보낸 값과 같다"가 아니라 "GET 과 PUT 이 같다 + 칸이 사라지지 않았다"를
# 못박는다. 사라짐과 갈라짐이 실제로 겪은 결함이고, 다듬기는 아니다.
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-admin-resources.sh
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
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:200})"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "▶ 관리 리소스 왕복 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-adminres-secret-val}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
  -d '{"siteName":"설정","adminEmail":"admin@settings.test","adminPassword":"adminpass123"}' >/dev/null
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@settings.test","password":"adminpass123"}' >/dev/null

echo "── 있는 플러그인을 전부 켠다 (켜지 않은 설정은 아무도 보지 않는다)"
for P in $(ls "$ROOT/plugins"); do
  curl -s -b "$CK" -X POST "$API/api/plugins/$P/activate" >/dev/null || true
done
NAV_N="$(curl -s -b "$CK" "$API/api/admin/nav" | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("resources",[])))')"
[[ "${NAV_N:-0}" -ge 20 ]] && ok "관리 리소스가 실제로 올라왔다 (${NAV_N}개)" || bad "리소스가 너무 적다 — 활성화가 실패했다 (${NAV_N:-0}개)"

echo "── 설정 리소스 전수 왕복"
/usr/bin/python3 - "$API" "$CK" <<'PYEOF' > "$TMP/roundtrip.txt"
import json, re, subprocess, sys
api, ck = sys.argv[1], sys.argv[2]

def curl(args):
    return subprocess.run(["curl", "-s", "-b", ck, *args], capture_output=True, text=True).stdout

def get(path):
    try: return json.loads(curl([api + path]))
    except Exception: return None

def put(path, payload):
    out = curl(["-X", "PUT", api + path, "-H", "content-type: application/json", "-d", json.dumps(payload)])
    try: return json.loads(out)
    except Exception: return None

def mutate(field, cur):
    """선언 타입에 맞는 '지금과 다른 값'. 만들 수 없으면 None(그 칸은 건너뛴다)."""
    ty = field.get("type") or "text"
    if ty in ("boolean", "checkbox"):
        return not bool(cur)
    if ty in ("number", "money", "int"):
        try: n = int(float(cur or 0))
        except Exception: n = 0
        return n + 7
    if ty == "select":
        opts = [o.get("value") for o in (field.get("options") or [])]
        for o in opts:
            if str(o) != str(cur): return o
        return None
    if ty in ("text", "textarea", "html", "url", "email"):
        base = "" if cur is None else str(cur)
        return (base + "-왕복")[:200]
    return None

results = []
rejected = []
resources = get("/api/admin/nav") or {}
settings = []
for r in resources.get("resources", []):
    full = get(f"/api/admin/resources/{r['plugin']}/{r['name']}")
    if full and full.get("kind") == "settings":
        settings.append((r["plugin"], r["name"], full))

print(f"COUNT={len(settings)}")
for plugin, name, decl in settings:
    base = decl.get("basePath") or ""
    path = f"/api/plugins/{plugin}{base}"
    tag = f"{plugin}/{name}"
    before = get(path)
    if not isinstance(before, dict):
        results.append(f"{tag}: GET 이 객체를 주지 않는다 ({str(before)[:60]})")
        continue

    fields = [f for f in decl.get("fields", []) if f.get("name")]
    # 비밀 필드(secret: true)는 왕복시키지 않는다 — 서버가 GET 에서 값을 돌려주지
    # 않는 것이 **옳은** 동작이기 때문이다. 대신 그 약속을 여기서 뒤집어 못박는다:
    # 값이 돌아오면 그 GET 자체가 유출 경로다.
    secretish = {f["name"] for f in fields if f.get("secret")}
    for n in sorted(secretish):
        if before.get(n) not in (None, "", False):
            results.append(f"{tag}: 비밀 필드 {n} 의 값이 GET 으로 돌아온다 (유출 경로다)")

    payload = dict(before)
    changed = {}
    for f in fields:
        n = f["name"]
        if n in secretish or f.get("readOnly"): continue
        v = mutate(f, before.get(n))
        if v is None: continue
        payload[n] = v
        changed[n] = v
    if not changed:
        results.append(f"{tag}: 바꿀 수 있는 칸이 하나도 없다 (선언 {len(fields)}칸)")
        continue

    after_put = put(path, payload)
    if not isinstance(after_put, dict):
        results.append(f"{tag}: PUT 이 객체를 주지 않는다 ({str(after_put)[:60]})")
        continue

    # 서버가 거부하는 것은 정상이다 — 설정끼리 얽힌 규칙이 있다(시크릿 키 없이
    # 결제를 켤 수는 없다). 기계적으로 만든 값이 그런 규칙에 걸리는 것은 이 검사가
    # 각 플러그인의 뜻을 모르기 때문이지 결함이 아니다.
    #
    # 대신 거부에는 거부대로 못박을 성질이 있다: **거부했으면 아무것도 바뀌지
    # 않아야 한다.** 칸 절반만 저장되고 나머지가 튕기면 운영자는 자기 설정이
    # 어떤 상태인지 알 수 없게 된다.
    if int(after_put.get("statusCode") or 0) >= 400:
        again = get(path)
        if again != before:
            diff = [k for k in set(list(again or {}) + list(before)) if (again or {}).get(k) != before.get(k)]
            results.append(f"{tag}: PUT 을 거부했는데 값이 바뀌었다 {diff[:6]}")
        if not str(after_put.get("message") or "").strip():
            results.append(f"{tag}: PUT 을 거부하면서 이유를 말하지 않는다")
        rejected.append(tag)
        continue

    after_get = get(path)
    if not isinstance(after_get, dict):
        results.append(f"{tag}: 저장 뒤 GET 이 객체를 주지 않는다")
        continue

    # (1) 모양이 같은가 — 화면은 PUT 응답을 그대로 폼에 채운다
    only_put = sorted(set(after_put) - set(after_get))
    only_get = sorted(set(after_get) - set(after_put))
    if only_put or only_get:
        results.append(f"{tag}: GET/PUT 모양이 다르다 (PUT에만 {only_put[:5]} · GET에만 {only_get[:5]})")

    # (2) 선언한 칸이 응답에 있는가 — 없으면 화면의 그 칸은 저장 즉시 빈다
    missing = [f["name"] for f in fields if f["name"] not in secretish and f["name"] not in after_get]
    if missing:
        results.append(f"{tag}: 선언했는데 응답에 없는 칸 {missing[:6]}")

    # (3) 보낸 값이 살아 있는가 — 서버가 다듬는 것은 정상이므로 '원래 값 그대로면 실패'로 본다
    ignored = []
    for n, v in changed.items():
        got = after_get.get(n)
        if n in missing: continue
        if got == before.get(n) and got != v:
            ignored.append(f"{n}(보냄 {v!r} · 남은 값 {got!r})")
    if ignored:
        results.append(f"{tag}: 저장이 무시된 칸 {ignored[:6]}")

    for n in sorted(secretish):
        if after_put.get(n) not in (None, "", False) or after_get.get(n) not in (None, "", False):
            results.append(f"{tag}: 저장 뒤 비밀 필드 {n} 의 값이 응답에 담긴다")

    # (4) PUT 응답과 다시 읽은 값이 같은가 — 다르면 화면이 거짓을 보여준다
    diff = [k for k in after_get if k in after_put and after_put[k] != after_get[k]]
    if diff:
        results.append(f"{tag}: PUT 응답과 저장된 값이 다르다 {diff[:6]}")

print(f"REJECTED={len(rejected)}")
for line in results:
    print("BAD=" + line)
PYEOF

SET_N="$(sed -n 's/^COUNT=//p' "$TMP/roundtrip.txt")"
[[ "${SET_N:-0}" -ge 5 ]] && ok "설정 리소스를 전수로 찾았다 (${SET_N}개)" || bad "설정 리소스가 너무 적다 (${SET_N:-0}개)"

REJ="$(sed -n 's/^REJECTED=//p' "$TMP/roundtrip.txt")"
[[ "${REJ:-0}" -le 2 ]] && ok "대부분의 설정이 실제로 왕복한다 (얽힌 규칙으로 거부된 것 ${REJ:-0}개)" \
  || bad "거부가 너무 많다 (${REJ}개) — 왕복을 실제로 시험하지 못하고 있다"
BADS="$(grep -c '^BAD=' "$TMP/roundtrip.txt" || true)"
if [[ "${BADS:-0}" -eq 0 ]]; then
  ok "모든 설정 리소스가 선언한 칸을 그대로 왕복시킨다"
else
  while IFS= read -r line; do bad "${line#BAD=}"; done < <(grep '^BAD=' "$TMP/roundtrip.txt")
fi

echo "── 목록 리소스: 폼이 선언한 칸을 불러올 수 있는가"
# 왜 이것을 보는가. 수정 폼은 `GET <basePath>/:id` 로 한 건을 받아 채우고, 그 라우트가
# 없으면 **목록 행으로** 채운다(실제로 리소스 스물넷 중 스물둘에 :id 가 없다). 그래서
# 선언한 칸이 둘 중 어디에도 **선언한 이름 그대로** 없으면 그 칸은 빈칸으로 열린다.
# 빈칸인 채로 저장하면 PUT 이 그것을 "비우라"로 읽는다 — 이름만 고쳤는데 값이 사라진다.
#
# 실제로 이렇게 사라졌다:
#   - 회원 등급: 목록이 minAmount/discountRate(카멜)로 주는데 선언은 min_amount/
#     discount_rate 였다. 등급 이름만 고치면 기준 금액과 할인율이 0이 됐다 —
#     기준 0원은 **전 회원이 최고 등급**이라는 뜻이다.
#   - 상품 분류: parent_id 가 목록에 없어서, 이름만 고치면 계층이 끊어졌다.
# 그리고 만들 때도 같은 일이 난다:
#   - 개인결제 청구: 선언은 customer_name 인데 핸들러는 customerName 만 읽었다.
#     전화 주문을 받아 적은 받는 분·연락처·이메일이 저장되지 않았다.
/usr/bin/python3 - "$API" "$CK" <<'PYEOF' > "$TMP/list.txt"
import json, re, subprocess, sys
api, ck = sys.argv[1], sys.argv[2]
def curl(a): return subprocess.run(["curl","-s","-b",ck,*a],capture_output=True,text=True).stdout
def get(p):
    try: return json.loads(curl([api+p]))
    except Exception: return None
def post(p, payload):
    out = curl(["-X","POST",api+p,"-H","content-type: application/json","-d",json.dumps(payload)])
    try: return json.loads(out)
    except Exception: return None

def sample(f, i):
    ty = f.get("type") or "text"
    if ty == "boolean": return True
    if ty in ("number","money"): return 3
    if ty == "select":
        opts = [o.get("value") for o in (f.get("options") or []) if o.get("value")]
        return opts[0] if opts else None
    if ty == "date": return "2026-01-02"
    if ty in ("image","images"): return "/uploads/probe.png"
    if f["name"] == "slug": return f"probe-{i}"
    return f"probe{i}"

bad = []
checked = 0
for idx, r in enumerate(get("/api/admin/nav").get("resources", [])):
    d = get(f"/api/admin/resources/{r['plugin']}/{r['name']}")
    if not isinstance(d, dict) or d.get("kind") == "settings": continue
    can = d.get("can") or {}
    # 수정할 수 없는 리소스는 폼이 열리지 않는다 — 이 검사의 대상이 아니다
    if can.get("update") is False or can.get("create") is False: continue
    base = f"/api/plugins/{r['plugin']}{d.get('basePath','')}"
    tag = f"{r['plugin']}/{r['name']}"
    editable = [f for f in d.get("fields", []) if f.get("name") and not f.get("readOnly")]
    payload = {}
    for f in editable:
        v = sample(f, idx)
        if v is not None: payload[f["name"]] = v
    if not payload: continue
    made = post(base, payload)
    # 만들 수 없는 리소스(외래키·업무 규칙)는 여기서 판단하지 않는다
    if not isinstance(made, dict) or made.get("statusCode", 200) >= 400: continue
    checked += 1
    idf = d.get("idField") or "id"
    rid = made.get(idf)
    one = get(f"{base}/{rid}") if rid is not None else None
    src = one if isinstance(one, dict) and one.get(idf) is not None else None
    where = "GET /:id"
    if src is None:
        lst = get(base)
        items = (lst or {}).get("items") if isinstance(lst, dict) else None
        src = next((x for x in (items or []) if str(x.get(idf)) == str(rid)), None)
        where = "목록 행"
    if src is None:
        bad.append(f"{tag}: 만든 건을 다시 읽을 수 없다")
        continue
    missing = [f["name"] for f in editable if f["name"] not in src]
    if missing:
        bad.append(f"{tag}: 폼이 채울 수 없는 칸 {missing[:6]} ({where} 에 없다)")
    # 보낸 값이 실제로 남았는가 — 핸들러가 다른 이름을 읽으면 조용히 사라진다
    lost = [n for n, v in payload.items()
            if n in src and src[n] in (None, "") and v not in (None, "", False)]
    if lost:
        bad.append(f"{tag}: 보낸 값이 저장되지 않은 칸 {lost[:6]}")
print(f"CHECKED={checked}")
for b in bad: print("BAD=" + b)
PYEOF
LIST_N="$(sed -n 's/^CHECKED=//p' "$TMP/list.txt")"
[[ "${LIST_N:-0}" -ge 5 ]] && ok "목록 리소스를 실제로 여럿 만들어 봤다 (${LIST_N}개)" \
  || bad "만들어 본 리소스가 너무 적다 (${LIST_N:-0}개) — 검사가 헛돌고 있다"
LBAD="$(grep -c '^BAD=' "$TMP/list.txt" || true)"
if [[ "${LBAD:-0}" -eq 0 ]]; then
  ok "모든 목록 리소스에서 폼이 선언한 칸을 불러오고, 보낸 값이 남는다"
else
  while IFS= read -r line; do bad "${line#BAD=}"; done < <(grep '^BAD=' "$TMP/list.txt")
fi

echo "── 설정은 관리자만 바꾼다"
# 403 이 맞다. 플러그인 관리 경로는 **비로그인에도 403** 을 준다 — 401 은 "그 경로는
# 있는데 당신이 누군지 모르겠다"는 뜻이라 경로의 존재를 알려준다(plugins.controller.ts).
# 코어의 /api/settings 는 401 이므로 이 둘은 다르다. 다르다는 사실 자체를 못박는다 —
# 어느 한쪽이 조용히 바뀌면 관리 화면의 세션 만료 처리가 갈라진다.
FIRST="$(/usr/bin/python3 - "$API" "$CK" <<'PYEOF'
import json, subprocess, sys
api, ck = sys.argv[1], sys.argv[2]
def get(p):
    try: return json.loads(subprocess.run(["curl","-s","-b",ck,api+p],capture_output=True,text=True).stdout)
    except Exception: return {}
for r in get("/api/admin/nav").get("resources", []):
    full = get(f"/api/admin/resources/{r['plugin']}/{r['name']}")
    if full.get("kind") == "settings":
        print(f"/api/plugins/{r['plugin']}{full.get('basePath','')}"); break
PYEOF
)"
if [[ -n "$FIRST" ]]; then
  check "비로그인 GET 거부 (경로 존재를 알리지 않는 403)" "$(code "$API$FIRST")" "403"
  check "비로그인 PUT 거부 (403)" "$(code -X PUT "$API$FIRST" -H 'content-type: application/json' -d '{}')" "403"
  check "코어 설정은 401 (여기선 경로를 숨길 이유가 없다)" \
    "$(code -X PUT "$API/api/settings" -H 'content-type: application/json' -d '{}')" "401"
else
  bad "설정 경로를 찾지 못했다"
fi

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ "$FAIL" -eq 0 ]]
