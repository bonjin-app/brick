#!/usr/bin/env node
/**
 * 스모크 테스트용 DB 초기화.
 *
 * 스모크 테스트는 "설치되지 않은 Brick"을 전제로 하므로 매번 빈 DB가 필요하다.
 * 로컬에서 반복 실행할 때 이전 실행의 데이터가 남아 실패하는 것을 막는다.
 * (CI는 job마다 새 postgres 서비스를 쓰므로 영향이 없다)
 *
 * psql에 의존하지 않는다 — 개발 머신에 postgresql-client가 없을 수 있다.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * pnpm 워크스페이스에서는 의존성이 루트로 호이스팅되지 않는다.
 * pg 를 가진 패키지 기준으로 해석한다 (모노레포 · 배포본 양쪽 지원).
 */
const candidates = [
  join(repoRoot, "apps/api/package.json"),
  join(repoRoot, "api/package.json"),
  join(repoRoot, "package.json"),
];
const anchor = candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
const require = createRequire(anchor);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[reset-db] DATABASE_URL이 필요합니다.");
  process.exit(1);
}

// 실수로 운영 DB를 지우지 않도록 최소한의 안전장치
if (process.env.NODE_ENV === "production" && process.env.BRICK_SMOKE_FORCE !== "1") {
  console.error("[reset-db] NODE_ENV=production 에서는 거부합니다. (BRICK_SMOKE_FORCE=1 로 강제)");
  process.exit(1);
}

let pg;
try {
  pg = require("pg");
} catch {
  console.error(
    "[reset-db] pg 모듈을 찾을 수 없습니다. 먼저 `pnpm install` 을 실행하세요.",
  );
  process.exit(1);
}
const dbName = new URL(url).pathname.slice(1);

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  // public 스키마를 통째로 재생성하는 것이 테이블을 하나씩 지우는 것보다 확실하다
  // (플러그인이 만든 테이블·시퀀스·확장 인덱스까지 모두 정리된다)
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  console.log(`[reset-db] "${dbName}" 초기화 완료`);
} catch (err) {
  console.error(`[reset-db] 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
