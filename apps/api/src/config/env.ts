import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfigFile } from "./config-file.js";

export interface BrickEnv {
  /**
   * DB 접속 문자열. **비어 있을 수 있다** — 그때는 설치 화면만 띄우는 setup 모드로 부팅한다.
   * (FTP로 파일만 올린 상태에서 브라우저로 설치를 시작할 수 있게 하기 위함)
   */
  databaseUrl: string;
  /** DB 설정이 없어 설치 화면만 제공하는 상태 */
  setupMode: boolean;
  secret: string;
  apiPort: number;
  pluginsDir: string;
  themesDir: string;
  uploadsDir: string;
  migrationsDir: string;
  isProduction: boolean;
  trustProxy: boolean;
  maxUploadMb: number;
  maxUploadFiles: number;
  /** 메일 링크에 쓰는 공개 주소. 예: https://example.com */
  siteUrl: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  } | null;
}

/** 바깥에서 닿을 수 없는 주소인가 (프로덕션 설정 누락 판정용) */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
}

/**
 * 환경변수 검증 — 부팅 시 1회.
 * 프로덕션에서 위험한 설정(기본 시크릿 등)은 조용히 넘기지 않고 즉시 실패시킨다.
 */
let cached: BrickEnv | null = null;

/**
 * 환경 설정 로드 (프로세스당 1회).
 *
 * 여러 Provider가 호출하므로 캐시한다. 설정 파일이 설치 중에 새로 쓰이더라도
 * 재시작을 요구하는 설계이므로(연결 풀·마이그레이션이 부팅 시점에 만들어진다)
 * 캐시가 문제되지 않는다.
 */
export function loadEnv(): BrickEnv {
  if (cached) return cached;
  cached = loadEnvUncached();
  return cached;
}

/** 테스트에서 설정을 다시 읽어야 할 때 */
export function resetEnvCache(): void {
  cached = null;
}

function loadEnvUncached(): BrickEnv {
  const errors: string[] = [];
  const isProduction = process.env.NODE_ENV === "production";

  // 우선순위: 환경변수 > 설정 파일.
  // Docker/k8s에서는 환경변수가 이기므로 컨테이너를 다시 만들어도 옛 설정 파일이 방해하지 않는다.
  const configFile = readConfigFile();
  const databaseUrl = process.env.DATABASE_URL || configFile?.databaseUrl || "";
  // DB 설정이 아예 없으면 실패시키지 않고 setup 모드로 부팅한다 — 브라우저에서 설치를 시작할 수 있게.
  const setupMode = !databaseUrl;
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push("DATABASE_URL must be a postgresql:// URL");
  }

  let secret = process.env.BRICK_SECRET || configFile?.secret || "";
  const WEAK = ["", "change-me", "please-change-me", "secret", "changeme"];
  if (WEAK.includes(secret)) {
    if (setupMode) {
      // 설치 전에는 세션이 없다. 설치 완료 시 설정 파일에 강한 시크릿이 생성된다.
      secret = randomBytes(32).toString("base64url");
    } else if (isProduction) {
      errors.push(
        "BRICK_SECRET must be set to a strong random value in production " +
          "(generate: openssl rand -base64 32)",
      );
    } else {
      // 개발 환경에서는 임시 생성해 진행하되 경고한다 (재시작 시 세션 무효화)
      secret = randomBytes(32).toString("base64url");
      console.warn("[brick] BRICK_SECRET not set — generated a temporary one (dev only)");
    }
  } else if (secret.length < 16) {
    errors.push("BRICK_SECRET must be at least 16 characters");
  }

  const apiPort = Number(process.env.BRICK_API_PORT ?? 3001);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    errors.push(`BRICK_API_PORT is not a valid port: ${process.env.BRICK_API_PORT}`);
  }

  const maxUploadMb = Number(process.env.BRICK_MAX_UPLOAD_MB ?? 50);
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) errors.push("BRICK_MAX_UPLOAD_MB must be a positive number");

  const maxUploadFiles = Number(process.env.BRICK_MAX_UPLOAD_FILES ?? 10);
  if (!Number.isInteger(maxUploadFiles) || maxUploadFiles < 1 || maxUploadFiles > 50) {
    errors.push("BRICK_MAX_UPLOAD_FILES must be an integer between 1 and 50");
  }

  // 메일 안의 링크는 상대경로일 수 없다 — 공개 주소가 필요하다
  const siteUrl = (process.env.BRICK_SITE_URL ?? configFile?.siteUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(siteUrl)) errors.push("BRICK_SITE_URL must start with http:// or https://");
  if (isProduction && siteUrl.startsWith("http://") && !isLocalUrl(siteUrl)) {
    console.warn("[brick] BRICK_SITE_URL이 http:// 입니다 — 프로덕션에서는 https를 사용하세요");
  }
  /*
   * 프로덕션인데 주소가 localhost 라면 **설정을 잊은 것**이다.
   *
   * 이 값은 메일 안의 링크를 만든다 — 비밀번호 재설정, 이메일 인증, 비회원
   * 주문 조회(토큰 포함), 재입고 해지. 잊으면 메일은 정상적으로 나가는데
   * 링크가 전부 http://localhost:3000 을 가리켜 받는 사람에게는 아무 쓸모가
   * 없다. 실제로 이 경고가 없어서 조용히 그렇게 나갔다 — 위의 http/https
   * 검사는 localhost 를 **일부러 빼고** 있었다.
   */
  if (isProduction && isLocalUrl(siteUrl)) {
    console.warn(
      `[brick] BRICK_SITE_URL 이 ${siteUrl} 입니다 — 메일 안의 링크(비밀번호 재설정·이메일 인증·` +
        `주문 조회)가 전부 이 주소를 가리킵니다. 사이트의 공개 주소로 바꾸세요.`,
    );
  }

  // SMTP는 선택. 설정하면 전부 있어야 한다 (일부만 있으면 조용히 실패하므로 즉시 알린다)
  let smtp: BrickEnv["smtp"] = null;
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    const smtpPort = Number(process.env.SMTP_PORT ?? 587);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      errors.push(`SMTP_PORT is not a valid port: ${process.env.SMTP_PORT}`);
    }
    const from = process.env.SMTP_FROM ?? "";
    if (!from) errors.push("SMTP_FROM is required when SMTP_HOST is set (예: Brick <noreply@example.com>)");
    if (process.env.SMTP_USER && !process.env.SMTP_PASS) errors.push("SMTP_PASS is required when SMTP_USER is set");
    smtp = {
      host: smtpHost,
      port: smtpPort,
      // 465는 암묵적 TLS, 그 외는 STARTTLS
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : smtpPort === 465,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from,
    };
  }

  /*
   * **아직 없는 것을 설정하면 조용히 지나가지 않는다.**
   *
   * 운영 문서의 스케일링 표가 `STORAGE_DRIVER=s3` 와 `REDIS_URL` 을 안내했는데
   * 둘 다 읽는 곳이 없었다 — 설정해도 아무 일도 일어나지 않는다. 그런데
   * 운영자는 **그것을 설정했기 때문에** 인스턴스를 둘로 늘린다. 업로드가
   * 공유되지 않는다는 사실은 절반의 요청이 이미지 404 를 받은 뒤에 알게 된다.
   *
   * 저장소는 **맞지 않으면 아예 뜨지 않는다**: 로컬 디스크로 조용히 돌아가는
   * 것이 그 배포에서는 고장이다.
   */
  const storageDriver = (process.env.STORAGE_DRIVER || "local").trim().toLowerCase();
  if (storageDriver !== "local") {
    errors.push(
      `STORAGE_DRIVER="${storageDriver}" 는 아직 구현되지 않았습니다. 지금은 local 만 있습니다 — ` +
        "여러 인스턴스로 늘리려면 업로드 폴더를 공유 볼륨으로 붙이세요 (docs/operations.md 의 스케일링).",
    );
  }
  /*
   * 캐시는 막지 않는다 — PostgreSQL 캐시는 **이미 인스턴스 사이에서 공유된다**.
   * REDIS_URL 을 무시해도 동작은 옳고 다만 더 느릴 뿐이라, 뜨지 못하게 할 이유는 없다.
   * 대신 "설정했으니 Redis 를 쓰고 있다" 는 오해만 걷어낸다.
   */
  if (process.env.REDIS_URL) {
    console.warn(
      "[brick] REDIS_URL 이 설정되어 있지만 아직 Redis 구현이 없습니다 — PostgreSQL 캐시를 씁니다. " +
        "여러 인스턴스에서도 그 캐시는 공유되므로 동작은 정상입니다.",
    );
  }

  if (errors.length) {
    console.error("[brick] invalid configuration:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  return {
    databaseUrl,
    setupMode,
    secret,
    apiPort,
    pluginsDir: process.env.BRICK_PLUGINS_DIR ?? "plugins",
    themesDir: process.env.BRICK_THEMES_DIR ?? "themes",
    uploadsDir: process.env.BRICK_UPLOADS_DIR ?? "uploads",
    migrationsDir: process.env.BRICK_MIGRATIONS_DIR ?? findMigrationsDir(),
    isProduction,
    trustProxy: process.env.BRICK_TRUST_PROXY === "true",
    maxUploadMb,
    maxUploadFiles,
    siteUrl,
    smtp,
  };
}

/**
 * 마이그레이션 디렉터리 자동 탐색.
 *
 * BRICK_MIGRATIONS_DIR을 설정하지 않아도 배포 형태에 맞게 알아서 찾는다:
 *  - Docker:   /app/api/migrations  (dist 기준 ../migrations)
 *  - 모노레포: packages/database/migrations
 *  - 기타:     cwd/migrations
 * 못 찾으면 첫 후보를 반환해 마이그레이션 러너가 명확한 에러를 내게 한다.
 */
function findMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/config
  const candidates = [
    resolve(here, "../../migrations"), // dist/config → <pkg>/migrations (Docker deploy)
    resolve(process.cwd(), "migrations"),
    resolve(process.cwd(), "packages/database/migrations"),
    resolve(here, "../../../../packages/database/migrations"), // 모노레포에서 직접 실행
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir))) return dir;
  }
  return candidates[0];
}
