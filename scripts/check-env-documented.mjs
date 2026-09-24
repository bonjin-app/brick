#!/usr/bin/env node
/**
 * 환경변수 표와 코드가 같은 말을 하는지 본다.
 *
 * 설치 문서의 환경변수 표는 운영자가 **설정을 찾는 유일한 곳**이다. 그런데 표와
 * 코드는 따로 자란다. 실제로 둘 다 났다:
 *
 *  - 표에만 있고 코드에 없던 것: `REDIS_URL` 이 "설정 시 Redis 캐시/큐 사용" 이라고
 *    적혀 있었지만 읽는 곳이 없었다. 운영자는 **그 설정을 했기 때문에** 인스턴스를
 *    늘리고, 캐시가 공유되지 않는다고 믿고 엉뚱한 곳을 의심한다.
 *  - 코드에만 있고 표에 없던 것: `BRICK_MAX_UPLOAD_FILES`(한 요청의 파일 개수 한도)는
 *    10 에서 막히는데 표 어디에도 없어, 왜 11번째가 거절되는지 알 길이 없었다.
 *
 * 그래서 양방향으로 본다. 새 `process.env` 를 읽으면 표에 적거나 아래 목록에
 * **이유와 함께** 넣어야 하고, 표에서 지우려면 코드에서도 지워야 한다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DOC = "docs/installation.md";

// 표에 넣지 않는 것들 — 운영자가 건드릴 설정이 아니다. 이유 없이 넣지 말 것.
const INTERNAL = {
  BRICK_VERSION: "빌드가 주입한다. 사람이 설정하는 값이 아니다",
  BRICK_MIGRATIONS_DIR: "마이그레이션 파일 위치를 배포 형태에 맞게 자동으로 찾고, 테스트만 덮어쓴다",
  BRICK_TOSS_API_BASE: "결제 스텁을 향하게 하는 테스트 전용 값. 프로덕션에서 바꾸면 결제가 끊긴다",
  BRICK_ALIGO_API_BASE: "문자 스텁을 향하게 하는 테스트 전용 값",
  BRICK_ALIGO_KAKAO_API_BASE: "알림톡 스텁을 향하게 하는 테스트 전용 값",
  BRICK_PORTONE_API_BASE: "포트원 스텁을 향하게 하는 테스트 전용 값. 프로덕션에서 바꾸면 결제 확인이 끊긴다",
};

const SRC = ["apps/api/src", "apps/web/src"];
for (const group of ["packages", "plugins"]) {
  for (const name of readdirSync(join(ROOT, group))) {
    const dir = join(group, name, "src");
    try { if (statSync(join(ROOT, dir)).isDirectory()) SRC.push(dir); } catch { /* src 없는 패키지 */ }
  }
}

/** 소스에서 읽는 환경변수 → 처음 본 파일:줄 */
const read = new Map();
const walk = (dir) => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) { walk(rel); continue; }
    if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
    readFileSync(join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        if (!read.has(m[1])) read.set(m[1], `${rel}:${i + 1}`);
      }
    });
  }
};
SRC.forEach(walk);

// 문서는 "## 환경변수" 절의 표만 본다 — 같은 파일의 문제 해결 표에도 백틱이 있다.
const doc = readFileSync(join(ROOT, DOC), "utf8");
const section = doc.slice(doc.indexOf("\n## 환경변수"), doc.indexOf("\n### 설정 파일"));
if (!section.trim()) {
  console.error(`❌ ${DOC} 에서 "## 환경변수" 절을 찾지 못했습니다.`);
  process.exit(1);
}
const documented = new Set();
for (const m of section.matchAll(/^\| `([A-Z][A-Z0-9_]*)`(?: \/ `([A-Z][A-Z0-9_]*)`)? \|/gm)) {
  documented.add(m[1]);
  if (m[2]) documented.add(m[2]);
}

// 코드가 읽지 않지만 표에 있어도 되는 것 — 우리가 아니라 런타임이 읽는다.
const EXTERNAL = new Set(["PORT"]); // Next.js 가 직접 본다

const problems = [];
for (const [name, where] of [...read].sort()) {
  if (documented.has(name) || name in INTERNAL) continue;
  problems.push(`${name} — 코드가 읽지만(${where}) ${DOC} 표에 없습니다.\n` +
    `      운영자가 설정할 값이면 표에 한 줄 적고, 아니면 check-env-documented.mjs 의 INTERNAL 에 이유와 함께 넣으세요.`);
}
for (const name of [...documented].sort()) {
  if (read.has(name) || EXTERNAL.has(name)) continue;
  problems.push(`${name} — ${DOC} 표에 있지만 **읽는 코드가 없습니다.**\n` +
    `      없는 설정을 안내하는 문서는 운영자를 엉뚱한 확신으로 이끕니다. 구현하거나 표에서 지우세요.`);
}

if (problems.length) {
  console.error("❌ 환경변수 문서와 코드가 어긋납니다:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
console.log(`✅ 환경변수 ${documented.size}개 문서화 · 내부 전용 ${Object.keys(INTERNAL).length}개 — 코드와 일치`);
