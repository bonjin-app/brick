/**
 * 메일을 유발하는 공개 경로는 스스로를 지키는가.
 *
 * 확인 절차 없이 **아무 주소나** 받아 메일을 보내는 경로는 발사대가 된다.
 * 남의 주소를 적어 반복하면 그 사람에게 메일이 쏟아지고, 보내는 도메인은
 * 스팸으로 신고되어 **진짜 안내 메일까지 스팸함으로 간다.**
 *
 * 이 저장소에서 세 번 나왔다:
 *   - 재입고 알림 — 60번 시도해 60건 등록, 재입고 순간 전부 발송
 *   - 1:1 문의 — 문의 한 건마다 운영자에게 메일
 *   - 비회원 주문 — 10번 주문해 임의 주소로 10통 (캡차가 켜진 기본 설정에서)
 *
 * 규칙: 공개 POST 라우트(`/admin` 아님)가 메일을 보내면 셋 중 하나는 있어야
 * 한다 — 로그인 요구, 캡차, 속도 제한. 무엇이 맞는지는 자리마다 다르다.
 * 주문서처럼 손님이 돈을 내려는 자리에는 캡차 대신 속도 제한을 쓴다.
 *
 * 한계: 정적으로 본다. 라우트 본문에서 부르는 헬퍼 이름까지 훑지만
 * (requireCaptchaForGuest·checkWriteInterval 처럼), 새로 만든 이름은 모른다 —
 * 그때는 이 목록에 더한다. 실제로 막히는지는 smoke-security.sh 가 쏴 본다.
 *
 * 사용법: node scripts/check-mail-abuse.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 메일을 보내는 표시 */
const SENDS_MAIL = /mail\.send|sendMail|notifyOrder|sendOrderMail|notify\(/;
/** 스스로를 지키는 표시 */
const GUARDED = [
  /captcha/i,                       // 캡차를 직접 확인
  /requireCaptchaForGuest/,         // …또는 그 헬퍼
  /checkWriteInterval/,             // 도배 방지 (게시판)
  /cache\.get<number>|rlKey|-ip:/,  // IP·주소 속도 제한
  /\b429\b/,
  /requireMember|requireUser|로그인이 필요/,  // 로그인 요구 — 보내는 사람이 식별된다
];

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** registerRoute 핸들러의 본문을 괄호 짝으로 정확히 잘라 낸다 */
function handlerBody(src, from) {
  let depth = 0;
  let started = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") {
      depth--;
      if (started && depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from, from + 4000);
}

console.log("▶ 메일을 유발하는 공개 경로는 스스로를 지킨다");
const bad = [];
let mailers = 0;
for (const file of walk(join(ROOT, "plugins"))) {
  const src = readFileSync(file, "utf8");
  const re = /registerRoute\(\s*"POST"\s*,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const path = m[1];
    if (path.startsWith("/admin")) continue;      // 관리 경로는 가드가 따로 있다
    const body = handlerBody(src, m.index + m[0].length);
    if (!SENDS_MAIL.test(body)) continue;
    mailers++;
    if (GUARDED.some((g) => g.test(body))) continue;
    const line = src.slice(0, m.index).split("\n").length;
    bad.push(`${file.slice(ROOT.length)}:${line}  POST ${path} — 로그인·캡차·속도 제한 중 하나가 필요합니다`);
  }
}

if (bad.length) {
  for (const b of bad) console.log(`  ❌ ${b}`);
  console.log(`\n아무 주소로나 메일을 보낼 수 있습니다 — ${bad.length}곳.`);
  process.exit(1);
}
console.log(`  ✅ 메일을 보내는 공개 경로 ${mailers}곳이 모두 스스로를 지킨다`);
