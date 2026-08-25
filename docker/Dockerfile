# Brick — 단일 이미지 안에 web(Next.js) + api(NestJS)를 함께 담는다.
# 사용자에게 Brick은 "하나의 앱 컨테이너 + PostgreSQL"이다.
FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime
RUN corepack enable pnpm
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone + API dist + 런타임 자산(plugins/themes는 볼륨으로 오버레이 가능)
COPY --from=build /app/apps/web/.next/standalone ./web
COPY --from=build /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build /app/apps/api/dist ./api/dist
COPY --from=build /app/apps/api/node_modules ./api/node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/themes ./themes
COPY --from=build /app/packages/database/migrations ./migrations
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
