#!/usr/bin/env node
/*
 * CI 의 정적 단계를 로컬에서 **빠짐없이 같은 순서로** 돌린다 — DB 도 서버도 필요 없다.
 *
 * 왜 필요했나: CI 의 "모달은 포커스를 가둔다" 단계가 9월 26일부터 실패했는데 그 단계가 작업의 앞쪽(3/109)이라
 * 뒤의 정적 검사 46개와 스모크는 그동안 CI 에서 **한 번도 실행되지 않았다.** 로컬에서는 `check-*.mjs` 만 모아 돌렸고,
 * 인라인 셸로 쓴 단계(모달 · 테마 산출물 일치 · 메일 링크 · 가입 캡차)는 그 목록에서 빠졌다 — 스무 번 넘게 푸시하는
 * 동안 CI 가 빨간 것을 몰랐다. 이 도구는 워크플로(.github/workflows/ci.yml)를 읽어 단계의 `run:` 을 그대로 돌리므로
 * **목록을 손으로 적지 않는다**(새 단계를 더하면 저절로 들어온다).
 *
 * 범위: 첫 작업의 `pnpm build` 부터 `마이그레이션`(DB 가 필요한 첫 단계) 직전까지. 스모크는 실제 PostgreSQL 이 필요하니
 * `bash scripts/smoke-*.sh` 로 따로 돈다.
 *
 * 사용법:
 *   pnpm ci:static                 # 전부 (빌드 포함 — 몇 분)
 *   pnpm ci:static --skip-build    # 빌드는 이미 했을 때
 *   pnpm ci:static --list          # 돌릴 단계만 보여 준다
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const text = readFileSync(`${ROOT}.github/workflows/ci.yml`, "utf8");

/** 첫 작업의 steps 를 단계 단위로 자른다 — `- name:` 으로 시작하고 들여쓰기는 여섯 칸이다 */
const body = text.slice(text.indexOf("steps:"));
const parts = body.split(/\n {6}- name: /).slice(1);

/** 단계에서 run 을 꺼낸다. 한 줄이거나 `|` 블록(들여쓰기 열 칸) */
function runOf(part) {
  const lines = part.split("\n");
  const at = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (at < 0) return null;
  const head = lines[at].replace(/^ {8}run:\s*/, "");
  if (head !== "|" && head !== ">" && head !== "") return head.trim();
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "") { out.push(""); continue; }
    if (!l.startsWith(" ".repeat(10))) break;
    out.push(l.slice(10));
  }
  return out.join("\n").trimEnd();
}

const steps = [];
for (const part of parts) {
  const name = part.split("\n")[0].replace(/^["']|["']$/g, "").trim();
  // 첫 DB 단계에서 끝낸다 — 그 뒤는 서버·PostgreSQL 이 있어야 돈다
  if (/^마이그레이션/.test(name)) break;
  const run = runOf(part);
  if (!run) continue; // uses: (체크아웃 · 설치 도구) 는 로컬에 해당이 없다
  if (/^pnpm install\b/.test(run)) continue;
  if (args.has("--skip-build") && /^pnpm build$/.test(run)) continue;
  steps.push({ name, run });
}

if (steps.length < 20) {
  console.error(`❌ 워크플로에서 단계를 거의 읽지 못했다 (${steps.length}) — 파서가 낡았다`);
  process.exit(2);
}
if (args.has("--list")) {
  steps.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.name}`));
  process.exit(0);
}

console.log(`▶ CI 정적 단계 ${steps.length}개 (.github/workflows/ci.yml)`);
const failed = [];
for (const [i, s] of steps.entries()) {
  const t0 = Date.now();
  const r = spawnSync("bash", ["-ec", s.run], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "true" } });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`  ✅ ${String(i + 1).padStart(2)}. ${s.name} (${sec}s)`);
  } else {
    failed.push(s.name);
    console.log(`  ❌ ${String(i + 1).padStart(2)}. ${s.name} (${sec}s)`);
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    console.log(tail.split("\n").map((l) => `       ${l}`).join("\n"));
  }
}

console.log(failed.length ? `\n${failed.length}개 실패 — CI 에서도 같은 곳에서 멈춘다` : "\n모두 통과 — CI 의 정적 단계와 같다");
process.exit(failed.length ? 1 : 0);
