/**
 * 플러그인을 끄면 등록한 것이 **전부** 걷혀야 한다.
 *
 * 플러그인 로더는 레지스트리를 열몇 개 들고 있다(라우트·블록·관리 메뉴·관리 리소스·
 * 대시보드 카드·헤더 링크·선언 화면·검색·사이트맵·훅·서비스·번역 카탈로그 …).
 * 새 레지스트리를 더할 때마다 `deactivate` 에도 정리를 넣어야 하는데, 그것을 잊으면
 * **꺼진 플러그인의 흔적이 남는다** — 실제로 `registerScreen` 을 더하면서 잊었고,
 * 그러면 꺼진 플러그인의 경로가 계속 매칭되지만 그릴 블록은 없다: 손님은 404 대신
 * 깨진 화면을 본다. 재적재(reload)는 deactivate 뒤 activate 를 부르므로 항목이
 * 두 벌씩 쌓이기도 한다.
 *
 * 이 검사는 "레지스트리 필드 이름이 deactivate 본문에 나오는가"를 본다. 정리 방식
 * (splice·delete)까지는 보지 않는다 — 이름이 등장하면 저자가 그 레지스트리를
 * 생각했다는 뜻이고, 잊었는지 여부가 이 검사가 답할 수 있는 질문이다.
 *
 * 사용법: node scripts/check-plugin-cleanup.mjs
 */
import { readFileSync } from "node:fs";

const FILE = "apps/api/src/modules/plugins/plugin-loader.service.ts";
const src = readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");

/** `readonly x: Array<…>` 또는 `readonly x = new Map(…)` 로 선언된 레지스트리 */
const registries = [...src.matchAll(/readonly (\w+)\s*[:=]\s*(?:Array<|new Map)/g)].map((m) => m[1]);

const start = src.indexOf("async deactivate(");
if (start < 0) {
  console.log("❌ deactivate 를 찾지 못했습니다 — 이 검사를 고쳐야 합니다");
  process.exit(1);
}
/** deactivate 본문 — 다음 섹션 주석까지 (파일이 그렇게 구획되어 있다) */
const end = src.indexOf("// ── 다국어", start);
const body = src.slice(start, end > start ? end : src.length);

console.log("▶ 플러그인을 끄면 등록한 것이 전부 걷힌다");
console.log(`  레지스트리 ${registries.length}개`);

const missing = registries.filter((name) => !body.includes(name));
for (const name of registries) {
  console.log(`  ${missing.includes(name) ? "❌" : "✅"} ${name}`);
}

if (missing.length) {
  console.log(`\n${FILE} 의 deactivate 에서 ${missing.join(", ")} 를 걷어내지 않습니다.`);
  process.exit(1);
}
console.log("\n전부 걷힙니다.");
