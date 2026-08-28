#!/usr/bin/env bash
#
# 회원 단체메일 E2E 스모크.
#
# 이 영역은 틀리면 **법을 위반한다** (정보통신망법 제50조, 3천만원 이하 과태료).
# 못박는 것:
#   - 광고는 **수신 동의한 회원에게만** 가는가
#   - 제목에 (광고)가 강제로 붙는가 (지워도 다시 붙는가)
#   - 본문에 수신거부 링크가 붙는가
#   - 수신거부가 **로그인 없이** 되는가
#   - 발송 직전에 동의를 다시 확인하는가 (대상 확정 후 철회한 사람)
#   - 탈퇴·정지 회원에게 가지 않는가
#   - 공지는 동의 없이 갈 수 있는가 (반대로 막으면 안 된다)
#
# 실제 발송 내용이 법적으로 중요하다 — (광고) 표기 · 수신거부 링크 · 동의 재확인.
# 그래서 SMTP 스텁(scripts/smtp-sink.mjs)을 띄워 **받은 메일을 직접 읽는다.**
#
# 사용법: DATABASE_URL=postgresql://... bash scripts/smoke-mailing.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${BRICK_API_PORT:-3001}"
API="http://127.0.0.1:${API_PORT}"
TMP="$(mktemp -d)"
CK="$TMP/admin.txt"
PASS=0; FAIL=0

cleanup() {
  # 진입 시점의 종료 코드를 보존한다.
  #
  # kill 한 백그라운드 프로세스를 `wait` 하면 그 종료 코드(143 = SIGTERM)가
  # **스크립트의 종료 코드가 된다** — 항목이 전부 통과했는데도 CI 가 실패로 본다.
  # 놀랍게도 뒤에서 `exit 0` 을 해도 덮이지 않으므로 `|| true` 로 흡수해야 한다.
  #
  # 앞의 "스모크가 자기 실패를 숨겼다"와 짝을 이루는 반대 방향의 버그다.
  # 하네스는 양쪽 다 정확해야 한다.
  local rc=$?
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "${SINK_PID:-}" ]]; then kill "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null || true; fi
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

echo "▶ 회원 단체메일 스모크 테스트"

if [[ "${BRICK_SMOKE_KEEP_DB:-}" != "1" ]]; then
  node "$ROOT/scripts/reset-test-db.mjs" || exit 1
fi

export BRICK_PLUGINS_DIR="$ROOT/plugins"
export BRICK_THEMES_DIR="$ROOT/themes"
export BRICK_UPLOADS_DIR="$TMP/uploads"
export BRICK_MIGRATIONS_DIR="$ROOT/packages/database/migrations"
export BRICK_SECRET="${BRICK_SECRET:-smoke-mail-secret-value}"
export BRICK_CAPTCHA=off
export BRICK_SITE_URL="${BRICK_SITE_URL:-https://mail.test}"

# 1단계: SMTP 없이 띄운다 — "SMTP 미설정이면 발송을 막는가"를 먼저 확인한다
node "$ROOT/apps/api/dist/main.js" > "$TMP/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "서버 종료:"; tail -30 "$TMP/api.log"; exit 1; }
  sleep 1
done

if [[ "$(curl -s "$API/api/install/status")" == *not_installed* ]]; then
  curl -s -X POST "$API/api/install" -H 'content-type: application/json' \
    -d '{"siteName":"메일","adminEmail":"admin@ml.test","adminPassword":"adminpass123"}' >/dev/null
fi
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@ml.test","password":"adminpass123"}' >/dev/null

echo "── 회원 준비 (동의 여부를 나눠 만든다)"
# 동의한 회원 2명
for n in 1 2; do
  printf '{"email":"yes%s@ml.test","password":"password123","displayName":"동의%s","agreements":{"terms":true,"privacy":true,"marketing":true}}' "$n" "$n" > "$TMP/y$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/y$n.json" >/dev/null
done
# 거부한 회원 2명
for n in 1 2; do
  printf '{"email":"no%s@ml.test","password":"password123","displayName":"거부%s","agreements":{"terms":true,"privacy":true,"marketing":false}}' "$n" "$n" > "$TMP/n$n.json"
  curl -s -X POST "$API/api/register" -H 'content-type: application/json' --data-binary "@$TMP/n$n.json" >/dev/null
done
CONSENTED="$(psql_q "SELECT count(*) FROM users WHERE marketing_opt_in = true")"
check "동의 회원 2명" "$CONSENTED" "2"

echo "── 발송 종류와 법적 근거 안내"
KINDS="$(curl -s -b "$CK" "$API/api/admin/mail/kinds")"
contains "공지 종류" "$KINDS" '"code":"notice"'
contains "광고 종류" "$KINDS" '"code":"ad"'
contains "법적 근거를 화면에 알려준다" "$KINDS" "정보통신망법 제50조"
contains "공지는 동의 무관 안내" "$KINDS" "수신 동의와 무관하게"
check "비관리자는 접근 불가" "$(code "$API/api/admin/mail/kinds")" "401"

echo "── 대상 미리보기 (잘못 보내는 것은 되돌릴 수 없다)"
NOTICE_PRE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"notice"}')"
contains "공지는 전원 (관리자1 + 회원4)" "$NOTICE_PRE" '"count":5'
AD_PRE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"ad"}')"
contains "광고는 동의자만 2명" "$AD_PRE" '"count":2'
contains "동의하지 않아 빠진 인원 표시" "$AD_PRE" '"excludedByConsent":3'
contains "표본 주소는 가려서 보여준다" "$AD_PRE" '"sample":["'
absent "표본에 전체 주소 노출 안 함" "$AD_PRE" "yes1@ml.test"
check "잘못된 종류 거부" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
      -d '{"kind":"bogus"}')" "400"

echo "── 조건 필터"
ROLE_PRE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"notice","filters":{"roles":["admin"]}}')"
contains "역할 필터 (관리자 1명)" "$ROLE_PRE" '"count":1'
VERIFIED_PRE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"notice","filters":{"verifiedOnly":true}}')"
contains "인증 회원만 (아직 0명)" "$VERIFIED_PRE" '"count":0'
INACTIVE_PRE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"notice","filters":{"inactiveDays":365}}')"
contains "장기 미접속 (방금 가입했으므로 0명)" "$INACTIVE_PRE" '"count":0'

echo "── 검증"
check "제목 없으면 거부" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
      -d '{"kind":"notice","subject":"","body":"본문"}')" "400"
check "본문 없으면 거부" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
      -d '{"kind":"notice","subject":"제목","body":"  "}')" "400"
check "잘못된 종류 거부" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
      -d '{"kind":"nope","subject":"제목","body":"본문"}')" "400"
check "비관리자는 생성 불가" \
  "$(code -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
      -d '{"kind":"notice","subject":"제목","body":"본문"}')" "401"

echo "── 공지 캠페인 (동의 없이 전원)"
NOTICE="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"notice","subject":"약관 개정 안내","body":"약관이 개정되었습니다."}')"
NID="$(echo "$NOTICE" | jq_get "['id']")"
[[ -n "$NID" ]] && ok "공지 캠페인 생성" || bad "공지 캠페인 생성"
contains "대상 5명 확정" "$NOTICE" '"total":5'
NSUBJECT="$(psql_q "SELECT subject FROM mail_campaigns WHERE id='$NID'")"
check "공지 제목에 (광고)가 붙지 않는다" "$NSUBJECT" "약관 개정 안내"
NRECIP="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$NID'")"
check "수신자 행 5개 (대상을 미리 확정)" "$NRECIP" "5"
NO_CONSENT_INCLUDED="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$NID' AND email LIKE 'no%@ml.test'")"
check "공지는 거부자에게도 간다 (막으면 안 된다)" "$NO_CONSENT_INCLUDED" "2"

echo "── 광고 캠페인: 제목에 (광고)가 강제로 붙는다"
AD="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"ad","subject":"봄맞이 세일","body":"30% 할인합니다."}')"
AID="$(echo "$AD" | jq_get "['id']")"
[[ -n "$AID" ]] && ok "광고 캠페인 생성" || bad "광고 캠페인 생성"
ASUBJECT="$(psql_q "SELECT subject FROM mail_campaigns WHERE id='$AID'")"
check "(광고) 강제 표기" "$ASUBJECT" "(광고) 봄맞이 세일"
contains "광고 대상은 2명" "$AD" '"total":2'
AD_RECIP="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$AID' AND email LIKE 'no%@ml.test'")"
check "거부자는 대상에 없다 (위법 발송 차단)" "$AD_RECIP" "0"
AD_YES="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$AID' AND email LIKE 'yes%@ml.test'")"
check "동의자만 대상" "$AD_YES" "2"
# 이미 (광고)가 있으면 중복하지 않는다
AD2="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"ad","subject":"(광고) 이미 붙어있음","body":"본문"}')"
AID2="$(echo "$AD2" | jq_get "['id']")"
A2SUBJECT="$(psql_q "SELECT subject FROM mail_campaigns WHERE id='$AID2'")"
check "(광고)를 중복해서 붙이지 않는다" "$A2SUBJECT" "(광고) 이미 붙어있음"

echo "── 탈퇴·정지 회원은 대상에서 빠진다"
NO1_ID="$(psql_q "SELECT id FROM users WHERE email='no1@ml.test'")"
curl -s -b "$CK" -X POST "$API/api/admin/users/$NO1_ID/withdraw" -H 'content-type: application/json' \
  -d '{"reason":"테스트"}' >/dev/null
AFTER_WD="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"notice"}')"
contains "탈퇴 회원 제외 (5 → 4)" "$AFTER_WD" '"count":4'
# 내부 주소(.invalid)도 제외된다 — 탈퇴 회원의 익명 주소가 그것이다
INVALID="$(psql_q "SELECT count(*) FROM users WHERE email LIKE '%.invalid' AND withdrawn_at IS NOT NULL")"
[[ "$INVALID" -ge 1 ]] && ok "탈퇴 회원은 .invalid 주소를 갖는다" || bad "탈퇴 회원 주소 확인"

echo "── SMTP 없이 발송 시작을 막는다 (전부 실패로 기록되지 않게)"
START="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/$NID/send")"
contains "SMTP 미설정 안내" "$START" "SMTP가 설정되지 않아"
STATUS_AFTER="$(psql_q "SELECT status FROM mail_campaigns WHERE id='$NID'")"
check "시작되지 않고 작성중 유지" "$STATUS_AFTER" "draft"
SENT_NONE="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$NID' AND status <> 'pending'")"
check "아무에게도 보내지 않음" "$SENT_NONE" "0"

echo "── 대상 없는 캠페인은 시작할 수 없다"
EMPTY="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"notice","subject":"아무도 없음","body":"본문","filters":{"inactiveDays":9999}}')"
EID="$(echo "$EMPTY" | jq_get "['id']")"
contains "대상 0명" "$EMPTY" '"total":0'
NOBODY="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/$EID/send")"
contains "받을 사람이 없다고 알려준다" "$NOBODY" "받을 사람이 없습니다"
contains "광고 조건을 함께 안내" "$NOBODY" "수신 동의한 회원에게만"

echo "── 수신거부 (로그인 없이 되어야 한다)"
# 토큰은 광고 발송 시 만들어지지만, 여기서는 DB에 직접 넣어 흐름을 검증한다
YES1_ID="$(psql_q "SELECT id FROM users WHERE email='yes1@ml.test'")"
psql_q "INSERT INTO mail_unsubscribe_tokens (user_id, token) VALUES ('$YES1_ID', 'test-unsub-token-abc')" >/dev/null
BEFORE="$(psql_q "SELECT marketing_opt_in FROM users WHERE id='$YES1_ID'")"
check "해제 전에는 동의 상태" "$BEFORE" "true"
UNSUB="$(curl -s "$API/api/mail/unsubscribe?token=test-unsub-token-abc")"
contains "로그인 없이 해제 성공" "$UNSUB" "수신이 해제되었습니다"
contains "공지는 계속 간다고 알려준다" "$UNSUB" "계속 발송됩니다"
absent "주소를 그대로 노출하지 않음" "$UNSUB" "yes1@ml.test"
AFTER="$(psql_q "SELECT marketing_opt_in FROM users WHERE id='$YES1_ID'")"
check "동의가 실제로 해제됨" "$AFTER" "false"
check "잘못된 토큰은 400 (성공처럼 응답하지 않는다)" \
  "$(code "$API/api/mail/unsubscribe?token=wrong")" "400"
contains "무엇을 해야 하는지 알려준다" \
  "$(curl -s "$API/api/mail/unsubscribe?token=wrong")" "메일의 링크를 그대로"
check "토큰 없이도 400" "$(code "$API/api/mail/unsubscribe")" "400"
# 해제 후 광고 대상이 줄어든다
AFTER_UNSUB="$(curl -s -b "$CK" -X POST "$API/api/admin/mail/preview" -H 'content-type: application/json' \
  -d '{"kind":"ad"}')"
contains "해제 후 광고 대상 1명" "$AFTER_UNSUB" '"count":1'

echo "── 목록과 상세"
LIST="$(curl -s -b "$CK" "$API/api/admin/mail")"
contains "캠페인 목록" "$LIST" "약관 개정 안내"
contains "종류 라벨" "$LIST" '"kind_label"'
contains "상태 라벨" "$LIST" '"status_label":"작성중"'
contains "작성자 표시" "$LIST" '"created_by_name"'
DETAIL="$(curl -s -b "$CK" "$API/api/admin/mail/$NID")"
contains "상세 조회" "$DETAIL" "약관 개정 안내"
contains "상태별 집계" "$DETAIL" '"byStatus"'
contains "대기 5건" "$DETAIL" '"pending":5'
check "비관리자는 상세 조회 불가" "$(code "$API/api/admin/mail/$NID")" "401"
check "없는 캠페인은 400" "$(code -b "$CK" "$API/api/admin/mail/00000000-0000-7000-8000-000000000000")" "400"

echo "── 중단"
# 발송 중이 아니어도 draft 는 중단(취소)할 수 있다
contains "작성중 캠페인 취소" "$(curl -s -b "$CK" -X POST "$API/api/admin/mail/$EID/cancel")" '"ok":true'
CANCELLED="$(psql_q "SELECT status FROM mail_campaigns WHERE id='$EID'")"
check "취소 상태" "$CANCELLED" "cancelled"
check "이미 취소된 것은 다시 취소 불가" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail/$EID/cancel")" "400"
check "취소된 캠페인은 발송 불가 (SMTP 없음이 먼저 걸린다)" \
  "$(code -b "$CK" -X POST "$API/api/admin/mail/$EID/send")" "400"

echo "── 발송 이력이 주소 스냅샷을 남긴다"
# 회원이 주소를 바꾸거나 탈퇴해도 "어디로 보냈는가"가 사라지면 안 된다
SNAPSHOT="$(psql_q "SELECT count(*) FROM mail_recipients WHERE campaign_id='$NID' AND email = 'no1@ml.test'")"
check "탈퇴한 회원의 주소도 이력에 남는다" "$SNAPSHOT" "1"
STILL_LINKED="$(psql_q "SELECT count(*) FROM mail_recipients r JOIN users u ON u.id = r.user_id WHERE r.campaign_id='$NID'")"
[[ "$STILL_LINKED" -ge 4 ]] && ok "살아 있는 회원은 연결 유지" || bad "회원 연결 유지 (실제 $STILL_LINKED)"

echo "── 감사 로그"
AUDIT="$(psql_q "SELECT count(*) FROM audit_logs WHERE action LIKE 'mail.campaign%'")"
[[ "$AUDIT" -ge 3 ]] && ok "생성·중단이 감사 로그에 남음" || bad "감사 로그 (실제 $AUDIT)"
AUDIT_SUMMARY="$(psql_q "SELECT summary FROM audit_logs WHERE action='mail.campaign_created' ORDER BY created_at LIMIT 1")"
contains "대상 인원이 기록됨" "$AUDIT_SUMMARY" "대상"

echo "══ 실제 발송 내용 (SMTP 스텁으로 받아 읽는다) ══"
# SMTP 를 켜고 서버를 다시 띄운다
kill "$API_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true

MAILBOX="$TMP/mails.jsonl"
SMTP_PORT=42527

# 이전 실행에서 살아남은 스텁을 먼저 정리한다.
#
# 이것을 빠뜨렸을 때 **테스트가 조용히 통과할 수도 있었다**: 옛 스텁이 포트를
# 잡고 있으면 새 스텁은 bind 에 실패하고 죽는데, `nc -z` 는 (옛 스텁이 듣고
# 있으니) 성공한다. 메일은 옛 스텁의 우편함으로 가고 우리 파일은 빈 채로
# 남는다. 그래서 정리하고, **우리가 띄운 프로세스가 실제로 듣고 있는지**
# 확인한다 — 포트가 열렸는지가 아니라.
pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
  fi
}
for p in $(pids_on_port "$SMTP_PORT"); do kill -9 "$p" 2>/dev/null || true; done

node "$ROOT/scripts/smtp-sink.mjs" --port "$SMTP_PORT" --out "$MAILBOX" > "$TMP/sink.log" 2>&1 &
SINK_PID=$!
for i in $(seq 1 30); do
  grep -q 'listening' "$TMP/sink.log" 2>/dev/null && break
  kill -0 "$SINK_PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$SINK_PID" 2>/dev/null && [[ "$(pids_on_port "$SMTP_PORT")" == *"$SINK_PID"* ]]; then
  ok "SMTP 스텁 시작 (우리 프로세스가 듣고 있다)"
else
  bad "SMTP 스텁 시작 (로그: $(tail -2 "$TMP/sink.log" 2>/dev/null))"
fi

export SMTP_HOST=127.0.0.1
export SMTP_PORT="$SMTP_PORT"
export SMTP_FROM="Brick <noreply@mail.test>"
node "$ROOT/apps/api/dist/main.js" > "$TMP/api2.log" 2>&1 &
API_PID=$!
for i in $(seq 1 60); do
  curl -fsS "$API/readyz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$API/readyz" >/dev/null 2>&1 && ok "SMTP 설정으로 서버 재시작" \
  || bad "SMTP 설정으로 서버 재시작 ($(tail -3 "$TMP/api2.log" 2>/dev/null))"
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@ml.test","password":"adminpass123"}' >/dev/null

mail_count() { [[ -s "$MAILBOX" ]] && wc -l < "$MAILBOX" | tr -d ' ' || echo 0; }
mail_field() {  # mail_field <필드> <주소일부>
  python3 -c "
import json, sys
for line in open(sys.argv[1], encoding='utf-8'):
    m = json.loads(line)
    if sys.argv[3] in ' '.join(m['envelopeTo']):
        print(m[sys.argv[2]])
        break
" "$MAILBOX" "$1" "$2"
}
wait_done() {  # wait_done <캠페인 id> — 발송이 끝날 때까지
  for _ in $(seq 1 60); do
    local st
    st="$(psql_q "SELECT status FROM mail_campaigns WHERE id='$1'")"
    [[ "$st" == "sent" || "$st" == "failed" || "$st" == "cancelled" ]] && return 0
    sleep 0.5
  done
  return 1
}
wait_mails() {  # wait_mails <기대 개수>
  for _ in $(seq 1 40); do
    [[ "$(mail_count)" -ge "$1" ]] && return 0
    sleep 0.5
  done
  return 1
}

echo "── 광고 발송: 동의자에게만 가고 (광고)·수신거부가 들어간다"
AD3="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"ad","subject":"여름 세일","body":"50% 할인합니다."}')"
AID3="$(echo "$AD3" | jq_get "['id']")"
# yes1 은 앞에서 수신거부했으므로 yes2 만 남는다
contains "대상 1명 (yes1은 수신거부했다)" "$AD3" '"total":1'
contains "발송 시작" "$(curl -s -b "$CK" -X POST "$API/api/admin/mail/$AID3/send")" '"queued":true'
wait_mails 1 && ok "메일이 실제로 발송됨" || bad "메일이 실제로 발송됨 (받은 수: $(mail_count))"

SUBJ="$(mail_field subject yes2@ml.test)"
check "제목에 (광고) 표기" "$SUBJ" "(광고) 여름 세일"
BODY="$(mail_field text yes2@ml.test)"
contains "본문 전달" "$BODY" "50% 할인합니다."
contains "수신거부 링크가 본문에 (정보통신망법 제50조 제4항)" "$BODY" "/api/mail/unsubscribe?token="
contains "수신거부 방법 안내 문구" "$BODY" "수신을 원하지 않으시면"
contains "로그인 불필요 안내" "$BODY" "로그인 불필요"
contains "광고임을 본문에도 밝힌다" "$BODY" "광고성 정보 수신에 동의"
RECIPIENTS="$(python3 -c "
import json
for line in open('$MAILBOX', encoding='utf-8'):
    print(' '.join(json.loads(line)['envelopeTo']))
")"
contains "동의자에게 발송" "$RECIPIENTS" "yes2@ml.test"
absent "수신거부한 회원에게 발송 안 함" "$RECIPIENTS" "yes1@ml.test"
absent "미동의 회원에게 발송 안 함" "$RECIPIENTS" "no2@ml.test"

echo "── 메일의 수신거부 링크가 실제로 동작한다"
TOKEN="$(python3 -c "
import json, re
for line in open('$MAILBOX', encoding='utf-8'):
    m = json.loads(line)
    found = re.search(r'unsubscribe\?token=([A-Za-z0-9_-]+)', m['text'])
    if found: print(found.group(1)); break
")"
[[ -n "$TOKEN" ]] && ok "본문에서 토큰 추출" || bad "본문에서 토큰 추출"
contains "링크로 수신거부 성공" "$(curl -s "$API/api/mail/unsubscribe?token=$TOKEN")" "해제되었습니다"
YES2_OPT="$(psql_q "SELECT marketing_opt_in FROM users WHERE email='yes2@ml.test'")"
check "동의가 해제됨" "$YES2_OPT" "false"

echo "── 발송 결과가 기록된다"
wait_done "$AID3" && ok "발송이 종료 상태로 마감됨" || bad "발송이 종료 상태로 마감됨"
DONE="$(curl -s -b "$CK" "$API/api/admin/mail/$AID3")"
contains "발송완료 상태" "$DONE" '"status":"sent"'
contains "성공 건수" "$DONE" '"sent":1'
SENT_ROW="$(psql_q "SELECT status, sent_at IS NOT NULL FROM mail_recipients WHERE campaign_id='$AID3'")"
check "수신자 행에 발송 시각" "$SENT_ROW" "sent|true"

echo "── 대상 확정 후 동의를 철회하면 발송 직전에 걸러진다"
# yes1 의 동의를 되살려 대상에 넣은 뒤, 발송 전에 다시 철회한다
psql_q "UPDATE users SET marketing_opt_in = true WHERE email IN ('yes1@ml.test','yes2@ml.test')" >/dev/null
AD4="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"ad","subject":"철회 검증","body":"본문입니다."}')"
AID4="$(echo "$AD4" | jq_get "['id']")"
contains "대상 2명 확정" "$AD4" '"total":2'
# 확정 직후 한 명이 철회한다
psql_q "UPDATE users SET marketing_opt_in = false WHERE email = 'yes1@ml.test'" >/dev/null
BEFORE_N="$(mail_count)"
curl -s -b "$CK" -X POST "$API/api/admin/mail/$AID4/send" >/dev/null
wait_done "$AID4" || true
SKIPPED="$(psql_q "SELECT status, error FROM mail_recipients WHERE campaign_id='$AID4' AND email='yes1@ml.test'")"
contains "철회한 사람은 건너뜀 (위법 발송 차단)" "$SKIPPED" "skipped|수신 동의 철회"
SENT_TO="$(psql_q "SELECT status FROM mail_recipients WHERE campaign_id='$AID4' AND email='yes2@ml.test'")"
check "동의 유지한 사람에게는 발송" "$SENT_TO" "sent"
NEW_RECIPIENTS="$(python3 -c "
import json
lines = list(open('$MAILBOX', encoding='utf-8'))
for line in lines[$BEFORE_N:]:
    print(' '.join(json.loads(line)['envelopeTo']))
")"
absent "철회자에게 메일이 가지 않았다" "$NEW_RECIPIENTS" "yes1@ml.test"

echo "── 공지는 동의와 무관하게 전원에게"
BEFORE_N2="$(mail_count)"
NOTICE2="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"notice","subject":"점검 안내","body":"오늘 밤 점검이 있습니다."}')"
NID2="$(echo "$NOTICE2" | jq_get "['id']")"
curl -s -b "$CK" -X POST "$API/api/admin/mail/$NID2/send" >/dev/null
wait_done "$NID2" || true
NOTICE_TO="$(python3 -c "
import json
lines = list(open('$MAILBOX', encoding='utf-8'))
for line in lines[$BEFORE_N2:]:
    print(' '.join(json.loads(line)['envelopeTo']))
")"
contains "미동의 회원에게도 공지 발송" "$NOTICE_TO" "no2@ml.test"
contains "수신거부한 회원에게도 공지 발송" "$NOTICE_TO" "yes1@ml.test"
NOTICE_SUBJ="$(python3 -c "
import json
lines = list(open('$MAILBOX', encoding='utf-8'))
for line in lines[$BEFORE_N2:]:
    m = json.loads(line)
    if 'no2@ml.test' in ' '.join(m['envelopeTo']): print(m['subject']); break
")"
check "공지 제목에 (광고)가 붙지 않는다" "$NOTICE_SUBJ" "점검 안내"
NOTICE_BODY="$(python3 -c "
import json
lines = list(open('$MAILBOX', encoding='utf-8'))
for line in lines[$BEFORE_N2:]:
    m = json.loads(line)
    if 'no2@ml.test' in ' '.join(m['envelopeTo']): print(m['text']); break
")"
absent "공지에는 수신거부 링크를 붙이지 않는다 (광고로 오인된다)" "$NOTICE_BODY" "unsubscribe?token="
contains "공지 본문 전달" "$NOTICE_BODY" "오늘 밤 점검이 있습니다."

echo "── HTML 메일에는 텍스트 대안이 함께 간다 (HTML만 보내면 스팸 판정)"
BEFORE_N3="$(mail_count)"
HTML_C="$(curl -s -b "$CK" -X POST "$API/api/admin/mail" -H 'content-type: application/json' \
  -d '{"kind":"notice","subject":"HTML 안내","body":"<p>굵게 <b>강조</b></p>","isHtml":true,"filters":{"roles":["admin"]}}')"
HID="$(echo "$HTML_C" | jq_get "['id']")"
curl -s -b "$CK" -X POST "$API/api/admin/mail/$HID/send" >/dev/null
wait_done "$HID" || true
HTML_MAIL="$(python3 -c "
import json
lines = list(open('$MAILBOX', encoding='utf-8'))
for line in lines[$BEFORE_N3:]:
    m = json.loads(line)
    if 'admin@ml.test' in ' '.join(m['envelopeTo']):
        print('HTML:', m['html']); print('TEXT:', m['text']); break
")"
contains "HTML 파트 포함" "$HTML_MAIL" "<b>강조</b>"
contains "텍스트 대안 포함 (태그가 벗겨진 형태)" "$HTML_MAIL" "굵게 강조"

echo
echo "결과: ${PASS}개 통과, ${FAIL}개 실패"
[[ $FAIL -eq 0 ]] || { echo; echo "── 서버 로그 ──"; tail -50 "$TMP/api.log"; exit 1; }
