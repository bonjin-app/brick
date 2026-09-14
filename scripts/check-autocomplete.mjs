#!/usr/bin/env node
/*
 * 손님이 폰에서 **손으로 다 쳐야 하는가**.
 *
 * 왜 필요했나: 로그인 화면의 이메일·비밀번호 칸에 `name` 도 `autocomplete` 도
 * 없었다. 비밀번호 관리자와 브라우저는 이 단서로 칸을 알아본다 — 없으면 저장해
 * 둔 비밀번호가 채워지지 않고, iOS 키체인은 제안조차 하지 않는다. 가입 화면도
 * 마찬가지여서 새 비밀번호 저장을 권하지 못했다.
 *
 * 주문서는 이미 제대로 넣어 두고 있었다(name·tel·postal-code·street-address).
 * 정작 **모든 손님이 지나는 로그인·가입만** 빠져 있었다 — 이 저장소가 여러 번
 * 겪은, 한 곳에서 고치고 나머지가 남는 모양이다.
 *
 * 검사: 비밀번호 칸은 current-password 나 new-password 를, 인증 화면의 이메일
 * 칸은 username(또는 email)을 가져야 한다. 관리 화면은 보지 않는다 — 운영자가
 * 자기 정보를 채우는 자리가 아니라 데이터를 입력하는 자리다.
 *
 * 같은 태그에 autocomplete 가 **두 번** 적힌 것도 잡는다(주문서에 네 군데
 * 있었다). 브라우저는 첫 번째만 쓰고 나머지를 버리므로 조용히 넘어간다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 손님이 자기 정보를 채우는 화면 (관리 화면은 제외) */
const CUSTOMER = /apps\/web\/src\/app\/(?!admin\/\(dashboard\))/;

let checked = 0;
const bad = [];
const ok = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// ── React 화면 ────────────────────────────────────────
for (const file of walk(join(ROOT, "apps/web/src"))) {
  const rel = file.slice(ROOT.length);
  if (!CUSTOMER.test(rel)) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/<input\b[\s\S]*?\/>/g)) {
    const tag = m[0];
    const line = src.slice(0, m.index).split("\n").length;
    const ac = /autoComplete="([^"]*)"/.exec(tag)?.[1];
    if (/type="password"/.test(tag)) {
      checked++;
      /*
       * "off" 도 인정한다 — 설치 화면의 **데이터베이스** 비밀번호처럼 내 계정이
       * 아닌 칸이 있다. 비밀번호 관리자가 그것을 저장하겠다고 묻는 것이 오히려
       * 방해다. 없는 것(빠뜨림)과 off(정한 것)를 구별하는 것이 이 검사의 요지다.
       */
      if (ac === "current-password" || ac === "new-password" || ac === "off") ok.push(`${rel}:${line} 비밀번호 ${ac}`);
      else bad.push([`${rel}:${line}`, `비밀번호 칸의 autocomplete 가 없습니다 — current-password / new-password, 내 계정이 아니면 off 를 적으세요`]);
    } else if (/type="email"/.test(tag)) {
      checked++;
      if (ac === "username" || ac === "email") ok.push(`${rel}:${line} 이메일 ${ac}`);
      else bad.push([`${rel}:${line}`, `이메일 칸의 autocomplete 가 ${ac ?? "없습니다"} — 저장된 계정이 채워지지 않습니다`]);
    }
  }
}

// ── 플러그인이 서버에서 그리는 폼 ────────────────────
const pluginFiles = [];
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) pluginFiles.push(join(dir, f));
}
for (const file of pluginFiles) {
  const src = readFileSync(file, "utf8");
  const rel = file.slice(ROOT.length);
  for (const m of src.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const line = src.slice(0, m.index).split("\n").length;
    if ((tag.match(/autocomplete=/g) ?? []).length > 1) {
      checked++;
      bad.push([`${rel}:${line}`, `autocomplete 가 한 태그에 두 번 적혀 있습니다 — 브라우저는 첫 번째만 씁니다`]);
    }
  }
}

console.log("▶ 손님이 폰에서 손으로 다 치지 않아도 된다");
if (!checked) { console.log("  ❌ 입력 칸을 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)"); process.exit(1); }
console.log(`  ✅ 검사한 칸: ${checked}개`);
for (const [where, why] of bad) console.log(`  ❌ ${where}  ${why}`);
console.log(bad.length ? "" : "\n모두 알아볼 수 있습니다.");
process.exit(bad.length ? 1 : 0);
