#!/usr/bin/env bash
#
# brick-point 포인트 E2E 스모크 테스트.
#
# 포인트는 돈에 준하므로 다음을 반드시 검증한다:
#   - 원장 무결성 (잔액 == 증감 총합)
#   - 멱등성 (같은 원인으로 두 번 적립되지 않음)
#   - 원자성 (주문 실패 시 포인트가 차감되지 않음)
#   - FIFO 소비와 만료
#   - 플러그인 간 협력 (게시판·쇼핑몰 연동, 포인트 없이도 각자 동작)
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-point.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="${DATABASE_URL:?DATABASE_URL이 필요합니다}"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
PT="$API/api/plugins/brick-point"
BD="$API/api/plugins/brick-board"
SH="$API/api/plugins/brick-shop"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
MEMBER="$TMP/member.txt"
PASS=0; FAIL=0

cleanup() { [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check()    { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (기대 $3, 실제 $2)"; }
contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1 (\"$3\" 없음: ${2:0:140})"; }
code()     { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jpost()    { curl -s -X POST "$1" -H 'content-type: application/json' --data-binary "@$2"; }
balance()  { curl -s -b "$MEMBER" "$PT/my" | python3 -c 'import sys,json;print(json.load(sys.stdin)["balance"])'; }
psql_one() { node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(process.argv[1]);
  console.log(Object.values(rows[0] ?? {}).join('|'));
  await c.end();
})();
" "$1"; }

echo "▶ brick-point 포인트 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-point-secret-value}"

node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; cat "$TMP/api.log"; exit 1; }
  sleep 1
done

# ── 준비 ────────────────────────────────────────────
printf '{"siteName":"Point","adminEmail":"admin@pt.test","adminPassword":"ptpass1234"}' > "$TMP/i.json"
jpost "$API/api/install" "$TMP/i.json" >/dev/null
printf '{"email":"admin@pt.test","password":"ptpass1234"}' > "$TMP/la.json"
curl -s -c "$ADMIN" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/la.json" >/dev/null

echo "── 플러그인 간 서비스 (활성화 순서에 무관해야 한다)"
# 쇼핑몰을 먼저 켠다 — 이 시점에 포인트 서비스는 없다
curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-shop/activate" >/dev/null
contains "포인트 없이 쇼핑몰 동작" "$(curl -s "$SH/payment-methods")" '"pointsAvailable":false'
# 그다음 포인트를 켠다 — 쇼핑몰이 사용 시점에 조회하므로 즉시 반영되어야 한다
contains "포인트 플러그인 활성화" "$(curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-point/activate")" '"ok":true'
contains "서비스 공개 로그" "$(cat "$TMP/api.log")" 'provides service "points"'
contains "쇼핑몰이 포인트를 인식" "$(curl -s "$SH/payment-methods")" '"pointsAvailable":true'
curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-board/activate" >/dev/null

echo "── 회원가입 적립"
printf '{"email":"member@pt.test","password":"memberpass1","displayName":"회원"}' > "$TMP/reg.json"
jpost "$API/api/register" "$TMP/reg.json" >/dev/null
printf '{"email":"member@pt.test","password":"memberpass1"}' > "$TMP/lm.json"
curl -s -c "$MEMBER" -X POST "$API/api/auth/login" -H 'content-type: application/json' --data-binary "@$TMP/lm.json" >/dev/null
sleep 1
check "가입 적립 1000" "$(balance)" "1000"
contains "적립 내역 표시" "$(curl -s -b "$MEMBER" "$PT/my")" "회원가입 축하"
check "비로그인 조회 401" "$(code "$PT/my")" "401"

echo "── 게시판 활동 적립 (훅 연동)"
printf '{"slug":"free","title":"자유","write_role":"member","comment_role":"member","write_interval":0}' > "$TMP/b.json"
curl -s -b "$ADMIN" -X POST "$BD/admin/boards" -H 'content-type: application/json' --data-binary "@$TMP/b.json" >/dev/null
printf '{"title":"글","content":"<p>본문</p>"}' > "$TMP/p.json"
PID="$(curl -s -b "$MEMBER" -X POST "$BD/boards/free/posts" -H 'content-type: application/json' --data-binary "@$TMP/p.json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
sleep 1
check "글쓰기 적립 (+10)" "$(balance)" "1010"
printf '{"content":"댓글"}' > "$TMP/c.json"
curl -s -b "$MEMBER" -X POST "$BD/posts/$PID/comments" -H 'content-type: application/json' --data-binary "@$TMP/c.json" >/dev/null
sleep 1
check "댓글 적립 (+5)" "$(balance)" "1015"
# 같은 글로 두 번 적립되지 않아야 한다 (멱등 인덱스)
check "글 적립은 1회만 기록" "$(psql_one "SELECT count(*) FROM point_ledger WHERE ref_type='board.post'")" "1"

echo "── 사용 가능액 계산 (주문 한도)"
USABLE="$(curl -s -b "$MEMBER" "$PT/usable?amount=20000")"
contains "잔액 노출" "$USABLE" '"balance":1015'
contains "적립률 노출" "$USABLE" '"earnRate"'
# 한도 50%: 20000의 50% = 10000 > 잔액 1015 → 1015
contains "한도 내 사용 가능액" "$USABLE" '"usable":1015'
# 최소 사용액 미달이면 0
contains "최소 사용액 미달 시 0" "$(curl -s -b "$MEMBER" "$PT/usable?amount=100")" '"usable":0'

echo "── 쇼핑몰 포인트 결제"
printf '{"slug":"item","name":"테스트 상품","price":20000,"stock":10,"status":"selling"}' > "$TMP/prod.json"
PROD="$(curl -s -b "$ADMIN" -X POST "$SH/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/prod.json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
printf '{"items":[{"productId":"%s","quantity":1}],"pointUsed":1000}' "$PROD" > "$TMP/q.json"
QUOTE="$(curl -s -b "$MEMBER" -X POST "$SH/quote" -H 'content-type: application/json' --data-binary "@$TMP/q.json")"
contains "견적에 포인트 반영" "$QUOTE" '"pointUsed":1000'
contains "총액에서 차감 (20000-1000+3000)" "$QUOTE" '"total":22000'
# 잔액을 넘는 요청은 상한이 적용되어야 한다
printf '{"items":[{"productId":"%s","quantity":1}],"pointUsed":99999}' "$PROD" > "$TMP/q2.json"
contains "잔액 초과 요청은 상한 적용" "$(curl -s -b "$MEMBER" -X POST "$SH/quote" -H 'content-type: application/json' --data-binary "@$TMP/q2.json")" '"pointUsed":1015'
# 비회원은 포인트를 쓸 수 없다
printf '{"items":[{"productId":"%s","quantity":1}],"pointUsed":500,"orderer":{"ordererName":"손님","ordererPhone":"010-0000-0000","postcode":"06236","address1":"서울"}}' "$PROD" > "$TMP/guest.json"
check "비회원 포인트 사용 차단" "$(code -X POST "$SH/orders" -H 'content-type: application/json' --data-binary "@$TMP/guest.json")" "400"

printf '{"items":[{"productId":"%s","quantity":1}],"pointUsed":1000,"orderer":{"ordererName":"회원","ordererPhone":"010-1111-2222","postcode":"06236","address1":"서울"}}' "$PROD" > "$TMP/o.json"
ORDER="$(curl -s -b "$MEMBER" -X POST "$SH/orders" -H 'content-type: application/json' --data-binary "@$TMP/o.json")"
ONO="$(echo "$ORDER" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("orderNo",""))')"
[[ -n "$ONO" ]] && ok "포인트 사용 주문 생성" || bad "포인트 사용 주문 생성"
check "주문 시 즉시 차감 (1015-1000)" "$(balance)" "15"
contains "사용 내역 기록" "$(curl -s -b "$MEMBER" "$PT/my")" "주문 결제"

echo "── 결제 완료 적립"
printf '{"orderNo":"%s","provider":"bank_transfer","providerTid":"tid-1","amount":22000}' "$ONO" > "$TMP/pay.json"
contains "결제 승인" "$(curl -s -b "$ADMIN" -X POST "$SH/payments/confirm" -H 'content-type: application/json' --data-binary "@$TMP/pay.json")" '"ok":true'
sleep 1
# 22000의 1% = 220
check "구매 적립 (+220)" "$(balance)" "235"
check "같은 주문 적립은 1회만" "$(psql_one "SELECT count(*) FROM point_ledger WHERE kind='earn' AND ref_type='shop.order'")" "1"

echo "── 환불 시 포인트 복원"
printf '{"orderNo":"%s","reason":"고객 요청"}' "$ONO" > "$TMP/rf.json"
contains "전액 환불" "$(curl -s -b "$ADMIN" -X POST "$SH/admin/payments/refund" -H 'content-type: application/json' --data-binary "@$TMP/rf.json")" '"remaining":0'
sleep 1
check "사용 포인트 복원 (235+1000)" "$(balance)" "1235"
contains "복원 내역 표시" "$(curl -s -b "$MEMBER" "$PT/my")" "포인트 반환"
# 재환불은 결제 내역이 없어 거부되고, 포인트도 중복 복원되지 않아야 한다
curl -s -b "$ADMIN" -X POST "$SH/admin/payments/refund" -H 'content-type: application/json' --data-binary "@$TMP/rf.json" >/dev/null
check "재환불에도 잔액 유지" "$(balance)" "1235"

echo "── 원자성 (주문 실패 시 차감되지 않는다)"
printf '{"slug":"scarce","name":"희귀상품","price":50000,"stock":1,"status":"selling"}' > "$TMP/scarce.json"
PROD2="$(curl -s -b "$ADMIN" -X POST "$SH/admin/products" -H 'content-type: application/json' --data-binary "@$TMP/scarce.json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
BEFORE="$(balance)"
PIDS=()
for i in 1 2 3; do
  printf '{"items":[{"productId":"%s","quantity":1}],"pointUsed":500,"orderer":{"ordererName":"회원%s","ordererPhone":"010-0000-0000","postcode":"06236","address1":"서울"}}' "$PROD2" "$i" > "$TMP/cc$i.json"
  curl -s -b "$MEMBER" -X POST "$SH/orders" -H 'content-type: application/json' --data-binary "@$TMP/cc$i.json" -o "$TMP/cr$i.json" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" || true; done
SUCCESS="$(grep -l orderNo "$TMP"/cr*.json 2>/dev/null | wc -l | tr -d ' ')"
check "재고 1개에 동시 3주문 → 1건 성공" "$SUCCESS" "1"
AFTER="$(balance)"
check "실패한 주문은 포인트 미차감" "$((BEFORE - AFTER))" "500"

echo "── 원장 무결성"
# 잔액(만료 안 된 remaining 합) == 증감 총합. 어긋나면 어디선가 원장과 잔액이 분리되었다는 뜻
INTEGRITY="$(psql_one "SELECT (SELECT coalesce(sum(remaining),0) FROM point_ledger WHERE amount>0 AND remaining>0 AND (expires_at IS NULL OR expires_at>now())) = (SELECT coalesce(sum(amount),0) FROM point_ledger) AS same")"
check "잔액 == 증감 총합" "$INTEGRITY" "true"

echo "── FIFO 소비 (만료 임박한 것부터)"
# 만료일이 다른 두 적립을 만들고, 사용 시 이른 것부터 깎이는지 본다
MEMBER_ID="$(psql_one "SELECT id FROM users WHERE email='member@pt.test'")"
node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(\"DELETE FROM point_ledger WHERE user_id = \$1\", ['$MEMBER_ID']);
  await c.query(\`INSERT INTO point_ledger (id, user_id, amount, remaining, kind, reason, expires_at)
    VALUES (gen_random_uuid(), \$1, 300, 300, 'earn', '먼저 만료', now() + interval '5 days'),
           (gen_random_uuid(), \$1, 300, 300, 'earn', '나중 만료', now() + interval '300 days')\`, ['$MEMBER_ID']);
  await c.end();
})();
"
printf '{"adjust":-200,"reason":"FIFO 확인"}' > "$TMP/adj.json"
curl -s -b "$ADMIN" -X PUT "$PT/admin/balances/$MEMBER_ID" -H 'content-type: application/json' --data-binary "@$TMP/adj.json" >/dev/null
FIFO="$(psql_one "SELECT remaining FROM point_ledger WHERE reason='먼저 만료'")"
check "만료 임박한 적립부터 소비 (300-200)" "$FIFO" "100"
LATER="$(psql_one "SELECT remaining FROM point_ledger WHERE reason='나중 만료'")"
check "나중 만료 적립은 그대로" "$LATER" "300"

echo "── 만료 처리"
node -e "
const pg = require('$ROOT/apps/api/node_modules/pg');
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  // 이미 만료된 적립을 넣는다
  await c.query(\`INSERT INTO point_ledger (id, user_id, amount, remaining, kind, reason, expires_at)
    VALUES (gen_random_uuid(), \$1, 500, 500, 'earn', '만료된 적립', now() - interval '1 day')\`, ['$MEMBER_ID']);
  await c.end();
})();
"
EXPIRED_BALANCE="$(curl -s -b "$MEMBER" "$PT/my" | python3 -c 'import sys,json;print(json.load(sys.stdin)["balance"])')"
check "만료된 적립은 잔액에서 제외 (100+300)" "$EXPIRED_BALANCE" "400"

echo "── 관리자 기능"
check "비관리자 잔액 목록 차단" "$(code -b "$MEMBER" "$PT/admin/balances")" "403"
contains "회원별 잔액 목록" "$(curl -s -b "$ADMIN" "$PT/admin/balances")" '"balance"'
printf '{"adjust":1000,"reason":"이벤트 지급"}' > "$TMP/grant.json"
contains "관리자 수동 지급" "$(curl -s -b "$ADMIN" -X PUT "$PT/admin/balances/$MEMBER_ID" -H 'content-type: application/json' --data-binary "@$TMP/grant.json")" '"ok":true'
check "지급 반영 (400+1000)" "$(balance)" "1400"
printf '{"adjust":-99999,"reason":"과다 차감"}' > "$TMP/over.json"
check "잔액 초과 차감 거부" "$(code -b "$ADMIN" -X PUT "$PT/admin/balances/$MEMBER_ID" -H 'content-type: application/json' --data-binary "@$TMP/over.json")" "400"
check "거부 후 잔액 유지" "$(balance)" "1400"
contains "관리자 원장 조회" "$(curl -s -b "$ADMIN" "$PT/admin/ledger/$MEMBER_ID")" '"kind"'

echo "── 설정"
contains "설정 조회" "$(curl -s -b "$ADMIN" "$PT/admin/settings")" '"purchaseRate"'
printf '{"postPoint":50,"purchaseRate":3,"maxUseRate":30}' > "$TMP/set.json"
contains "설정 저장" "$(curl -s -b "$ADMIN" -X PUT "$PT/admin/settings" -H 'content-type: application/json' --data-binary "@$TMP/set.json")" '"postPoint":50'
printf '{"purchaseRate":999}' > "$TMP/badset.json"
check "범위 밖 설정 거부" "$(code -b "$ADMIN" -X PUT "$PT/admin/settings" -H 'content-type: application/json' --data-binary "@$TMP/badset.json")" "400"

echo "── 관리 화면 · 블록"
NAV="$(curl -s -b "$ADMIN" "$API/api/admin/nav")"
contains "포인트 리소스 등록" "$NAV" '"name":"balances"'
contains "설정 리소스 등록" "$NAV" '"name":"settings"'
contains "내 포인트 블록" "$(curl -s "$API/api/blocks")" "brick-point/my-points"

echo "── 플러그인 비활성화 시 서비스 해제"
curl -s -b "$ADMIN" -X POST "$API/api/plugins/brick-point/deactivate" >/dev/null
contains "포인트 비활성화 후 쇼핑몰은 계속 동작" "$(curl -s "$SH/payment-methods")" '"pointsAvailable":false'
check "포인트 API는 사라짐" "$(code "$PT/my")" "404"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -40 "$TMP/api.log"; exit 1; }
