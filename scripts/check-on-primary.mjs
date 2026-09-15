#!/usr/bin/env node
/*
 * primary 면 위의 글자색은 **테마가 정한 것**을 쓴다.
 *
 * `--color-primary` 는 "칠하는 색" 이고, 그 위에 올릴 글자색은 테마가
 * `--color-on-primary` 로 따로 선언한다. primary 가 어두운 팔레트에서는 흰 글자가
 * 맞지만, **밝은 palette 에서는 흰 글자가 사라진다** — storefront 테마의 다크
 * 팔레트가 정확히 그렇다(primary #f2f3f6 · on-primary #14161b).
 *
 * 실제로 관리 화면이 `color: #fff` 로 박아 두고 있었고, 다크로 보는 운영자에게는
 * **모든 저장 버튼이 빈 칸**이었다. 테마는 그 경우를 대비해 값을 같이 선언해
 * 두는데 아무도 읽지 않았다.
 *
 * 그래서 이 검사는 본다: `background` 로 `--color-primary` 를 칠하는 규칙이
 * 글자색을 정한다면, 그 값은 리터럴이 아니라 `--color-on-primary` 여야 한다.
 * (글자색을 아예 정하지 않는 규칙은 보지 않는다 — hover 처럼 배경만 다시 칠하는
 * 규칙이 그렇고, 색은 위 규칙에서 이미 왔다.)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    // 빌드 산출물(assets/style.css)은 보지 않는다 — 원본(src)이 사실이다
    else if (/\.(css|tsx?)$/.test(name) && !p.includes("/assets/")) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, "apps/web/src")), ...walk(join(ROOT, "themes"))];

/** `{ … }` 한 덩어리를 읽는다 — CSS-in-JS 문자열 안이라도 모양은 같다 */
const RULE = /\{([^{}]*)\}/g;

let fail = 0;
console.log("▶ primary 면 위의 글자색은 테마가 정한다");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(RULE)) {
    const body = m[1];
    if (!/background(-color)?\s*:\s*var\(--color-primary\s*[,)]/.test(body)) continue;
    const color = /(^|;|\s)color\s*:\s*([^;}]+)/.exec(body);
    if (!color) continue; // 배경만 다시 칠하는 규칙
    if (/var\(--color-on-primary/.test(color[2])) continue;
    const line = text.slice(0, m.index).split("\n").length;
    console.log(
      `  ❌ ${file.replace(ROOT, "")}:${line} — primary 면에 글자색을 박았습니다: ${color[2].trim()}`,
    );
    fail++;
  }
}
console.log(fail
  ? "\n밝은 primary 팔레트에서는 그 글자가 사라집니다 — var(--color-on-primary) 를 쓰세요."
  : "\n모두 테마의 색을 씁니다.");
process.exit(fail ? 1 : 0);
