#!/usr/bin/env bash
#
# 페이지 배치 편집기 — 저장하지 않은 초안을 실제 테마로 미리 보고, 블록을 트리로 배치한다.
#
#   - 초안 미리보기: 운영자가 맡긴 초안을 실제 테마로 그리고, 블록마다 트리 위치를 단다
#     (미리보기에서 누른 블록을 편집기가 고른다). 빈 컨테이너·모르는 블록도 눌러서 고를 수 있게 보인다
#   - 초안은 맡긴 운영자의 것이다 — 다른 운영자·회원·손님은 보지 못하고, 공개 화면에도 나가지 않는다
#   - 미리보기는 사이트와 같은 보안 정책(CSP)으로 뜨고, 캐시·검색엔진에 남지 않는다
#   - 공개 렌더에는 위치 표시도 편집기 스크립트도 없다
#   - 모양이 틀린 블록 트리는 저장하지 않는다(편집기가 트리를 따라가다 깨지지 않게)
#   - 트리 연산(옮기기·안으로 넣기·밖으로 빼기·복제)을 편집기와 같은 코드로 시험한다
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-layout-editor.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib-smoke.sh"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
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
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:220})"; }
absent()   { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 가 있음)"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq_get()   { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo ""; }

echo "▶ 페이지 배치 편집기 스모크 테스트"

echo "── 트리 연산 (편집기와 같은 코드)"
TREE_OUT="$(node --input-type=module -e '
  const T = await import(process.argv[1]);
  const P = (b, kids) => (kids ? { block: b, props: {}, children: kids } : { block: b, props: {} });
  const names = (tree) => JSON.stringify(tree, (k, v) => (k === "props" ? undefined : v))
    .replace(/"block":/g, "").replace(/"children":/g, "");
  const out = [];
  const base = () => [P("a/h"), P("core/columns", [P("a/l"), P("a/r")]), P("a/p"), P("core/columns", [])];
  const accepts = (b) => b === "core/columns";
  // 1. 같은 목록 아래쪽으로 — 옮기기 전 목록 기준 자리
  let r = T.moveNode(base(), [0], [], 3);
  out.push("down:" + names(r.tree) + "@" + T.pathKey(r.path));
  // 2. 다단 안으로 — 뒤쪽 형제 안으로 옮기면 그 자리가 한 칸 당겨진다
  r = T.moveNode(base(), [0], [3], 0);
  out.push("into-later:" + names(r.tree) + "@" + T.pathKey(r.path));
  // 3. 자기 안으로는 못 옮긴다
  out.push("self:" + String(T.moveNode(base(), [1], [1], 0)) + "," + String(T.moveNode(base(), [1], [1, 0], 0)));
  // 4. 밖으로 빼기 — 부모 바로 뒤
  r = T.outdent(base(), [1, 1]);
  out.push("outdent:" + names(r.tree) + "@" + T.pathKey(r.path));
  // 5. 위 다단 안으로 넣기(키보드 길) — 컨테이너가 아니면 null
  r = T.indentIntoPrevious(base(), [2], accepts);
  out.push("indent:" + names(r.tree) + "@" + T.pathKey(r.path) + "," + String(T.indentIntoPrevious(base(), [1], accepts)));
  // 6. 형제 사이 이동 · 끝에서는 null
  r = T.moveSibling(base(), [1, 0], 1);
  out.push("sibling:" + names(r.tree) + "@" + T.pathKey(r.path) + "," + String(T.moveSibling(base(), [3], 1)));
  // 7. 복제는 깊은 복사 — 복제본의 속성·안쪽 블록을 **그 자리에서** 고쳐도 원본이 바뀌지 않는다
  //    (속성 폼이 넘겨받은 객체를 고치는 확장이 생겨도 두 블록이 한 몸이 되지 않게)
  r = T.duplicateAt(base(), [1]);
  const copy = T.getNode(r.tree, [2]);
  copy.children[0].props.text = "x"; copy.children.push(P("a/extra"));
  out.push("dup:" + T.pathKey(r.path) + "," + JSON.stringify(T.getNode(r.tree, [1, 0]).props) + "," + T.getNode(r.tree, [1]).children.length + "," + JSON.stringify(copy.children[0].props));
  // 8. 원본을 바꾸지 않는다(되돌리기가 옛 트리를 들고 있다)
  const orig = base(); const snap = JSON.stringify(orig);
  T.moveNode(orig, [0], [1], 1); T.removeAt(orig, [1, 0]); T.insertAt(orig, [3], 0, P("a/z")); T.updateAt(orig, [2], () => P("a/q"));
  out.push("pure:" + (JSON.stringify(orig) === snap));
  // 9. 개요 줄 · 경로 읽기
  out.push("flat:" + T.flatten(base()).map((x) => x.depth + ":" + x.node.block).join(","));
  out.push("parse:" + JSON.stringify([T.parsePath("1.0.2"), T.parsePath("1..2"), T.parsePath("x"), T.parsePath("")]));
  // 10. 제자리 이동은 원래 트리를 그대로 돌려준다(되돌리기 기록이 헛돌지 않게)
  const same = base(); r = T.moveNode(same, [2], [], 3);
  out.push("noop:" + (r.tree === same) + "@" + T.pathKey(r.path));
  // 11. 미리보기에서 고친 글자 — 스키마의 글자 속성만 받는다
  const schemas = { "a/h": { text: { type: "string" }, level: { type: "number" } }, "a/l": { text: { type: "string" } } };
  const schemaOf = (b) => schemas[b];
  const t0 = base();
  r = T.applyTextEdit(t0, "1.0", "text", "고친 글자", schemaOf);
  out.push("text-ok:" + JSON.stringify(T.getNode(r.tree, [1, 0]).props) + "@" + T.pathKey(r.path) + "," + JSON.stringify(t0[1].children[0].props));
  out.push("text-reject:" + [
    T.applyTextEdit(t0, "0", "level", "3", schemaOf),
    T.applyTextEdit(t0, "0", "__proto__", "x", schemaOf),
    T.applyTextEdit(t0, "0", "constructor", "x", schemaOf),
    T.applyTextEdit(t0, "0", "text", 3, schemaOf),
    T.applyTextEdit(t0, "9.9", "text", "x", schemaOf),
    T.applyTextEdit(t0, "1", "text", "x", schemaOf),
  ].map(String).join(","));
  const t1 = T.applyTextEdit(t0, "0", "text", "제목", schemaOf).tree;
  out.push("text-same:" + (T.applyTextEdit(t1, "0", "text", "제목", schemaOf).tree === t1) + "," + T.applyTextEdit(t0, "0", "text", "가".repeat(30000), schemaOf).tree[0].props.text.length);
  // 11-2. 목록형 속성의 한 칸 — 그 줄·그 칸만, 나머지 줄은 글자 그대로
  const cellTree = [{ block: "a/f", props: { items: "제목1 |설명1\n\n제목2|설명2 | /x | truck" } }];
  const cellSchema = (b) => (b === "a/f" ? { items: { type: "string" }, n: { type: "number" } } : undefined);
  r = T.applyCellEdit(cellTree, "0", "items", 1, 1, "새 설명", cellSchema);
  out.push("cell-ok:" + JSON.stringify(r.tree[0].props.items) + "," + JSON.stringify(cellTree[0].props.items));
  r = T.applyCellEdit(cellTree, "0", "items", 0, 0, "칸|늘리기\n줄", cellSchema);
  out.push("cell-sep:" + JSON.stringify(r.tree[0].props.items.split("\n")[0]));
  r = T.applyCellEdit(cellTree, "0", "items", 0, 2, "/link", cellSchema);
  out.push("cell-grow:" + JSON.stringify(r.tree[0].props.items.split("\n")[0]));
  out.push("cell-reject:" + [
    T.applyCellEdit(cellTree, "0", "items", 5, 0, "x", cellSchema),
    T.applyCellEdit(cellTree, "0", "items", 0.5, 0, "x", cellSchema),
    T.applyCellEdit(cellTree, "0", "n", 0, 0, "x", cellSchema),
    T.applyCellEdit(cellTree, "0", "items", 0, 0, 7, cellSchema),
  ].map(String).join(","));
  out.push("cell-same:" + (T.applyCellEdit(cellTree, "0", "items", 1, 0, "제목2", cellSchema).tree === cellTree));
  // 12. 미리보기 안에서 끌어다 놓기 — 앞·뒤·안, 트리에서 다시 확인한다
  r = T.applyMove(base(), "2", "1.0", "before", accepts);
  out.push("move-before:" + names(r.tree) + "@" + T.pathKey(r.path));
  r = T.applyMove(base(), "0", "1.1", "after", accepts);
  out.push("move-after:" + names(r.tree) + "@" + T.pathKey(r.path));
  r = T.applyMove(base(), "0", "3", "inside", accepts);
  out.push("move-inside:" + names(r.tree) + "@" + T.pathKey(r.path));
  out.push("move-reject:" + [
    T.applyMove(base(), "0", "2", "inside", accepts),
    T.applyMove(base(), "1", "1.0", "before", accepts),
    T.applyMove(base(), "0", "2", "sideways", accepts),
    T.applyMove(base(), "0", "7", "before", accepts),
    T.applyMove(base(), 0, "2", "before", accepts),
  ].map(String).join(","));
  console.log(out.join("\n"));
' "$ROOT/apps/web/src/lib/block-tree.ts" 2>&1 || true)"
# 시험 코드가 던지면(연산이 깨졌다) 스모크를 멈추지 않고 아래 검사들이 실패로 드러나게 한다
[[ "$TREE_OUT" == *Error* ]] && echo "  (트리 연산 시험이 던졌습니다: $(echo "$TREE_OUT" | grep -m1 Error))"
line() { echo "$TREE_OUT" | grep "^$1:" | head -1 | cut -d: -f2-; }
check "같은 목록 아래로 — 놓은 자리 그대로" "$(line down)" '[{"core/columns",[{"a/l"},{"a/r"}]},{"a/p"},{"a/h"},{"core/columns",[]}]@2'
check "뒤쪽 다단 안으로 — 빠진 자리만큼 경로가 당겨진다" "$(line into-later)" '[{"core/columns",[{"a/l"},{"a/r"}]},{"a/p"},{"core/columns",[{"a/h"}]}]@2.0'
check "자기 자신·자기 안쪽으로는 옮기지 않는다" "$(line self)" "null,null"
check "밖으로 빼기 — 감싼 블록 바로 뒤" "$(line outdent)" '[{"a/h"},{"core/columns",[{"a/l"}]},{"a/r"},{"a/p"},{"core/columns",[]}]@2'
check "위 다단 안으로 넣기 · 위가 컨테이너가 아니면 안 된다" "$(line indent)" '[{"a/h"},{"core/columns",[{"a/l"},{"a/r"},{"a/p"}]},{"core/columns",[]}]@1.2,null'
check "형제 사이 이동 · 끝에서는 더 못 간다" "$(line sibling)" '[{"a/h"},{"core/columns",[{"a/r"},{"a/l"}]},{"a/p"},{"core/columns",[]}]@1.1,null'
check "복제는 깊은 복사" "$(line dup)" '2,{},2,{"text":"x"}'
check "연산이 원본 트리를 바꾸지 않는다" "$(line pure)" "true"
check "개요는 깊이와 함께 펼친다" "$(line flat)" "0:a/h,0:core/columns,1:a/l,1:a/r,0:a/p,0:core/columns"
check "경로 읽기 — 틀린 표기는 null" "$(line parse)" "[[1,0,2],null,null,null]"
check "제자리 이동은 같은 트리" "$(line noop)" "true@2"
check "미리보기에서 고친 글자를 그 블록에 반영한다 (원본은 그대로)" "$(line text-ok)" '{"text":"고친 글자"}@1.0,{}'
check "스키마의 글자 속성이 아니면 받지 않는다 (숫자 속성·__proto__·글자 아닌 값·없는 경로·스키마 없는 블록)" "$(line text-reject)" "null,null,null,null,null,null"
check "같은 값은 같은 트리 · 너무 긴 값은 자른다" "$(line text-same)" "true,20000"
check "목록의 한 칸만 고친다 — 다른 줄·빈 줄은 글자 그대로" "$(line cell-ok)" '"제목1 |설명1\n\n제목2 | 새 설명 | /x | truck","제목1 |설명1\n\n제목2|설명2 | /x | truck"'
check "고친 칸에 칸 구분자·줄바꿈이 오면 공백으로 (카드가 갈라지지 않게)" "$(line cell-sep)" '"칸 늘리기 줄 | 설명1"'
check "없던 칸을 채우면 그 칸까지만 늘린다" "$(line cell-grow)" '"제목1 | 설명1 | /link"'
check "없는 줄·정수 아닌 줄·글자 아닌 속성·글자 아닌 값은 받지 않는다" "$(line cell-reject)" "null,null,null,null"
check "같은 값이면 같은 트리" "$(line cell-same)" "true"
check "미리보기에서 끌어 놓기 — 다단 안의 칸 앞으로" "$(line move-before)" '[{"a/h"},{"core/columns",[{"a/p"},{"a/l"},{"a/r"}]},{"core/columns",[]}]@1.0'
check "미리보기에서 끌어 놓기 — 칸 뒤로 (빠진 자리만큼 경로가 당겨진다)" "$(line move-after)" '[{"core/columns",[{"a/l"},{"a/r"},{"a/h"}]},{"a/p"},{"core/columns",[]}]@0.2'
check "미리보기에서 끌어 놓기 — 빈 다단 안으로" "$(line move-inside)" '[{"core/columns",[{"a/l"},{"a/r"}]},{"a/p"},{"core/columns",[{"a/h"}]}]@2.0'
check "컨테이너 아닌 블록 안·자기 안쪽·모르는 방향·없는 경로·글자 아닌 경로는 받지 않는다" "$(line move-reject)" "null,null,null,null,null"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-layout-secret-value}"
export BRICK_CAPTCHA=off

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done
assert_own_api "$API_PID" "$API_PORT" "$TMP/api.log"

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"배치","adminEmail":"admin@le.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@le.test","password":"adminpass123"}' >/dev/null
for u in member other; do
  printf '{"email":"%s@le.test","password":"password123","agreements":{"terms":true,"privacy":true},"displayName":"%s"}' "$u" "$u" > "$TMP/reg.json"
  curl -s -o /dev/null -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/reg.json"
done
OTHER_ID="$(node -e '
  const { Client } = require(process.argv[1]);
  (async () => { const c = new Client(process.env.DATABASE_URL); await c.connect();
    const r = await c.query("SELECT id FROM users WHERE email = $1", ["other@le.test"]);
    console.log(r.rows[0]?.id ?? ""); await c.end(); })();
' "$ROOT/apps/api/node_modules/pg")"
curl -s -o /dev/null -b "$CK" -X PUT "$API/api/users/$OTHER_ID" -H 'content-type: application/json' -d '{"role":"admin"}'
for u in member other; do
  printf '{"email":"%s@le.test","password":"password123"}' "$u" > "$TMP/login.json"
  curl -s -o /dev/null -c "$TMP/$u.txt" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/login.json"
done
MEMBER="$TMP/member.txt"; OTHER="$TMP/other.txt"

echo "── 블록 목록이 컨테이너를 알려 준다"
BLOCKS="$(curl -s -b "$CK" "$API/api/blocks")"
check "다단 레이아웃은 안에 블록을 넣을 수 있다" \
  "$(echo "$BLOCKS" | python3 -c "import sys,json; print(next((b.get('acceptsChildren') for b in json.load(sys.stdin) if b['name']=='core/columns'), None))")" "True"
check "제목 블록은 아니다" \
  "$(echo "$BLOCKS" | python3 -c "import sys,json; print(next((b.get('acceptsChildren', False) for b in json.load(sys.stdin) if b['name']=='core/heading'), None))")" "False"

echo "── 초안 맡기기"
SESSION="sess-$(date +%s)-a1"
DRAFT="$(printf '{"session":"%s","slug":"about","title":"회사 소개 초안","seo":{},"blocks":[{"block":"core/heading","props":{"text":"배치 초안 제목","level":2}},{"block":"core/columns","props":{"gap":24},"children":[{"block":"core/paragraph","props":{"text":"왼쪽 칸 문장"}},{"block":"core/paragraph","props":{"text":"오른쪽 칸 문장"}}]},{"block":"core/columns","props":{},"children":[]},{"block":"nope/none","props":{}},{"block":"core/features","props":{"title":"특징","items":"| 빈 제목 줄\\n첫 카드 | 첫 설명\\n둘째 카드 | 둘째 설명 | /go"}},{"block":"core/stats","props":{"items":"| 라벨만\\n99%% | 만족도"}},{"block":"core/cta","props":{"title":"지금","buttonLabel":"지금 보기","buttonUrl":"/shop"}}]}' "$SESSION")"
put_draft() {  # put_draft <쿠키|없음> <본문> → 상태코드
  if [[ "$1" == "-" ]]; then code -X POST "$API/api/admin/pages/draft-preview" -H 'content-type: application/json' -d "$2"
  else code -b "$1" -X POST "$API/api/admin/pages/draft-preview" -H 'content-type: application/json' -d "$2"; fi
}
check "손님은 초안을 맡길 수 없다" "$(put_draft - "$DRAFT")" "401"
check "회원도 맡길 수 없다" "$(put_draft "$MEMBER" "$DRAFT")" "403"
BAD_SESSION="$(printf '{"session":"x","slug":"about","title":"t","blocks":[]}')"
check "세션 이름이 틀리면 거절" "$(put_draft "$CK" "$BAD_SESSION")" "400"
BAD_TREE="$(printf '{"session":"%s","slug":"about","title":"t","blocks":[{"block":"core/columns","props":{},"children":"문자열"}]}' "$SESSION")"
R="$(curl -s -b "$CK" -w ' %{http_code}' -X POST "$API/api/admin/pages/draft-preview" -H 'content-type: application/json' -d "$BAD_TREE")"
[[ "$R" == *" 400" && "$R" == *"안쪽 블록 목록"* ]] && ok "모양이 틀린 트리는 무엇이 틀렸는지 말하고 거절" || bad "틀린 트리 (${R:0:160})"
DEEP="$(python3 -c "
import json
n = {'block': 'core/columns', 'props': {}, 'children': []}
root = n
for _ in range(13):
    c = {'block': 'core/columns', 'props': {}, 'children': []}; n['children'].append(c); n = c
print(json.dumps({'session': '$SESSION', 'slug': 'about', 'title': 't', 'blocks': [root]}))")"
check "너무 깊은 트리는 거절" "$(put_draft "$CK" "$DEEP")" "400"
PUT="$(curl -s -b "$CK" -X POST "$API/api/admin/pages/draft-preview" -H 'content-type: application/json' -d "$DRAFT")"
URL="$(echo "$PUT" | jq_get "['url']")"
check "맡기면 미리보기 주소를 준다" "$URL" "/api/admin/pages/draft-preview/$SESSION"

echo "── 초안 미리보기 — 실제 테마로, 블록마다 위치를 달고"
HDR="$TMP/preview.hdr"
HTML="$(curl -s -b "$CK" -D "$HDR" "$API$URL")"
check "그린다" "$(head -1 "$HDR" | awk '{print $2}')" "200"
contains "저장하지 않은 내용이 보인다" "$HTML" "배치 초안 제목"
contains "첫 블록에 위치 0" "$HTML" 'data-brick-node="0"'
contains "다단 안의 둘째 칸에 위치 1.1" "$HTML" 'data-brick-node="1.1"'
contains "다단 안의 문장도 그린다" "$HTML" "오른쪽 칸 문장"
EMPTY_BOX="$(python3 -c "
import re, sys
h = sys.stdin.read()
i = h.find('data-brick-node=\"2\"')
print(h[i:i+600])" <<< "$HTML")"
contains "빈 다단 레이아웃은 눌러서 고를 수 있게 자리를 채운다" "$EMPTY_BOX" "빈 칸"
contains "빈 다단의 자리는 끌어다 넣을 곳으로 표시한다" "$EMPTY_BOX" "brick-edit-empty"
absent "모르는 블록 안내는 넣을 곳이 아니다" "$(python3 -c "
import sys
h = sys.stdin.read()
i = h.find('data-brick-node=\"3\"')
print(h[i:i+400])" <<< "$HTML")" "brick-edit-empty"
contains "고른 블록의 이름표를 끌어 미리보기 안에서 옮기고, 옮길 것을 편집기에 보낸다" "$HTML" "tell({ brick: 'move', from: from, to: t.path, where: t.where })"
UNKNOWN_BOX="$(python3 -c "
import sys
h = sys.stdin.read()
i = h.find('data-brick-node=\"3\"')
print(h[i:i+400])" <<< "$HTML")"
contains "모르는 블록도 보이게 그린다 (지울 수 있게)" "$UNKNOWN_BOX" "알 수 없는 블록 (nope/none)"
contains "편집기와 이야기하는 스크립트가 붙는다" "$HTML" "brick: 'select'"
contains "제목은 그 자리에서 고칠 수 있게 표시한다" "$HTML" '<h2 data-brick-prop="text">배치 초안 제목</h2>'
contains "특징 카드의 제목은 그 칸(원문 순서 줄·칸)으로 표시한다" "$HTML" '<h3 data-brick-prop="items" data-brick-row="2" data-brick-col="0">둘째 카드</h3>'
contains "블록이 걸러 낸 줄이 있어도 원문 순서로 센다 (숫자 강조)" "$HTML" '<strong data-brick-prop="items" data-brick-row="1" data-brick-col="0">99%</strong>'
contains "버튼 문구도 그 자리에서 고칠 수 있다" "$HTML" 'href="/shop" data-brick-prop="buttonLabel">지금 보기</a>'
contains "고치는 중인 링크 안을 눌러도 이동하지 않는다" "$HTML" "if (e.target.closest && e.target.closest('a')) e.preventDefault();"
contains "문단은 여러 줄로 고칠 수 있게 표시한다" "$HTML" '<p data-brick-prop="text" data-brick-multiline="1">왼쪽 칸 문장</p>'
contains "두 번 누르면 고치고, 고친 글자(HTML 아님)를 보낸다" "$HTML" "brick: 'text', path: node.getAttribute('data-brick-node'), prop: el.getAttribute('data-brick-prop'), value: value.slice(0, 20000)"
contains "메시지는 같은 출처로만 보낸다" "$HTML" "P.postMessage(msg, ORIGIN)"
# 스크립트는 템플릿 문자열 안에 산다 — 이스케이프 하나가 빠지면(\n 이 진짜 줄바꿈이 되는 등) 통째로 문법 오류가 되어
# 선택·테두리·글자 고치기가 모두 죽는데, 글자를 찾는 검사로는 보이지 않는다. 실제로 읽혀 보는지 본다
RUNTIME_OK="$(python3 -c "import sys,re; m=re.findall(r'<script>([\s\S]*?)</script>', sys.stdin.read()); print(m[-1] if m else '')" <<< "$HTML" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{new Function(s);console.log(s.includes("dblclick")?"ok":"no-runtime")}catch(e){console.log("syntax: "+e.message)}})')"
check "편집기 스크립트가 문법 오류 없이 읽힌다" "$RUNTIME_OK" "ok"
contains "테마의 화면 틀로 그린다 (페이지 제목)" "$HTML" "회사 소개 초안"
PUBLIC_HOME="$(curl -s "$API/api/render/page?path=" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))')"
THEME_CSS="$(echo "$PUBLIC_HOME" | grep -oE '<link[^>]+rel="stylesheet"[^>]*>' | head -1)"
[[ -n "$THEME_CSS" && "$HTML" == *"$THEME_CSS"* ]] && ok "공개 화면과 같은 테마 스타일시트" || bad "테마 스타일시트 ($THEME_CSS)"
contains "손님이 보는 모습으로 그린다 (로그인 링크)" "$HTML" "/login"
HDRS="$(tr -d '\r' < "$HDR" | tr 'A-Z' 'a-z')"
contains "캐시하지 않는다" "$HDRS" "cache-control: no-store"
contains "검색엔진에 올리지 않는다" "$HDRS" "x-robots-tag: noindex"
contains "사이트와 같은 보안 정책 (CSP)" "$HDRS" "content-security-policy:"
contains "관리 화면(같은 출처)만 띄울 수 있다" "$HDRS" "frame-ancestors 'self'"

echo "── 초안은 맡긴 운영자의 것이다"
check "다른 관리자는 같은 세션 이름으로도 보지 못한다" "$(code -b "$OTHER" "$API$URL")" "404"
check "회원은 보지 못한다" "$(code -b "$MEMBER" "$API$URL")" "403"
check "손님은 보지 못한다" "$(code "$API$URL")" "401"
EXPIRED="$(curl -s -b "$CK" -w ' %{http_code}' "$API/api/admin/pages/draft-preview/sess-none-00000")"
[[ "$EXPIRED" == *" 404" && "$EXPIRED" == *"만료"* ]] && ok "없는(만료된) 초안은 그 뜻을 창 안에 보여 준다" || bad "만료 안내 (${EXPIRED:0:160})"
check "맡긴 초안은 저장되지 않는다 — 공개 주소는 여전히 없다" \
  "$(curl -s "$API/api/render/page?path=about" | jq_get "['status']")" "404"
check "페이지 목록에도 없다" "$(curl -s -b "$CK" "$API/api/pages" | python3 -c "import sys,json; print(len([p for p in json.load(sys.stdin) if p['slug']=='about']))")" "0"
BAD_SLUG="$(printf '{"session":"%s","slug":"Bad Slug!","title":"입력 중","blocks":[{"block":"core/paragraph","props":{"text":"주소를 고치는 중"}}]}' "$SESSION")"
check "입력 중인 주소가 틀려도 미리보기는 된다" "$(put_draft "$CK" "$BAD_SLUG")" "201"
contains "새 초안으로 바뀐다 (같은 세션)" "$(curl -s -b "$CK" "$API$URL")" "주소를 고치는 중"

echo "── 저장 — 모양이 틀린 트리는 받지 않는다 · 공개 화면에는 편집 표시가 없다"
BAD_SAVE="$(printf '{"slug":"layout-bad","title":"틀린 트리","status":"published","blocks":[{"block":"core/paragraph","props":"문자열"}]}')"
check "속성이 객체가 아니면 저장하지 않는다" "$(code -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' -d "$BAD_SAVE")" "400"
NO_NAME="$(printf '{"slug":"layout-bad","title":"틀린 트리","status":"published","blocks":[{"props":{}}]}')"
check "블록 이름이 없으면 저장하지 않는다" "$(code -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' -d "$NO_NAME")" "400"
GOOD="$(printf '{"slug":"layout-ok","title":"배치 저장","status":"published","blocks":[{"block":"core/columns","props":{"gap":16},"children":[{"block":"core/paragraph","props":{"text":"저장된 왼쪽"}},{"block":"core/paragraph","props":{"text":"저장된 오른쪽"}}]}]}')"
check "다단 안에 블록을 넣은 트리를 저장한다" "$(code -b "$CK" -X POST "$API/api/pages" -H 'content-type: application/json' -d "$GOOD")" "201"
PUB="$(curl -s "$API/api/render/page?path=layout-ok" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html",""))')"
contains "공개 화면이 다단 안의 블록을 그린다" "$PUB" "저장된 오른쪽"
absent "공개 화면에는 위치 표시가 없다" "$PUB" "data-brick-node"
absent "공개 화면에는 고치기 표시도 없다" "$PUB" "data-brick-prop"
absent "공개 화면에는 편집기 스크립트가 없다" "$PUB" "brick-edit"
absent "로그인한 운영자가 봐도 없다" "$(curl -s -b "$CK" "$API/api/render/page?path=layout-ok")" "data-brick-node"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ -n "${BRICK_SMOKE_LOG:-}" ]] && echo "$(basename "${BASH_SOURCE[0]}") ${PASS} ${FAIL}" >> "$BRICK_SMOKE_LOG"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
