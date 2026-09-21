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

pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  fi
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

# assert_own_stub <pid> <port> <이름> <로그파일>
#
# 스텁(PG·SMTP·OIDC)도 API 와 같은 함정을 가진다 — 남이 그 포트를 쥐고 있으면
# 우리 스텁은 죽고, 수트는 **남의 프로세스**에 요청을 보내며 로그를 기다린다.
# 전제가 무너졌으면 결과를 내지 않는 것이 옳다: 여기서 멈춘다. 뒤의 단언 수십
# 개가 의미 없이 무너지면 진짜 원인 한 줄이 그 목록에 묻힌다(실제로 59개
# 실패 속에서 그 한 줄을 찾아야 했다).
assert_own_stub() {
  local pid="$1" port="$2" name="$3" log="${4:-}"
  if kill -0 "$pid" 2>/dev/null && [[ " $(pids_on_port "$port" | tr '\n' ' ') " == *" $pid "* ]]; then
    return 0
  fi
  echo "❌ ${name} 스텁이 :${port} 를 잡지 못했습니다 — 다른 프로세스가 쓰고 있을 수 있습니다."
  echo "   그대로 두면 남의 프로세스에 요청을 보내며 뜻 모를 실패를 쏟습니다."
  [[ -n "$log" && -f "$log" ]] && tail -5 "$log"
  exit 1
}
