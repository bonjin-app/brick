#!/bin/sh
# Brick 컨테이너 부팅: 마이그레이션 → API → Web
set -e

echo "[brick] applying core migrations..."
node /app/api/dist/migrate.js || true

echo "[brick] starting api (:3001, internal)..."
BRICK_API_PORT=3001 node /app/api/dist/main.js &

echo "[brick] starting web (:3000, public)..."
cd /app/web && exec node apps/web/server.js
