#!/usr/bin/env node
/*
 * 광고 메일이 **메일 앱에게** 수신거부 방법을 말하는가.
 *
 * 본문에 수신거부 링크를 넣는 것은 정보통신망법이 요구하는 최소이고, 이미
 * 하고 있었다. 그런데 Gmail·Apple Mail·네이버가 메일 위에 **"수신거부" 버튼**을
 * 띄우는 근거는 본문이 아니라 `List-Unsubscribe` 헤더다. 그 헤더가 없었다.
 *
 * 버튼이 없으면 사람들은 대신 **"스팸 신고"** 를 누른다. 그것이 쌓이면 발신
 * 도메인의 평판이 떨어지고, 그러면 광고만이 아니라 **입금 계좌가 담긴 주문
 * 안내**까지 스팸함으로 간다. 작은 쇼핑몰에게는 그쪽이 훨씬 큰 피해다.
 *
 * 이 검사가 보는 것은 규격 준수가 아니라 **짝이 맞는가** 이다:
 *   1. List-Unsubscribe 를 붙이는 곳이 있는가
 *   2. One-Click(RFC 8058)을 선언했다면 그 주소가 **POST 를 받는가**
 *      — 선언만 하고 받지 않으면 버튼이 실패해서 없느니만 못하다
 *   3. 헤더를 실어 보낼 통로가 계약과 구현에 다 있는가
 *      (계약에만 있고 SMTP 구현이 버리면 로컬에서는 보이고 실제로는 사라진다)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

console.log("▶ 광고 메일이 메일 앱에게 수신거부 방법을 말한다");

// 1) 헤더를 붙이는 곳
const sources = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) sources.push(p);
  }
}
walk(join(ROOT, "apps/api/src"));
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try { if (statSync(dir).isDirectory()) walk(dir); } catch { /* 없으면 건너뛴다 */ }
}

const setters = sources.filter((f) => /["']List-Unsubscribe["']/.test(readFileSync(f, "utf8")));
if (setters.length) ok(`List-Unsubscribe 를 붙이는 곳: ${setters.length}군데`);
else bad("List-Unsubscribe 를 붙이는 곳이 없습니다 — 메일 앱이 수신거부 버튼을 띄우지 못합니다");

// 2) One-Click 을 선언했다면 그 주소가 POST 를 받아야 한다
const declaresOneClick = setters.some((f) => /List-Unsubscribe=One-Click/.test(readFileSync(f, "utf8")));
if (declaresOneClick) {
  // 헤더가 가리키는 경로를 찾아, 같은 경로의 @Post 핸들러가 있는지 본다
  const paths = new Set();
  for (const f of setters) {
    for (const m of readFileSync(f, "utf8").matchAll(/\/api\/([a-z0-9/-]*unsubscribe)/g)) paths.add(m[1]);
  }
  if (!paths.size) bad("One-Click 을 선언했는데 헤더가 가리키는 경로를 찾지 못했습니다");
  for (const path of paths) {
    const served = sources.some((f) => new RegExp(`@Post\\(["']${path}["']\\)`).test(readFileSync(f, "utf8")));
    if (served) ok(`One-Click 주소가 POST 를 받는다 (${path})`);
    else bad(`One-Click 을 선언했는데 ${path} 가 POST 를 받지 않습니다 — 메일 앱의 버튼이 실패합니다`);
  }
} else {
  bad("One-Click(RFC 8058)을 선언하지 않았습니다 — Gmail 은 이것이 있어야 버튼을 띄웁니다");
}

// 3) 헤더가 실제로 실려 나가는 통로
const contract = read("packages/core/src/providers/mail.ts");
if (/headers\?:/.test(contract)) ok("메일 계약에 headers 가 있다");
else bad("메일 계약(MailMessage)에 headers 가 없습니다 — 붙여도 전달되지 않습니다");

const smtp = read("apps/api/src/providers/smtp-mail.provider.ts");
if (/message\.headers/.test(smtp)) ok("SMTP 구현이 headers 를 실어 보낸다");
else bad("SMTP 구현이 message.headers 를 버립니다 — 로그에는 보이고 실제 메일에는 없습니다");

console.log(fail
  ? "\n버튼이 없으면 손님은 대신 스팸 신고를 누릅니다 — 그 뒤엔 주문 안내도 스팸함으로 갑니다."
  : "\n짝이 맞습니다.");
process.exit(fail ? 1 : 0);
