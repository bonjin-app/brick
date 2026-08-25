#!/bin/sh
# Brick 컨테이너 부팅.
#
# 업데이트 절차가 `docker compose pull && docker compose up -d` 로 끝나도록,
# 필요한 모든 준비를 여기서 스스로 한다:
#   1. 볼륨이 비어 있으면 기본 플러그인/테마 시딩
#   2. DB 스키마 마이그레이션 (api 프로세스가 부팅 시 자동 수행)
#   3. api(내부) → web(공개) 기동
set -e

seed() {
  src="$1"; dst="$2"
  [ -d "$src" ] || return 0
  for item in "$src"/*; do
    name=$(basename "$item")
    if [ ! -e "$dst/$name" ]; then
      echo "[brick] seeding $dst/$name"
      cp -R "$item" "$dst/$name"
    fi
  done
}
seed /app/seed/plugins /app/plugins
seed /app/seed/themes /app/themes

# 자식 프로세스 정리: 하나가 죽으면 컨테이너 전체를 재시작시킨다
term() {
  echo "[brick] shutting down..."
  [ -n "$API_PID" ] && kill -TERM "$API_PID" 2>/dev/null
  [ -n "$WEB_PID" ] && kill -TERM "$WEB_PID" 2>/dev/null
  wait
  exit 0
}
trap term TERM INT

echo "[brick] starting api (internal :${BRICK_API_PORT})..."
cd /app/api && node dist/main.js &
API_PID=$!

# API가 준비될 때까지 대기 (마이그레이션 시간 포함)
i=0
until curl -fsS "http://127.0.0.1:${BRICK_API_PORT}/readyz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ $i -gt 60 ]; then
    echo "[brick] api failed to become ready in 60s — check logs above"
    exit 1
  fi
  # API가 이미 죽었다면 즉시 실패시킨다 (마이그레이션 실패 등)
  kill -0 "$API_PID" 2>/dev/null || { echo "[brick] api exited during startup"; exit 1; }
  sleep 1
done
echo "[brick] api ready"

echo "[brick] starting web (public :${PORT})..."
cd /app/web && node apps/web/server.js &
WEB_PID=$!

wait -n
echo "[brick] a process exited — stopping container"
term
