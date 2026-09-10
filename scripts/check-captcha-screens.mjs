/**
 * 캡차를 요구하는 서버와 그것을 그리는 화면이 짝을 이루는지 확인한다.
 *
 * 왜 필요한가: 서버가 캡차를 검증하는데 화면에 입력 칸이 없으면 **아무도 그 폼을
 * 낼 수 없다**. 회원가입이 정확히 그 상태로 오래 있었다 — 발급 API 도 컨트롤러도
 * 완비되어 있었지만 가입 화면에 칸이 없었고, 스모크가 전부 캡차를 끄고 돌아
 * 아무도 보지 못했다. 반대 방향도 본다: 칸만 있고 서버가 검증하지 않으면 그 칸은
 * 손님만 귀찮게 하는 장식이다.
 *
 * 짝의 단위는 "패키지"다. 코어는 서버(apps/api)와 화면(apps/web)이 한 짝이고,
 * 플러그인은 자기 안에서 서버와 화면을 모두 들고 있다.
 *
 * 사용법: node scripts/check-captcha-screens.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 서버가 캡차를 검증하는가 */
const VERIFIES = /\bcaptcha\.verify\s*\(/;
/** 화면이 캡차를 그리는가 — 공용 위젯이거나, 직접 발급 API 를 부르거나 */
const RENDERS = /captchaFieldHtml|CAPTCHA_WIDGET_JS|["'`]\/api\/captcha/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** 검사 단위: [이름, 서버 디렉터리들, 화면 디렉터리들] */
const UNITS = [["코어", ["apps/api/src"], ["apps/web/src"]]];
for (const name of readdirSync(join(ROOT, "plugins"))) {
  const src = join("plugins", name, "src");
  try {
    if (statSync(join(ROOT, src)).isDirectory()) UNITS.push([name, [src], [src]]);
  } catch { /* src 없는 항목은 건너뛴다 */ }
}

let fail = 0;
console.log("▶ 캡차: 서버가 요구하는 것을 화면이 주는가");

for (const [name, serverDirs, screenDirs] of UNITS) {
  const read = (dirs) =>
    dirs.flatMap((d) => walk(join(ROOT, d))).map((f) => [f, readFileSync(f, "utf8")]);

  const server = read(serverDirs).filter(([, src]) => VERIFIES.test(src));
  const screen = read(screenDirs).filter(([, src]) => RENDERS.test(src));

  if (server.length === 0 && screen.length === 0) continue;

  const rel = (f) => f.slice(ROOT.length);
  if (server.length > 0 && screen.length === 0) {
    console.log(`  ❌ ${name}: 서버가 캡차를 검증하는데(${server.map(([f]) => rel(f)).join(", ")}) 화면에 칸이 없습니다`);
    fail++;
  } else if (screen.length > 0 && server.length === 0) {
    console.log(`  ❌ ${name}: 화면이 캡차를 그리는데(${screen.map(([f]) => rel(f)).join(", ")}) 서버가 검증하지 않습니다`);
    fail++;
  } else {
    console.log(`  ✅ ${name}: 서버 ${server.length}곳 · 화면 ${screen.length}곳`);
  }
}

if (fail > 0) {
  console.log(`\n${fail}개 짝이 어긋났습니다.`);
  process.exit(1);
}
console.log("\n모든 짝이 맞습니다.");
