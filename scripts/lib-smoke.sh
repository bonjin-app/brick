#!/usr/bin/env bash
#
# 스모크 수트가 함께 쓰는 도구 — **포트 사고**를 잡는다.
#
# 모든 수트는 자기 API 를 :3001 에 띄우고 그 주소로 이야기한다. 그 포트를 다른
# 프로세스가 이미 잡고 있으면 우리 서버는 EADDRINUSE 로 죽는데, `curl /readyz` 는
# **그 남의 서버**에 붙어 성공한다. 그래서 수트는 남의 서버를 검사하며 뜻 모를
# 실패를 쏟는다 — 오늘 실제로 한 번 그랬다(개발용으로 띄워 둔 API 가 포트를 쥐고
# 있어서, 스모크가 그 서버를 향해 돌다가 DB 를 초기화해 버렸다).
#
# 대기 루프의 `kill -0 $API_PID` 검사로는 못 잡는다: curl 이 먼저 성공해 break 하기
# 때문이다. 그래서 **포트의 주인이 우리인지**를 따로 확인한다.

# 스텁 스크립트를 찾을 뿌리. 부르는 수트마다 ROOT 를 갖고 있지만, 이 파일이
# 자기 위치를 아는 편이 낫다 — 수트가 ROOT 를 다른 뜻으로 쓰더라도 깨지지 않는다.
LIB_SMOKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# lsof 는 매칭이 없으면 종료코드 1 을 낸다. `set -euo pipefail` 아래에서는 그
# 파이프라인 하나가 스크립트 전체를 죽인다 — CI 에서 "고아 프로세스 정리"가
# 실행조차 되지 않고 조용히 중단된 적이 있다. 그래서 끝에서 0 을 돌려준다.
# lsof 가 없는 리눅스 이미지도 있으므로 ss · fuser 로 물러난다.
pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
  fi
  return 0
}

# assert_own_api <pid> <port> <로그파일>
assert_own_api() {
  local pid="$1" port="$2" log="${3:-}" owners
  owners="$(pids_on_port "$port" | tr '\n' ' ')"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "❌ API 가 뜨지 못했습니다 (:$port)"
    [[ -n "${owners// /}" ]] && echo "   지금 그 포트를 쓰는 프로세스: $owners"
    [[ -n "$log" && -f "$log" ]] && tail -20 "$log"
    exit 1
  fi
  # 포트 주인을 알아낼 수 없는 환경(lsof·ss 둘 다 없음)에서는 넘어간다 —
  # 확인할 수 없는 것을 실패로 만들면 CI 가 이유 없이 빨개진다.
  [[ -z "${owners// /}" ]] && return 0
  if [[ " $owners " != *" $pid "* ]]; then
    echo "❌ :$port 를 다른 프로세스가 쓰고 있습니다 ($owners) — 우리가 띄운 서버($pid)가 아닙니다."
    echo "   그대로 두면 **남의 서버**를 검사하게 됩니다. 그 프로세스를 멈추고 다시 돌리세요."
    exit 1
  fi
}

# start_stub <스크립트> <시작포트> <로그> [스크립트 인자...] → "포트 PID" 를 stdout 으로
#
# 고정 포트 하나만 시도하면 **남이 그 포트를 쥔 날 수트가 통째로 못 돈다.**
# 고정 포트가 리눅스 임시포트 범위(32768–60999) 안이라 다른 프로세스의 나가는
# 소켓과 드물게 충돌하는데, CI 에서 실제로 났다. 그때 할 일은 멈추는 것이 아니라
# **옆 포트로 비키는 것**이다 — 스텁 주소는 수트가 환경변수로 넘기므로 포트가
# 몇 번인지는 아무도 신경 쓰지 않는다.
#
# 다섯 번까지 옆으로 옮겨 보고, 매번 **우리 프로세스가 그 포트를 잡았는지**
# 확인한다 — 포트가 열렸는지가 아니라 **누가 듣고 있는지**가 중요하다. 남이
# 쥐고 있는데 그대로 달리면 수트는 남의 프로세스에 요청을 보내며 로그를
# 기다린다. 다섯 번 다 실패하면 1 을 반환하니
# 부르는 쪽이 그 자리에서 멈춰야 한다 — 전제가 무너진 채로 달리면 뒤의 단언
# 수십 개가 의미 없이 무너지고 진짜 원인 한 줄이 그 목록에 묻힌다.
start_stub() {
  local script="$1" base="$2" log="$3"; shift 3
  local port pid offset i
  for offset in 0 1 2 3 4; do
    port=$((base + offset))
    # 이전 실행이 남긴 **우리 스텁이면** 정리한다 — 살아 있으면 우리 기록이
    # 비어 있는데도 응답이 와서 통과해 버린다. 남의 프로세스는 죽이지 않는다:
    # 개발자 기계에서 이 포트를 쓰는 남의 서버를 말없이 kill -9 하는 것은
    # 테스트가 할 일이 아니다. 남이면 옆 포트로 비킨다.
    for p in $(pids_on_port "$port"); do
      [[ "$(ps -p "$p" -o command= 2>/dev/null)" == *"$(basename "$script")"* ]] || continue
      kill -9 "$p" 2>/dev/null || true
    done
    node "$LIB_SMOKE_ROOT/$script" --port "$port" "$@" > "$log" 2>&1 &
    pid=$!
    for i in $(seq 1 30); do
      grep -q 'listening' "$log" 2>/dev/null && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    if kill -0 "$pid" 2>/dev/null && [[ " $(pids_on_port "$port" | tr '\n' ' ') " == *" $pid "* ]]; then
      echo "$port $pid"
      return 0
    fi
    kill "$pid" 2>/dev/null || true
  done
  return 1
}

# restart_stub <스크립트> <포트> <로그> [스크립트 인자...] → PID 를 stdout 으로
#
# 수트 중간에 스텁을 되살릴 때 쓴다(서버가 안 닿는 상황을 만든 뒤). 이때는
# **옆 포트로 비킬 수 없다** — API 는 스텁 주소를 프로세스 시작 때 환경변수로
# 받아 고정했으므로, 다른 포트에 되살리면 API 는 계속 빈 포트를 두드리고
# 수트는 "같은 포트로 되살린다"고 적어 둔 주석과 다른 일을 한다(실제로 그랬다).
# 그 포트를 되찾지 못하면 결과를 내지 않는 것이 옳다.
restart_stub() {
  local script="$1" port="$2" log="$3"; shift 3
  local pid i
  node "$LIB_SMOKE_ROOT/$script" --port "$port" "$@" > "$log" 2>&1 &
  pid=$!
  for i in $(seq 1 30); do
    grep -q 'listening' "$log" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  if kill -0 "$pid" 2>/dev/null && [[ " $(pids_on_port "$port" | tr '\n' ' ') " == *" $pid "* ]]; then
    echo "$pid"
    return 0
  fi
  echo "❌ 스텁을 :${port} 에 되살리지 못했습니다 — API 가 그 주소만 바라보므로 옆 포트로 옮길 수 없습니다." >&2
  [[ -f "$log" ]] && tail -5 "$log" >&2
  kill "$pid" 2>/dev/null || true
  return 1
}
