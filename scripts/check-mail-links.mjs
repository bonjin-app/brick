#!/usr/bin/env node
/*
 * 플러그인이 **메일로 보내는 링크**에 화면이 있는가.
 *
 * 코어에는 같은 검사가 있었다(워크플로의 "메일이 보내는 링크에 화면이 있다").
 * 플러그인은 보지 않았고, 그래서 재입고 알림의 **해지 링크가 죽어 있었다** —
 * 메일은 "신청하지 않으셨다면 아래 링크를 눌러 알림을 해지해주세요" 라며
 * `/shop/restock/cancel/<토큰>` 을 보내는데, 스토어프론트에 그 경로를 받는 자리가
 * 없어서 "상품을 찾을 수 없습니다" 가 떴다. 끊을 수 없는 알림이었다.
 *
 * 판정: 링크의 **고정 구간**이 화면에 닿는가.
 *   - 첫 구간(`shop`)은 `registerScreen({ path: "shop" })` 이 받는다.
 *   - 둘째 구간이 고정 문자열이면(`restock`·`orders`) 그 자리를 누가 받아야 한다:
 *     `registerScreen({ path: "shop/restock" })` 이거나, 라우터 블록의
 *     `seg[0] === "restock"` 분기다. 둘 다 없으면 상품 slug 로 해석되어
 *     "상품을 찾을 수 없습니다" 가 된다 — 정확히 겪은 일이다.
 *   - `${...}` 로 시작하는 구간(상품 slug·주문번호)은 보지 않는다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** `${...siteUrl...}` 뒤에 오는 경로를 뽑는다 */
const LINK = /\$\{[^}]*siteUrl[^}]*\}((?:\/[^/`"'${\s)]*|\/\$\{[^}]*\})+)/g;

/*
 * 주소를 **지역 변수에 담아 쓰는** 경우도 따라간다.
 *
 *   const base = port.siteUrl.replace(/\/$/, "");
 *   `${base}/shop/orders/...`
 *
 * 주문 메일이 그렇게 쓴다. `siteUrl` 만 찾으면 그 링크를 통째로 놓치는데,
 * 비회원에게는 그 링크가 **주문을 볼 유일한 수단**이다.
 */
const ALIAS = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*siteUrl/g;

let fail = 0;
let checked = 0;
console.log("▶ 플러그인이 메일로 보내는 링크에 화면이 있다");

for (const plugin of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", plugin, "src");
  let files;
  try { if (!statSync(dir).isDirectory()) continue; files = walk(dir); } catch { continue; }
  const sources = files.map((f) => readFileSync(f, "utf8"));
  const all = sources.join("\n");

  const links = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(LINK)) links.add(m[1]);
    for (const a of src.matchAll(ALIAS)) {
      const re = new RegExp(
        `\\$\\{${a[1]}\\}((?:\\/[^/\`"'\${\\s)]*|\\/\\$\\{[^}]*\\})+)`,
        "g",
      );
      for (const m of src.matchAll(re)) links.add(m[1]);
    }
  }

  for (const link of links) {
    // 고정 구간만 남긴다 — `${...}` 가 나오면 거기서 멈춘다
    const segs = [];
    for (const raw of link.split("/").filter(Boolean)) {
      if (raw.startsWith("${")) break;
      segs.push(raw);
    }
    if (!segs.length) continue;
    checked++;

    const base = segs[0];
    const hasBase =
      new RegExp(`path:\\s*"${base}"`).test(all) || new RegExp(`path:\\s*"${base}/`).test(all);
    if (!hasBase) {
      console.log(`  ❌ ${plugin}: ${link} — "${base}" 를 받는 화면 선언이 없습니다`);
      fail++;
      continue;
    }
    if (segs.length < 2) { console.log(`  ✅ ${plugin}: ${link}`); continue; }

    const sub = segs[1];
    const handled =
      new RegExp(`path:\\s*"${base}/${sub}"`).test(all) ||
      new RegExp(`seg\\[0\\]\\s*===\\s*"${sub}"`).test(all);
    if (handled) console.log(`  ✅ ${plugin}: ${link}`);
    else {
      console.log(
        `  ❌ ${plugin}: ${link} — "${sub}" 를 받는 자리가 없습니다 ` +
          `(선언 화면도, 라우터 분기도 없으면 상품 slug 로 해석됩니다)`,
      );
      fail++;
    }
  }
}

if (!checked) {
  console.log("  ❌ 검사 대상을 하나도 찾지 못했습니다 — 링크를 뽑는 정규식을 확인하세요");
  fail++;
}
console.log(fail
  ? "\n메일이 보내는 링크가 죽어 있으면, 받는 사람은 고칠 방법이 없습니다."
  : `\n메일 링크 ${checked}개가 모두 화면에 닿습니다.`);
process.exit(fail ? 1 : 0);
