#!/usr/bin/env node
/*
 * 테마 토큰 계약 (packages/core/src/theme-tokens.ts) 이 지켜지는가.
 *
 * 왜 필요했나: 토큰은 테마의 brick.theme.json 에서만 왔다. 남이 만든 테마가 하나를 빠뜨리면
 * 그 변수를 쓰는 확장 화면이 각자 적어 둔 폴백으로 그려졌는데, 같은 `--color-muted` 의 폴백이
 * 다섯 가지였다(#999 는 흰 바탕에서 대비 기준 미달). 이제 렌더가 빠진 토큰을 코어 기본값으로 채운다.
 * 이 검사는 그 약속의 세 귀퉁이를 잡는다:
 *
 *   1. 동봉 테마는 계약 토큰을 **전부 스스로** 정한다 — 코어 기본값에 기대면 그 테마의 인상이
 *      기본 테마 색으로 조용히 섞인다. 다크 팔레트를 주는 테마는 다크도 전부.
 *   2. 코어 기본값 = 동봉 기본 테마(themes/default)의 값 — 기본 테마의 팔레트를 고치고 코어를
 *      잊으면, 빠진 토큰만 옛 색으로 나온다.
 *   3. 확장·코어 블록이 쓰는 **토큰 모양의 이름**(color-·radius·shadow-·font-·content-width)은 계약에
 *      있다 — `var(--color-bg-muted, #f6f6f9)` 처럼 폴백을 달면 오타가 영영 드러나지 않는다(폴백만 그려진다).
 *      자기 이름(`--brick-…`, `--promo-cols` 등)은 대상이 아니다.
 *   4. 확장이 붙이는(sticky) 것의 top 은 `--brick-sticky-top` 을 쓴다 — 테마가 붙여 둔 머리 띠 밑에 깔리지 않게.
 *
 * 사용법: node scripts/check-theme-contract.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

function readContract() {
  const src = readFileSync(join(ROOT, "packages/core/src/theme-tokens.ts"), "utf8");
  const block = (name) => {
    const m = src.match(new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
    if (!m) throw new Error(`${name} 를 읽지 못했습니다`);
    return Object.fromEntries([...m[1].matchAll(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*"),\s*$/gm)].map((x) => [x[1], JSON.parse(x[2])]));
  };
  return { light: block("THEME_TOKENS"), dark: block("THEME_DARK_TOKENS") };
}

const { light, dark } = readContract();
console.log(`▶ 테마 토큰 계약 — 라이트 ${Object.keys(light).length} · 다크 ${Object.keys(dark).length}`);
if (Object.keys(light).length < 10) bad("계약을 읽지 못했다 (토큰이 너무 적다)");

// 1·2 — 동봉 테마
const themesDir = join(ROOT, "themes");
for (const name of readdirSync(themesDir).sort()) {
  const mf = join(themesDir, name, "brick.theme.json");
  if (!existsSync(mf)) continue;
  const tokens = JSON.parse(readFileSync(mf, "utf8")).tokens ?? {};
  const missing = Object.keys(light).filter((k) => !(k in tokens));
  const hasDark = Object.keys(tokens).some((k) => k.startsWith("dark-"));
  const missingDark = hasDark ? Object.keys(dark).filter((k) => !(`dark-${k}` in tokens)) : [];
  if (missing.length || missingDark.length) {
    bad(`${name}: 계약 토큰을 스스로 정하지 않았다 — ${[...missing, ...missingDark.map((k) => `dark-${k}`)].join(", ")}`);
  } else ok(`${name}: 계약 토큰 전부${hasDark ? " (다크 포함)" : ""}`);
  if (name === "default") {
    const diff = [
      ...Object.entries(light).filter(([k, v]) => tokens[k] !== v).map(([k]) => k),
      ...Object.entries(dark).filter(([k, v]) => tokens[`dark-${k}`] !== v).map(([k]) => `dark-${k}`),
    ];
    diff.length ? bad(`코어 기본값이 기본 테마와 다르다 — ${diff.join(", ")}`) : ok("코어 기본값 = 기본 테마의 값");
  }
}

// 3 — 확장·코어 블록이 쓰는 토큰 이름
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = [
  ...readdirSync(join(ROOT, "plugins")).flatMap((p) => walk(join(ROOT, "plugins", p, "src"))),
  ...walk(join(ROOT, "apps/api/src/modules/pages")),
];
const TOKEN_LIKE = /^(color-|radius|shadow-|font-|content-width)/;
// 계약 밖이지만 테마가 선택적으로 주는 토큰 — 쓸 때는 반드시 폴백을 단다
const OPTIONAL = new Set(["font-display"]);
const unknown = [];
let used = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/var\(\s*--([A-Za-z0-9_-]+)\s*([,)])/g)) {
    const name = m[1];
    if (!TOKEN_LIKE.test(name)) continue;
    used++;
    if (name in light) continue;
    if (OPTIONAL.has(name) && m[2] === ",") continue;
    unknown.push(`${f.slice(ROOT.length)}: --${name}${OPTIONAL.has(name) ? " (선택 토큰은 폴백이 필요하다)" : ""}`);
  }
}
if (used < 100) bad(`토큰 사용을 거의 찾지 못했다 (${used}) — 검사가 헛돈다`);

/*
 * 4 — 확장이 붙이는(sticky) 것은 테마가 머리에 붙여 둔 띠 아래에 붙는다.
 * 넓은 화면에서 쇼핑몰 테마는 카테고리 띠(58px)를 화면 위에 붙이고 그 높이를 --brick-sticky-top 으로 알린다.
 * 주문서의 합계 상자가 top:16px 로 붙어 있어 띠 밑에 깔렸다 — 상품 상세의 바로가기 막대도 같은 일을 겪었다.
 */
const stickyBad = [];
let stickyCount = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/position\s*:\s*sticky[^}]*/g)) {
    stickyCount++;
    const top = m[0].match(/(?:^|[;{\s])top\s*:\s*([^;}]*)/);
    if (!top || !top[1].includes("--brick-sticky-top")) {
      stickyBad.push(`${f.slice(ROOT.length)}: ${m[0].slice(0, 70)}`);
    }
  }
}
stickyBad.length
  ? stickyBad.forEach((u) => bad(`붙는 요소의 top 이 테마의 붙은 띠를 모른다 — ${u}`))
  : ok(`확장·코어 블록의 붙는 요소 ${stickyCount}곳이 모두 --brick-sticky-top 아래`);
if (stickyCount < 2) bad(`붙는 요소를 거의 찾지 못했다 (${stickyCount}) — 검사가 헛돈다`);
unknown.length
  ? unknown.slice(0, 20).forEach((u) => bad(`계약에 없는 토큰 ${u}`))
  : ok(`확장·코어 블록의 토큰 사용 ${used}곳이 모두 계약 안`);

console.log(fail ? `\n${fail}개 실패` : "\n통과");
process.exit(fail ? 1 : 0);
