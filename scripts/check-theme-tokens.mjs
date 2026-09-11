/**
 * 플러그인·테마 CSS 가 참조하는 토큰이 **실제로 정의되어 있는지** 확인한다.
 *
 * 왜 필요한가: `var(--brick-accent, #0a7)` 처럼 쓰면 그 토큰이 없어도 화면은 그려진다 —
 * 늘 폴백이 쓰이고, 아무 경고도 나지 않는다. 그러면 **테마가 그 색을 통제할 수 없다.**
 * 실제로 `--brick-accent` 는 다섯 테마 중 어느 것도 정의하지 않는 이름이었고, 쿠폰함의
 * "사용 가능" 과 재입고 안내가 늘 `#0a7` 로 그려졌다 — 라이트 배경에서 대비 2.99:1
 * (작은 글자 기준 4.5 미달)이고, 테마를 바꿔도 그 색만 그대로였다.
 *
 * 정의로 인정하는 것:
 *   - 테마의 `brick.theme.json` tokens (light 키와 dark- 접두 키)
 *   - 테마 CSS 의 `--name:` 선언 (레이아웃 변수는 CSS 에만 있다)
 *   - 코어가 내려보내는 토큰 CSS (`/api/themes/tokens.css` 생성부)
 *
 * 사용법: node scripts/check-theme-tokens.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** ── 정의된 토큰 모으기 ─────────────────────────── */
const defined = new Set();
const themes = readdirSync(join(ROOT, "themes")).filter((d) => {
  try { return statSync(join(ROOT, "themes", d)).isDirectory(); } catch { return false; }
});
for (const t of themes) {
  try {
    const json = JSON.parse(read(join("themes", t, "brick.theme.json")));
    for (const key of Object.keys(json.tokens ?? {})) {
      defined.add(`--${key.replace(/^dark-/, "")}`);
    }
  } catch { /* 토큰이 없는 테마도 있다 */ }
  for (const dir of ["src", "assets"]) {
    let files = [];
    try { files = readdirSync(join(ROOT, "themes", t, dir)).filter((f) => f.endsWith(".css")); } catch { continue; }
    for (const f of files) {
      for (const m of read(join("themes", t, dir, f)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
    }
  }
}
/*
 * **인라인으로 넣는 지역 변수도 정의**로 본다.
 *
 * 블록은 `style="--brick-cols:4"` 처럼 인스턴스별 값을 인라인으로 넣는다 — 테마
 * 토큰이 아니라 그 블록의 매개변수다. 그것까지 "정의하는 테마가 없다"고 하면 검사가
 * 소음이 되고, 소음이 되면 아무도 보지 않는다. 그래서 코어·플러그인·테마 어디서든
 * `--name:` 으로 값을 넣는 것을 정의로 인정한다.
 */
const DEFINE_SOURCES = [
  "apps/api/src/modules/themes/themes.service.ts",
  "apps/api/src/modules/pages/core-blocks.service.ts",
  "apps/web/src/app/layout.tsx",
];
for (const f of DEFINE_SOURCES) {
  try {
    for (const m of read(f).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  } catch { /* 파일 구성이 바뀌었으면 건너뛴다 */ }
}
for (const plug of readdirSync(join(ROOT, "plugins"))) {
  const dir = join("plugins", plug, "src");
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")); } catch { continue; }
  for (const f of files) {
    for (const m of read(join(dir, f)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  }
}
for (const t of themes) {
  let files = [];
  try { files = readdirSync(join(ROOT, "themes", t, "templates")).filter((f) => f.endsWith(".html")); } catch { continue; }
  for (const f of files) {
    for (const m of read(join("themes", t, "templates", f)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  }
}

/** ── 참조하는 토큰 모으기 ─────────────────────────── */
const refs = new Map(); // 토큰 → [어디]
const scan = (label, text) => {
  // `var(--color-${kind})` 처럼 이름을 만들어 쓰는 경우는 정적으로 알 수 없다 —
  // 하이픈으로 끝나는 조각이 그 흔적이므로 건너뛴다
  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]*[a-z0-9])(?![a-z0-9-])/gi)) {
    if (!refs.has(m[1])) refs.set(m[1], new Set());
    refs.get(m[1]).add(label);
  }
};
for (const plug of readdirSync(join(ROOT, "plugins"))) {
  const dir = join("plugins", plug, "src");
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")); } catch { continue; }
  for (const f of files) scan(`${plug}/${f}`, read(join(dir, f)));
}
for (const t of themes) {
  for (const dir of ["src"]) {
    let files = [];
    try { files = readdirSync(join(ROOT, "themes", t, dir)).filter((f) => f.endsWith(".css")); } catch { continue; }
    for (const f of files) scan(`themes/${t}/${f}`, read(join("themes", t, dir, f)));
  }
}

console.log("▶ 참조하는 토큰이 정의되어 있다");
console.log(`  정의 ${defined.size}개 · 참조 ${refs.size}개 (테마 ${themes.length}벌)`);

const missing = [...refs.entries()].filter(([name]) => !defined.has(name));
if (!missing.length) {
  console.log("\n모든 참조가 정의되어 있습니다.");
  process.exit(0);
}
for (const [name, where] of missing) {
  console.log(`  ❌ ${name} — 정의하는 테마가 없습니다 (${[...where].slice(0, 3).join(", ")})`);
}
console.log(
  "\n폴백이 늘 쓰이므로 화면은 그려지지만, 테마가 그 값을 바꿀 수 없습니다." +
  "\n테마가 주는 이름으로 바꾸거나, 다섯 테마에 그 토큰을 추가하세요.",
);
process.exit(1);
