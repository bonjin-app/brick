#!/usr/bin/env node
/**
 * 회원을 가리키는 테이블은 전부 탈퇴에서 **한 번은 판단된다.**
 *
 * 탈퇴는 "개인을 지우고 거래를 남긴다" 는 원칙으로 돌아간다(개인정보보호법
 * 제21조 vs 전자상거래법 제6조). 문제는 그 판단이 **테이블마다 다르고, 새 테이블은
 * 아무도 다시 묻지 않는다**는 것이다. 실제로 그래서 셋이 새고 있었다:
 *
 *  - `user_totp` · `user_recovery_codes` — 비밀번호는 쓸 수 없는 값으로 덮고 세션도
 *    소셜 연결도 끊으면서, **인증 수단 중 이것만** 남았다. TOTP 비밀은 암호화하지
 *    않기로 한 값이고 복구 코드는 회원이 종이에 적어 둔 것이다.
 *  - `notifications` — 알림 본문에 주문번호와 글 제목이 그대로 있고 최대 180일 남는다.
 *    계정 이름만 익명화하면 탈퇴 반년 뒤까지 그 사람의 활동이 문장으로 남는다.
 *
 * 그래서 users(id) 를 참조하는 컬럼이 있는 테이블은 아래 셋 중 하나여야 한다:
 *
 *   erased      — 탈퇴가 지운다(지우는 코드에 테이블 이름이 실제로 있는지 확인한다)
 *   anonymized  — 행은 남고 연결만 끊긴다. users 행 자체가 익명화되므로,
 *                 user_id 만 들고 있는 테이블은 이미 아무도 가리키지 않는다
 *   retained    — 남긴다. 법적 보존 의무처럼 **이유가 있어야** 한다
 *
 * 새 테이블이 생기면 여기 적기 전까지 CI 가 막는다. 그 한 줄을 적는 순간이
 * "이 데이터는 탈퇴하면 어떻게 되는가" 를 묻는 유일한 자리다.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 테이블 → [상태, 이유]. 상태가 erased 면 지우는 코드에 이름이 있어야 한다. */
const POLICY = {
  // ── 코어 ──
  sessions: ["erased", "로그인 상태가 남으면 '탈퇴했다'는 말이 거짓이 된다"],
  user_identities: ["erased", "남기면 같은 소셜 계정이 탈퇴한 계정에 다시 붙는다"],
  password_resets: ["erased", "살아 있는 재설정 토큰"],
  email_verifications: ["erased", "살아 있는 인증 토큰"],
  user_totp: ["erased", "암호화하지 않고 저장하는 2단계 인증 공유 비밀"],
  user_recovery_codes: ["erased", "회원이 종이에 적어 둔 복구 코드"],
  totp_challenges: ["erased", "진행 중이던 2단계 인증 시도"],
  notifications: ["erased", "알림 본문에 주문번호·글 제목이 그대로 있다"],
  mail_unsubscribe_tokens: ["erased", "옛 메일의 링크로 계정 설정을 바꿀 수 있다"],
  user_agreements: ["retained", "'이 계정이 언제 무엇에 동의했다'는 사실은 분쟁의 증거다"],
  audit_logs: ["retained", "감사 기록을 탈퇴로 지울 수 있으면 감사가 아니다"],
  mail_recipients: ["retained", "광고 발송 이력(정보통신망법 제50조 분쟁 대비)"],
  mail_campaigns: ["anonymized", "만든 사람만 가리킨다 — 익명화된 users 행을 가리키게 둔다"],
  pages: ["anonymized", "페이지는 사이트의 내용이다. 작성자 연결만 익명 계정을 가리킨다"],
  page_revisions: ["anonymized", "같은 이유 — 되돌릴 대상이 사라지면 안 된다"],
  media_files: ["anonymized", "올린 파일은 사이트의 자산이다"],
  search_logs: ["anonymized", "검색어 통계는 운영에 쓰인다. user_id 는 익명 계정을 가리킨다"],
};

/** 플러그인 테이블은 그 플러그인의 eraser 가 책임진다 — 여기서는 등록 여부만 본다. */
const PLUGIN_EXEMPT = new Set();

const tablesOf = (sqlText) => {
  const out = [];
  for (const m of sqlText.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = [...m[2].matchAll(/^\s*(\w+)\s+uuid[^,]*REFERENCES users\(id\)/gm)].map((c) => c[1]);
    if (cols.length) out.push({ table: m[1], cols });
  }
  return out;
};
const readDir = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(ROOT, dir, f), "utf8")).join("\n");
const slurp = (dir) => {
  let out = "";
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.tsx?$/.test(e.name)) out += readFileSync(join(ROOT, d, e.name), "utf8");
    }
  };
  walk(dir);
  return out;
};

const problems = [];

// ── 코어 ──
const erasingCode = slurp("apps/api/src/modules/members");
for (const { table, cols } of tablesOf(readDir("packages/database/migrations"))) {
  const policy = POLICY[table];
  if (!policy) {
    problems.push(`${table} (${cols.join(", ")}) — 탈퇴 정책이 없습니다.\n` +
      `      scripts/check-withdrawal-coverage.mjs 의 POLICY 에 erased·anonymized·retained 중 하나를 이유와 함께 적으세요.`);
    continue;
  }
  if (policy[0] === "erased" && !erasingCode.includes(table)) {
    problems.push(`${table} — POLICY 는 "지운다" 인데 탈퇴 코드에 그 테이블이 없습니다.\n` +
      `      지우거나, POLICY 를 사실대로 고치세요. 지웠다고 말하고 안 지우는 것이 가장 나쁩니다.`);
  }
}

// ── 플러그인 ──
for (const name of readdirSync(join(ROOT, "plugins"))) {
  const mig = join("plugins", name, "migrations");
  if (!existsSync(join(ROOT, mig)) || !statSync(join(ROOT, mig)).isDirectory()) continue;
  const tables = tablesOf(readDir(mig));
  if (!tables.length) continue;
  const src = slurp(join("plugins", name, "src"));
  if (!src.includes("registerDataEraser") && !PLUGIN_EXEMPT.has(name)) {
    problems.push(`${name} — 회원을 가리키는 테이블이 ${tables.length}개 있는데 ` +
      `registerDataEraser 가 없습니다 (${tables.map((t) => t.table).join(", ")}).\n` +
      `      코어는 플러그인 테이블 이름을 모릅니다. 등록하지 않으면 탈퇴해도 그대로 남습니다.`);
    continue;
  }
  for (const { table, cols } of tables) {
    if (src.includes(table)) continue;
    problems.push(`${name}/${table} (${cols.join(", ")}) — eraser 는 있지만 이 테이블을 ` +
      `어디서도 다루지 않습니다.`);
  }
}

if (problems.length) {
  console.error("❌ 탈퇴가 놓치는 개인정보가 있습니다:\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
const counts = Object.values(POLICY).reduce((a, [s]) => ((a[s] = (a[s] ?? 0) + 1), a), {});
console.log(`✅ 코어 ${Object.keys(POLICY).length}개 테이블 — 지움 ${counts.erased} · 익명화 ${counts.anonymized} · 보존 ${counts.retained}, 플러그인 eraser 전부 등록됨`);
