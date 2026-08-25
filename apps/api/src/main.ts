import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./config/env.js";
import { runMigrations } from "./config/migrator.js";

/**
 * Brick API (내부 프로세스).
 * 외부에는 노출하지 않는다 — Next.js가 유일한 공개 진입점이고 /api/* 를 이 서버로 rewrite 한다.
 */
async function bootstrap() {
  const env = loadEnv();
  const logger = new Logger("Bootstrap");

  // 업데이트를 쉽게: 부팅할 때 스키마를 스스로 최신으로 맞춘다.
  // 사용자는 `docker compose pull && docker compose up -d` 외에 할 일이 없다.
  if (process.env.BRICK_AUTO_MIGRATE !== "false") {
    try {
      const result = await runMigrations(env.databaseUrl, env.migrationsDir);
      if (result.applied.length) logger.log(`applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`);
      else logger.log("database schema is up to date");
    } catch (err) {
      // 깨진 스키마로 서비스하는 것보다 뜨지 않는 것이 안전하다
      logger.error(`migration failed — refusing to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // 리버스 프록시 뒤에 있을 때 X-Forwarded-* 를 신뢰 (rate limit의 클라이언트 IP 판별에 필요)
      trustProxy: env.trustProxy,
      bodyLimit: 2 * 1024 * 1024,
    }),
  );

  await app.register(cookie as never, { secret: env.secret });
  await app.register(multipart as never, { limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 } });

  // 보안 헤더 — 내부 서버지만 Next rewrite로 그대로 전달되므로 여기서 설정한다
  app.getHttpAdapter().getInstance().addHook("onSend", (_req, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "SAMEORIGIN");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.removeHeader("x-powered-by");
    done(null, payload);
  });

  // graceful shutdown — 배포/재시작 시 처리 중 요청을 유실하지 않는다
  app.enableShutdownHooks();

  await app.listen(env.apiPort, "0.0.0.0");
  logger.log(`brick-api listening on :${env.apiPort} (${env.isProduction ? "production" : "development"})`);
}

bootstrap().catch((err) => {
  console.error("[brick-api] failed to start:", err);
  process.exit(1);
});
