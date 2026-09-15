#!/usr/bin/env node
/*
 * 서버가 다 만들어 둔 기능에 **손님이 닿을 수 있는가**.
 *
 * 오늘 같은 모양을 세 번 만났다. 서버에는 라우트도 검증도 스모크도 있는데,
 * 그것을 쓰는 화면이 없어서 기능이 통째로 닿지 않는 곳에 있었다:
 *
 *   - 연결된 소셜 계정: 목록·해제 API 가 다 있었다. 화면이 없어서 회원은 자기
 *     계정에 붙은 소셜 로그인을 볼 수도 뗄 수도 없었다 — 훔친 세션으로 심어진
 *     뒷문이라면 더더욱.
 *   - 포인트 사용: 견적도 주문도 pointUsed 를 받고 `pointsAvailable` 이라는
 *     필드까지 "주문서에 UI 를 띄운다" 는 주석과 함께 있었다. 읽는 화면이 없어
 *     회원은 포인트를 쌓기만 하고 한 점도 쓰지 못했다.
 *   - 약관 재동의: 개정·목록·수락 API 가 다 있고 서버는 "동의해야 계속 이용할
 *     수 있다" 고 말하는데, 물어볼 화면이 없었다.
 *
 * 이 화면들은 클라이언트가 그린다 — 스모크(서버 HTML)로는 볼 수 없다. 그래서
 * **화면이 그 API 를 부르는지**를 여기서 본다. 완벽한 검사는 아니지만, 화면이
 * 통째로 사라지는 것은 잡는다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** [무엇을 부르는가, 없으면 무슨 일이 생기는가] */
const MUST_REACH = [
  ["/api/agreements/pending", "약관이 개정돼도 기존 회원에게 묻지 못합니다 (필수 약관은 동의해야 계속 이용할 수 있습니다)"],
  ["/api/agreements/accept", "회원이 개정 약관에 동의할 방법이 없습니다"],
  ["/api/auth/oauth/my/identities", "계정에 붙은 소셜 로그인을 회원이 보거나 뗄 수 없습니다"],
  ["pointUsed", "주문서에서 포인트를 쓸 수 없습니다 (쌓기만 하고 못 씁니다)"],
  ["/api/me/security/reauth", "민감한 작업 앞에서 비밀번호를 다시 물을 방법이 없습니다"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// 손님·운영자가 쓰는 화면 + 플러그인이 서버에서 그리는 화면(스크립트 포함)
const screens = walk(join(ROOT, "apps/web/src"));
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try { if (statSync(dir).isDirectory()) walk(dir, screens); } catch { /* 없으면 건너뛴다 */ }
}
const haystack = screens.map((f) => readFileSync(f, "utf8")).join("\n");

let fail = 0;
console.log("▶ 서버가 만들어 둔 기능에 손님이 닿을 수 있다");
for (const [needle, harm] of MUST_REACH) {
  /*
   * 따옴표까지 붙여 본다. 앞부분만 맞춰 보면 `…/pending-x` 같은 오타도 통과한다
   * (역검증에서 실제로 그랬다).
   */
  const found = needle.startsWith("/")
    ? haystack.includes(`"${needle}"`) || haystack.includes(`'${needle}'`) || haystack.includes(`\`${needle}\``)
    : new RegExp(`\\b${needle}\\b`).test(haystack);
  if (found) console.log(`  ✅ ${needle}`);
  else { console.log(`  ❌ ${needle} — 부르는 화면이 없습니다: ${harm}`); fail++; }
}
console.log(fail
  ? "\n서버에 있다고 쓸 수 있는 것이 아닙니다 — 닿는 길이 있어야 기능입니다."
  : "\n모두 닿습니다.");
process.exit(fail ? 1 : 0);
