#!/usr/bin/env node
/*
 * 보관 정책이 **실제로 실행되는가**.
 *
 * 왜 필요했나: 서비스마다 자기 데이터를 치우는 함수가 있고 주석에는 하나같이
 * "유지보수 작업이 부른다", "스케줄러가 부른다" 라고 적혀 있었다. 그런데 부르는
 * 곳이 없었다 — 넷 중 둘은 아무도 지우지 않았고, 나머지 둘은 MaintenanceService
 * 가 같은 일을 자기 손으로 다시 구현하고 있었다(정책이 두 곳에 적혀 갈라진다).
 *
 * 400일 된 행을 심고 서버를 띄웠더니 검색어("희귀질환 치료")와 이메일 인증
 * 토큰이 그대로 남았다. 검색어는 스스로 "질병·법률 문의라 민감하다"고 적어 둔
 * 데이터다. 테이블은 무한히 커지고, 문서에만 있는 보관 기간은 지켜지지 않는다.
 *
 * 이 검사는 두 가지를 본다:
 *   1. 정리 함수(prune·purge*·sweep*)에 **자기 파일 밖의 호출자**가 있는가
 *   2. 유지보수가 그중 어느 것도 빠뜨리지 않았는가 (sweep 안에서 전부 불리는가)
 *
 * 새 테이블에 보관 정책을 만들면 여기에 자동으로 걸린다 — 부르는 곳을 만들거나,
 * 애초에 정리 함수를 두지 말아야 한다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SWEEPER = "apps/api/src/modules/maintenance/maintenance.service.ts";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "apps/api/src"));
const sweeper = readFileSync(join(ROOT, SWEEPER), "utf8");
/*
 * sweep() 본문만 본다 — import 나 필드 선언에 이름이 스쳐 지나가는 것으로는
 * "실제로 부른다"가 성립하지 않는다. 중괄호를 세어 본문 끝을 찾는다.
 */
const sweepBody = (() => {
  const i = sweeper.indexOf("async sweep(");
  if (i < 0) return "";
  let depth = 0, start = sweeper.indexOf("{", i);
  for (let j = start; j < sweeper.length; j++) {
    if (sweeper[j] === "{") depth++;
    else if (sweeper[j] === "}" && --depth === 0) return sweeper.slice(start, j);
  }
  return "";
})();

let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

console.log("▶ 보관 정책이 실제로 실행된다");

/*
 * 이름만으로 대조하면 안 된다.
 *
 * 정리 함수 셋이 나란히 `prune` 이다(감사·재설정·검색). 처음 쓴 검사는 sweep
 * 본문에 `.prune(` 이 있는지만 봤고, 그래서 **검색 로그 정리를 통째로 지워도
 * 통과했다** — 다른 두 `.prune(` 이 남아 있었기 때문이다. 역검증에서 걸렸다.
 *
 * 그래서 클래스로 대조한다: sweep 이 부르는 `this.<필드>.<메서드>()` 의 필드를
 * 생성자 선언에서 타입(클래스명)으로 바꾼 뒤, 정리 함수가 정의된 클래스와 맞춘다.
 */
const className = (src) => (src.match(/export class (\w+)/) || [])[1] ?? "";

/*
 * 인터페이스로 주입받는 것도 따라간다. 큐처럼 `@Inject(QUEUE) queue: QueueProvider` 로
 * 받으면 필드의 타입은 인터페이스이고 정리 함수는 구현 클래스(PostgresQueueProvider)에
 * 있다 — 이름이 달라 "아무도 부르지 않는다" 로 잘못 읽었다(실제로는 부르고 있었다).
 * `class X implements I` 를 모아 I → X 로 푼다.
 */
const implementers = new Map(); // 인터페이스 → [구현 클래스]
const interfacesOf = new Map(); // 구현 클래스 → [인터페이스]
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/export class (\w+)[^{]*?implements ([\w\s,]+)\{/g)) {
    for (const iface of m[2].split(",").map((x) => x.trim()).filter(Boolean)) {
      implementers.set(iface, [...(implementers.get(iface) ?? []), m[1]]);
      interfacesOf.set(m[1], [...(interfacesOf.get(m[1]) ?? []), iface]);
    }
  }
}

// MaintenanceService 생성자의 `private readonly search: SearchService` → search=SearchService
const fieldType = new Map();
for (const m of sweeper.matchAll(/private readonly (\w+):\s*(\w+)/g)) fieldType.set(m[1], m[2]);
// sweep 본문에서 실제로 불린 (클래스, 메서드) 쌍
const swept = new Set();
for (const m of sweepBody.matchAll(/this\.(\w+)\.(\w+)\(/g)) {
  const cls = fieldType.get(m[1]);
  if (!cls) continue;
  for (const c of [cls, ...(implementers.get(cls) ?? [])]) swept.add(`${c}#${m[2]}`);
}

const cleaners = [];
for (const f of files) {
  if (f.endsWith(SWEEPER.split("/").pop())) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/^\s{2}async (prune|purge[A-Za-z]*|sweep[A-Za-z]*)\(/gm)) {
    cleaners.push({ file: f.slice(ROOT.length), name: m[1], cls: className(src) });
  }
}

if (!cleaners.length) bad("정리 함수를 하나도 찾지 못했습니다 (검사가 고장났을 수 있습니다)");

for (const c of cleaners) {
  // 자기 파일 밖에서 부르는 곳 — 그 클래스를 실제로 들여온 파일만 센다
  const callers = files.filter((f) => {
    if (f.slice(ROOT.length) === c.file) return false;
    const src = readFileSync(f, "utf8");
    const names = [c.cls, ...(interfacesOf.get(c.cls) ?? [])];
    return names.some((n) => src.includes(n)) && new RegExp(`\\.${c.name}\\(`).test(src);
  });
  if (callers.length) ok(`${c.cls}#${c.name} — ${callers.length}곳에서 부른다`);
  else bad(`${c.cls}#${c.name} (${c.file}) — **아무도 부르지 않습니다**. 테이블이 무한히 커지고 보관 기간은 문서에만 남습니다`);

  if (swept.has(`${c.cls}#${c.name}`)) ok(`  주기 정리가 ${c.cls}#${c.name} 을 부른다`);
  else bad(`  주기 정리(sweep)가 ${c.cls}#${c.name} 을 빠뜨렸습니다`);
}

console.log(fail ? "\n치우겠다고 써 놓고 치우지 않으면 아무도 모릅니다." : "\n모두 실행됩니다.");
process.exit(fail ? 1 : 0);
