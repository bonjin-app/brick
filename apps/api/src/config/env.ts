import { randomBytes } from "node:crypto";

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
    migrationsDir: process.env.BRICK_MIGRATIONS_DIR ?? "migrations",
    isProduction,
    trustProxy: process.env.BRICK_TRUST_PROXY === "true",
    maxUploadMb,
  };
}
