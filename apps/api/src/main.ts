import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module.js";

/**
 * Brick API (내부 프로세스).
 * 외부에는 노출하지 않는다 — Next.js가 유일한 공개 진입점이고
 * /api/* 를 이 서버로 rewrite 한다.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.register(cookie as never);
  await app.register(multipart as never, { limits: { fileSize: 50 * 1024 * 1024 } }); // 확장 ZIP 50MB 제한
  const port = Number(process.env.BRICK_API_PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  console.log(`[brick-api] listening on :${port}`);
}
bootstrap();
