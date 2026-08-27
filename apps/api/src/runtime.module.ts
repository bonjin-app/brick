import { Global, Module } from "@nestjs/common";
import { createDb } from "@brick/database";
import { HookBus, LogMailProvider, DisabledCaptchaProvider } from "@brick/core";
import { PostgresCacheProvider } from "./providers/postgres-cache.provider.js";
import { PostgresQueueProvider } from "./providers/postgres-queue.provider.js";
import { LocalStorageProvider } from "./providers/local-storage.provider.js";
import { SmtpMailProvider } from "./providers/smtp-mail.provider.js";
import { SvgCaptchaProvider } from "./providers/svg-captcha.provider.js";
import { loadEnv } from "./config/env.js";

export const DB = "BRICK_DB";
export const HOOKS = "BRICK_HOOKS";
export const CACHE = "BRICK_CACHE";
export const QUEUE = "BRICK_QUEUE";
export const STORAGE = "BRICK_STORAGE";
export const MAIL = "BRICK_MAIL";
export const CAPTCHA = "BRICK_CAPTCHA";
export const ENV = "BRICK_ENV";

/**
 * RuntimeModule — Provider 조립 지점.
 *
 * 원칙: Brick Core는 PostgreSQL만으로 완전히 동작한다.
 *  - REDIS_URL 있음  → RedisCache/RedisQueue (추후 @brick/redis 패키지)
 *  - REDIS_URL 없음  → Postgres 기반 기본 구현 (지금)
 *  - STORAGE_DRIVER  → local(기본) | s3 | r2
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: DB,
      // loadEnv를 거쳐야 설정 파일(data/brick.config.json)의 값도 반영된다.
      // process.env를 직접 읽으면 FTP식 설치(웹에서 DB 정보 입력)가 동작하지 않는다.
      useFactory: (env: ReturnType<typeof loadEnv>) => {
        if (!env.databaseUrl) throw new Error("DATABASE_URL is required");
        return createDb(env.databaseUrl);
      },
      inject: [ENV],
    },
    { provide: HOOKS, useValue: new HookBus() },
    {
      provide: CACHE,
      useFactory: (db: unknown) => new PostgresCacheProvider(db as never),
      inject: [DB],
    },
    {
      provide: QUEUE,
      useFactory: (db: unknown) => new PostgresQueueProvider(db as never),
      inject: [DB],
    },
    {
      provide: STORAGE,
      useFactory: (env: ReturnType<typeof loadEnv>) => new LocalStorageProvider(env.uploadsDir),
      inject: [ENV],
    },
    {
      // SMTP_HOST가 없으면 콘솔 출력으로 폴백한다 — 메일 서버 없이도 개발이 막히지 않는다
      provide: MAIL,
      useFactory: (env: ReturnType<typeof loadEnv>) =>
        env.smtp ? new SmtpMailProvider(env.smtp) : new LogMailProvider(),
      inject: [ENV],
    },
    {
      // BRICK_CAPTCHA=off 로 끌 수 있다 (개발 편의). 기본은 켜짐.
      provide: CAPTCHA,
      useFactory: (env: ReturnType<typeof loadEnv>, cache: unknown) =>
        process.env.BRICK_CAPTCHA === "off"
          ? new DisabledCaptchaProvider()
          : new SvgCaptchaProvider(env.secret, cache as never),
      inject: [ENV, CACHE],
    },
  ],
  exports: [DB, HOOKS, CACHE, QUEUE, STORAGE, MAIL, CAPTCHA, ENV],
})
export class RuntimeModule {}
