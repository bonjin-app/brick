# syntax=docker/dockerfile:1
#
# Brick — 단일 이미지 안에 web(Next.js) + api(NestJS)를 함께 담는다.
# 사용자에게 Brick은 "하나의 앱 컨테이너 + PostgreSQL"이다 (ADR-1).

# ── 1. 의존성 + 빌드 ───────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable pnpm
WORKDIR /app

# 빌드 캐시 효율: lockfile 먼저
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/theme-sdk/package.json packages/theme-sdk/
COPY plugins/brick-board/package.json plugins/brick-board/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# pnpm 워크스페이스의 node_modules는 스토어를 가리키는 심볼릭 링크라 그대로 복사할 수 없다.
# pnpm deploy가 자기완결적인 번들을 만들어준다.
RUN pnpm deploy --filter=@brick/api --prod /deploy/api

# ── 2. 런타임 ─────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    BRICK_API_PORT=3001 \
    BRICK_API_URL=http://127.0.0.1:3001 \
    BRICK_PLUGINS_DIR=/app/plugins \
    BRICK_THEMES_DIR=/app/themes \
    BRICK_UPLOADS_DIR=/app/uploads \
    BRICK_MIGRATIONS_DIR=/app/api/migrations \
    PORT=3000

# pg_dump/pg_restore (백업 CLI), curl (healthcheck), tini (PID 1 시그널 처리)
RUN apk add --no-cache postgresql17-client curl tini

# API: 자기완결적 번들
COPY --from=build /deploy/api ./api
COPY --from=build /app/packages/database/migrations ./api/migrations

# Web: Next.js standalone (모노레포 레이아웃 유지)
COPY --from=build /app/apps/web/.next/standalone ./web
COPY --from=build /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build /app/apps/web/public ./web/apps/web/public

# 기본 동봉 확장 — 볼륨이 비어 있을 때 시딩된다
COPY --from=build /app/plugins/brick-board/brick.plugin.json /app/plugins/brick-board/package.json ./seed/plugins/brick-board/
COPY --from=build /app/plugins/brick-board/dist ./seed/plugins/brick-board/dist
COPY --from=build /app/plugins/brick-board/migrations ./seed/plugins/brick-board/migrations
COPY --from=build /app/themes/default ./seed/themes/default

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && \
    mkdir -p /app/plugins /app/themes /app/uploads && \
    addgroup -g 1001 brick && adduser -D -u 1001 -G brick brick && \
    chown -R brick:brick /app

# root로 실행하지 않는다
USER brick

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/install/status || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
