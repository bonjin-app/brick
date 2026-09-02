# syntax=docker/dockerfile:1
#
# Brick — 단일 이미지 안에 web(Next.js) + api(NestJS)를 함께 담는다.
# 사용자에게 Brick은 "하나의 앱 컨테이너 + PostgreSQL"이다 (ADR-1).

# ── 1. 의존성 + 빌드 ───────────────────────────────────
# LTS 에 머문다 — Node 26 은 아직 LTS 가 아니다.
# 설치형 CMS 는 사용자가 몇 년 단위로 운영하므로, 짝수라도 LTS 로 승격된 뒤에 올린다.
FROM node:24-alpine AS build
# alpine 에는 bash 가 없다 — 빌드 스크립트가 bash 문법을 쓴다
RUN apk add --no-cache bash && corepack enable pnpm
WORKDIR /app

# 워크스페이스 package.json 을 하나씩 나열하지 않는다.
# 나열하면 플러그인을 추가할 때마다 여기도 고쳐야 하고, 실제로 빠뜨려서
# "Cannot find module '@brick/plugin-sdk'" 로 이미지 빌드가 깨졌다.
# 소스를 먼저 넣고 설치하면 의존성 레이어 캐시는 덜 먹히지만 절대 썩지 않는다.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# pnpm 워크스페이스의 node_modules는 스토어를 가리키는 심볼릭 링크라 그대로 복사할 수 없다.
# pnpm deploy가 자기완결적인 번들을 만들어준다.
RUN pnpm deploy --filter=@brick/api --prod /deploy/api

# 동봉할 플러그인을 모은다 (런타임에 필요한 매니페스트 · dist · migrations 만)
RUN bash scripts/collect-plugins.sh /seed/plugins

# ── 2. 런타임 ─────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
# 릴리스 워크플로가 태그 버전을 넣는다 — 대시보드의 "새 버전" 알림이 이 값과 비교한다
ARG BRICK_VERSION=0.0.0-dev
ENV BRICK_VERSION=$BRICK_VERSION
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

# 기본 동봉 확장 — 볼륨이 비어 있을 때 시딩된다.
# 빌드 단계에서 collect-plugins.sh 가 모아둔 것을 그대로 가져온다
# (게시판만 넣던 시절엔 Docker 설치본에 쇼핑몰·포인트·쪽지가 없었다).
COPY --from=build /seed/plugins ./seed/plugins
COPY --from=build /app/themes ./seed/themes

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
