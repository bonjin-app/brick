import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module.js";
import { SetupAppModule } from "./setup.module.js";
import { loadEnv } from "./config/env.js";
import { noteProxyHeaders } from "./config/proxy-hint.js";
import { ErrorMessageFilter } from "./common/error-message.filter.js";
import { runMigrations } from "./config/migrator.js";
import { CspService } from "./modules/security/csp.service.js";
import { PluginLoaderService } from "./modules/plugins/plugin-loader.service.js";

/** 보통 JSON 본문의 한도 — API 는 파일을 멀티파트로 받으므로 이 이상이 필요 없다 */
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
/** 그누보드 이전 덤프만 예외다 — migrate.controller 의 MAX_DUMP_BYTES 와 같은 값 */
const MIGRATE_BODY_LIMIT = 64 * 1024 * 1024;

/**
 * Brick API (내부 프로세스).
 * 외부에는 노출하지 않는다 — Next.js가 유일한 공개 진입점이고 /api/* 를 이 서버로 rewrite 한다.
 */
async function bootstrap() {
  const env = loadEnv();
  const logger = new Logger("Bootstrap");

  // ── setup 모드 ────────────────────────────────────
  // DB 설정이 없으면 실패하지 않고 설치 마법사만 띄운다.
  // FTP로 파일만 올린 상태에서 브라우저로 설치를 시작할 수 있게 하기 위함이다.
  if (env.setupMode) {
    const app = await NestFactory.create<NestFastifyApplication>(
      SetupAppModule,
      new FastifyAdapter({ trustProxy: env.trustProxy }),
    );
    app.enableShutdownHooks();
    await app.listen(env.apiPort, "0.0.0.0");
    logger.warn(
      `데이터베이스가 설정되지 않았습니다 — 설치 모드로 시작합니다 (:${env.apiPort}).\n` +
        `  브라우저에서 사이트를 열어 데이터베이스 정보를 입력하세요.`,
    );
    return;
  }

  // 업데이트를 쉽게: 부팅할 때 스키마를 스스로 최신으로 맞춘다.
  // 사용자는 `docker compose pull && docker compose up -d` 외에 할 일이 없다.
  if (process.env.BRICK_AUTO_MIGRATE !== "false") {
    try {
      logger.log("데이터베이스 스키마를 확인합니다...");
      const result = await runMigrations(env.databaseUrl, env.migrationsDir, {
        log: (msg) => logger.warn(msg),
      });
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
      // 아래 onRequest 훅이 경로별로 다시 줄인다 — 여기 값은 그 중 가장 큰 것이다
      bodyLimit: MIGRATE_BODY_LIMIT,
    }),
  );

  /*
   * 본문 크기는 **경로마다 다르다.**
   *
   * API 가 받는 JSON 은 2MB 면 충분하다. 예외가 하나 있다: **그누보드 이전**은
   * 덤프(SQL 텍스트)를 JSON 으로 받는다 — 공유 호스팅에서 사용자가 손에 넣을 수
   * 있는 것이 phpMyAdmin 내보내기 파일이기 때문이다(migrate.controller 의 주석).
   *
   * 컨트롤러와 문서는 **64MB 까지 받는다**고 말하는데 파서가 2MB 에서 끊고 있었다.
   * 3.43MB 덤프가 영어로 "Request body is too large" 를 뱉었고, 실제 그누보드
   * 덤프는 거의 이보다 크다 — 문서가 안내하는 화면 업로드는 되는 일이 없었다.
   *
   * Fastify 의 기본 JSON 파서를 갈아끼우지 않는다(그것이 프로토타입 오염을
   * 막아 준다). 대신 본문을 읽기 **전에** Content-Length 로 거른다. 길이를 안
   * 보내는 chunked 요청은 서버 한도(64MB)까지 열려 있지만, 그 값은 멀티파트
   * 업로드 한도(기본 50MB)와 같은 자릿수라 새로 생기는 노출이 아니다.
   */
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (req, reply, done) => {
    /*
     * 파일 업로드(멀티파트)는 **자기 한도가 따로 있다**(BRICK_MAX_UPLOAD_MB, 기본 50MB)
     * 그리고 자기 안내 문구도 있다 — "파일이 너무 큽니다. 한 개당 최대 NMB…".
     * 여기서 같이 막으면 손님은 업로드 한도 대신 JSON 한도를 듣는다(스모크가 잡았다).
     */
    if (String(req.headers["content-type"] ?? "").startsWith("multipart/")) { done(); return; }

    const limit = String(req.url ?? "").startsWith("/api/admin/migrate/")
      ? MIGRATE_BODY_LIMIT
      : DEFAULT_BODY_LIMIT;
    const length = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > limit) {
      void reply.code(413).send({
        statusCode: 413,
        message: `요청 본문이 너무 큽니다. 최대 ${Math.floor(limit / 1024 / 1024)}MB 까지 받습니다.`,
      });
      return;
    }
    done();
  });

  /*
   * 프록시 뒤인데 신뢰하지 않는 상태인지 지켜본다 (자세한 이유는 proxy-hint.ts).
   * 켜져 있으면 볼 필요가 없으므로 훅 자체를 달지 않는다.
   */
  if (!env.trustProxy) {
    app.getHttpAdapter().getInstance().addHook("onRequest", (req, _reply, done) => {
      noteProxyHeaders(req.headers as Record<string, unknown>);
      done();
    });
  }

  /*
   * 오류 응답의 **문장**을 다듬는 전역 필터 (자세한 이유는 error-message.filter.ts).
   *  - 업로드 한도 오류를 한국어로, 한도를 숫자로 말한다
   *  - 오류 문장을 사이트 언어로 치환한다 (원문=키, 없으면 원문 그대로)
   * 전역이라 미디어·게시판 첨부·플러그인 업로드·코어 라우트가 같은 규칙을 쓴다.
   *
   * 언어는 **부를 때마다** 읽는다 — 운영자가 설정을 바꾸면 다음 오류부터
   * 따라와야 한다(플러그인 로더가 그 캐시를 들고 있고, 설정 저장이 무효화한다).
   */
  const httpAdapterHost = app.get(HttpAdapterHost);
  const loader = app.get(PluginLoaderService);
  app.useGlobalFilters(new ErrorMessageFilter(httpAdapterHost.httpAdapter, () => loader.siteLocale));

  // 응답 압축 — 테마 CSS(30KB+)·서버 렌더 HTML 이 Next 프록시를 그대로 통과하므로 여기서 눌러야 한다.
  // (Next 는 자기 페이지만 압축한다.) 이미지·zip 은 threshold 와 MIME 판정으로 건너뛴다.
  await app.register(compress as never, { global: true, encodings: ["br", "gzip"], threshold: 1024 });
  await app.register(cookie as never, { secret: env.secret });
  await app.register(multipart as never, {
    limits: {
      fileSize: env.maxUploadMb * 1024 * 1024,
      // 게시판 첨부처럼 여러 파일을 받는 플러그인이 있다.
      // 개수 제한은 각 기능이 자기 정책으로 검사한다(게시판은 board.max_files).
      files: env.maxUploadFiles,
    },
  });

  // 보안 헤더 — 내부 서버지만 Next rewrite로 그대로 전달되므로 여기서 설정한다
  /*
   * 보안 헤더. CSP 는 테마·플러그인이 선언한 출처를 합쳐야 하므로 서비스에서 받아 온다
   * (60초 캐시라 요청마다 DB 를 보지 않는다). 실패하면 나머지 헤더는 그대로 나간다 —
   * 헤더 하나 때문에 응답이 죽으면 안 된다.
   */
  const csp = app.get(CspService, { strict: false });
  app.getHttpAdapter().getInstance().addHook("onSend", async (_req, reply, payload) => {
    const header = await csp?.header().catch(() => null);
    if (header) reply.header(header.name, header.value);
    return payload;
  });
  /*
   * 개인화된 응답이 **공유 캐시에 담기지 않게** 한다.
   *
   * 지금까지 API 응답에는 cache-control 이 아예 없었다. 그런 200 응답은 중간
   * 캐시가 자기 판단으로 담을 수 있다(heuristic caching). 설치 안내는 앞에
   * Nginx·Caddy 를 두라고 하고, 실제로는 그 앞에 CDN 을 얹는 사이트가 많다 —
   * 그러면 한 손님의 `/api/me/profile`·주문 목록이 다른 손님에게 나갈 수 있다.
   *
   * 이미 자기 정책을 정한 응답(정적 자산의 immutable, 사이트맵, 캡차)은
   * 건드리지 않는다 — 정책을 아는 쪽이 하나여야 한다.
   */
  app.getHttpAdapter().getInstance().addHook("onSend", (_req, reply, payload, done) => {
    if (!reply.getHeader("cache-control")) reply.header("cache-control", "private, no-store");
    done(null, payload);
  });

  app.getHttpAdapter().getInstance().addHook("onSend", (_req, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "SAMEORIGIN");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    // 쓰지 않는 브라우저 기능은 문서 단위로 잠근다 — 삽입된 서드파티 스크립트가 카메라·위치를 요구해도 막힌다
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
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
