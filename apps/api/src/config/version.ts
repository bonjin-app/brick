import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 지금 돌고 있는 Brick 의 버전.
 *
 * 출처 우선순위:
 *   1. BRICK_VERSION 환경변수 — 배포본 런처(server.js)와 Docker 이미지가 심어 준다
 *   2. 저장소 루트 package.json (개발 중 `pnpm dev`)
 *   3. "0.0.0-dev"
 *
 * 관리자 대시보드의 "새 버전" 알림과 /api/admin/version 이 이 값을 쓴다. 릴리스 태그(v0.2.0)와
 * 여기 값이 어긋나면 알림이 잘못 뜨므로, 릴리스 워크플로가 태그에서 버전을 뽑아 배포본
 * package.json 과 이미지 ENV 양쪽에 같은 값을 넣는다.
 */
export const BRICK_VERSION: string = resolveVersion();

function resolveVersion(): string {
  const fromEnv = String(process.env.BRICK_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    // apps/api/dist/config/version.js → 저장소 루트까지 올라간다
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
        if (pkg.name === "brick" || pkg.name === "brick-release") return String(pkg.version ?? "0.0.0-dev");
      } catch {
        /* 없으면 위로 */
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "0.0.0-dev";
}

/** "1.2.3" 꼴 비교 — a > b 이면 1. 프리릴리스 접미어(-beta)는 뗀다 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
