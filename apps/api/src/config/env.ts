import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BrickEnv {
  databaseUrl: string;
  secret: string;
  apiPort: number;
  pluginsDir: string;
  themesDir: string;
  uploadsDir: string;
  migrationsDir: string;
  isProduction: boolean;
  trustProxy: boolean;
  maxUploadMb: number;
}

/**
 * 환경변수 검증 — 부팅 시 1회.
 * 프로덕션에서 위험한 설정(기본 시크릿 등)은 조용히 넘기지 않고 즉시 실패시킨다.
 */
export function loadEnv(): BrickEnv {
  const errors: string[] = [];
  const isProduction = process.env.NODE_ENV === "production";

  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) errors.push("DATABASE_URL is required");
  else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) errors.push("DATABASE_URL must be a postgresql:// URL");

  let secret = process.env.BRICK_SECRET ?? "";
  const WEAK = ["", "change-me", "please-change-me", "secret", "changeme"];
  if (WEAK.includes(secret)) {
    if (isProduction) {
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

  if (errors.length) {
    console.error("[brick] invalid configuration:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  return {
    databaseUrl,
    secret,
    apiPort,
    pluginsDir: process.env.BRICK_PLUGINS_DIR ?? "plugins",
    themesDir: process.env.BRICK_THEMES_DIR ?? "themes",
    uploadsDir: process.env.BRICK_UPLOADS_DIR ?? "uploads",
    migrationsDir: process.env.BRICK_MIGRATIONS_DIR ?? findMigrationsDir(),
    isProduction,
    trustProxy: process.env.BRICK_TRUST_PROXY === "true",
    maxUploadMb,
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
