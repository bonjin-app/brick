/**
 * 설정 API 가 있는 플러그인에는 설정 **화면**도 있는지 확인한다.
 *
 * 왜 필요한가: 쇼핑몰·1:1 문의·사이트 셋 다 `PUT /admin/settings` 는 처음부터
 * 있었지만 그것을 부르는 화면이 없었다. 운영자는 배송비와 **무통장 입금 계좌**를
 * 화면에서 바꿀 수 없었고 — 계좌가 비면 손님은 어디로 입금할지 모른다 — 고치려면
 * curl 을 써야 했다. 회원가입 캡차와 같은 종류의 구멍이다(서버는 되는데 화면이 없다).
 *
 * 화면은 `registerAdminResource` 에 `kind: "settings"` 를 선언하면 코어가 그려준다.
 *
 * 사용법: node scripts/check-settings-screens.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 설정을 저장하는 라우트 — 경로 이름은 플러그인마다 조금씩 다르다 */
const SAVES_SETTINGS = /registerRoute\(\s*"PUT",\s*"\/admin\/(settings|config)"/;
/** 그 값을 편집하는 화면 선언 */
const HAS_SCREEN = /kind:\s*"settings"/;
/**
 * 예전 우회로 — 한 행짜리 목록으로 설정 화면을 흉내낸다.
 *
 * 셋(pay-toss·포인트·쪽지)이 이렇게 하고 있었고, 계약이 생긴 뒤 전부 옮겼다.
 * 다시 나타나면 막는다: 포인트에서는 같은 검증 로직이 두 벌로 갈라져 한쪽은
 * 빠진 값을 기본값으로 되돌리고 다른 쪽은 유지하고 있었다.
 */
const OLD_WORKAROUND =
  /(?:registerRoute\(\s*"(?:GET|PUT)",\s*|basePath:\s*)"\/admin\/(?:config|settings)-list/;

let fail = 0;
console.log("▶ 설정 API 가 있으면 설정 화면도 있다");

for (const name of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", name, "src");
  try {
    if (!statSync(dir).isDirectory()) continue;
  } catch { continue; }

  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8"));
  const all = files.join("\n");
  if (!SAVES_SETTINGS.test(all)) continue;

  if (OLD_WORKAROUND.test(all)) {
    console.log(`  ❌ ${name}: 한 행짜리 목록으로 설정 화면을 대신하고 있습니다 — kind: "settings" 를 쓰세요`);
    fail++;
  } else if (HAS_SCREEN.test(all)) {
    console.log(`  ✅ ${name}: 설정 API + 설정 화면`);
  } else {
    console.log(`  ❌ ${name}: 설정을 저장하는 API 는 있는데 그것을 부르는 화면이 없습니다`);
    fail++;
  }
}

if (fail > 0) {
  console.log('\nregisterAdminResource 에 kind: "settings" 를 선언하면 코어가 화면을 그려줍니다.');
  process.exit(1);
}
console.log("\n모두 화면이 있습니다.");
