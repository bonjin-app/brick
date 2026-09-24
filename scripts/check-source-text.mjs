#!/usr/bin/env node
/**
 * 소스 파일에 제어 문자(탭·줄바꿈 말고)가 없다.
 *
 * OAuth 리다이렉트 검사와 게시판 XSS 새니타이저가 정규식 `[\x00-\x1f]` 를 쓰면서 `\x00` 을
 * 이스케이프가 아닌 **실제 NUL 바이트**로 넣고 있었다. 동작은 멀쩡하지만 grep 이 그 파일을
 * 바이너리로 보고 **검색에서 통째로 뺀다** — 보안 감사에서 "그 함수를 찾을 수 없다" 가
 * 나왔고, 하필 가장 들여다봐야 할 두 파일이었다. 이스케이프(`\x00`)로 적는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git", ".next", ".turbo", "uploads", "data"]);
const EXT = /\.(ts|tsx|mjs|js|sh|md|html|css|json|sql|yml|yaml)$/;
const problems = [];
let scanned = 0;
const walk = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = dir ? join(dir, e.name) : e.name;
    if (e.isDirectory()) { walk(rel); continue; }
    if (!EXT.test(e.name) || e.name.endsWith(".min.js")) continue;
    scanned += 1;
    const b = readFileSync(join(ROOT, rel));
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
        const line = b.subarray(0, i).toString("utf8").split("\n").length;
        problems.push(`${rel}:${line} — 제어 문자 0x${c.toString(16).padStart(2, "0")} (grep 이 이 파일을 바이너리로 보고 검색에서 뺍니다 — \\x${c.toString(16).padStart(2, "0")} 로 적으세요)`);
        break;
      }
    }
  }
};
for (const top of ["apps", "packages", "plugins", "themes", "scripts", "docs"]) walk(top);
if (problems.length) {
  console.error("❌ 소스에 제어 문자가 있습니다:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
console.log(`✅ 소스 ${scanned}개 파일에 제어 문자가 없습니다`);
