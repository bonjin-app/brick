#!/usr/bin/env node
/*
 * **그누보드 덤프의 테이블을 하나도 말없이 버리지 않는가.**
 *
 * 이전 서비스는 스스로 이렇게 적어 두었다 — "있는데 안 옮기는 것은 명시한다.
 * 없다고 착각하고 나중에 발견하는 것이 최악이다". 그런데 그 규칙을 지키는
 * 것은 사람의 기억뿐이었고, 실제로 넷이 새어 있었다(첨부파일·게시판 그룹·
 * 내용관리·메뉴). 글은 옮겨지는데 자료실이 빈 껍데기가 되고, 없어졌다는 말도
 * 없었다.
 *
 * 그래서 **알려진 테이블 목록**을 여기 두고, 각각이 둘 중 하나여야 한다고 못박는다:
 *   - 이전 코드가 읽는다 (`${prefix}xxx` 로 등장)
 *   - 안 옮긴다고 **이유와 함께** 선언되어 있다 (분석 결과의 skipped 목록)
 *
 * 목록을 늘리는 것이 이 검사를 쓰는 방법이다: 새 테이블을 알게 되면 여기 적고,
 * 그러면 옮기거나 선언하기 전까지 CI 가 막는다.
 *
 * 파생·캐시 테이블(최신글 캐시·방문 집계처럼 원본에서 다시 만들어지는 것)은
 * 목록에 넣지 않는다 — 옮길 대상이 아니고, 넣으면 선언만 늘어난다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * 손님·운영자의 **데이터가 든** 그누보드5 / 영카트5 테이블.
 * (접두어 `g5_` 는 뺀 이름)
 */
const KNOWN = [
  // ── 그누보드5 ──
  "member",        // 회원
  "point",         // 포인트
  "board",         // 게시판 설정
  "board_file",    // 게시글 첨부파일
  "board_good",    // 추천·비추천
  "group",         // 게시판 그룹
  "group_member",  // 그룹 접근 회원
  "content",       // 내용관리(정적 페이지)
  "menu",          // 메뉴
  "faq",           // FAQ
  "faq_master",    // FAQ 분류
  "qa_content",    // 1:1 문의
  "memo",          // 쪽지
  "scrap",         // 스크랩
  "poll",          // 설문조사
  "popular",       // 인기 검색어
  "visit",         // 방문 기록
  "login",         // 접속 기록
  "autosave",      // 자동저장
  "auth",          // 관리 권한
  "config",        // 기본 설정
  "mail",          // 회원 메일 발송 이력
  // ── 영카트5 ──
  "shop_category",
  "shop_item",
  "shop_item_option",
  "shop_order",
  "shop_cart",
  "shop_item_use", // 상품 후기
  "shop_item_qa",  // 상품 문의
  "shop_coupon",   // 쿠폰
  "shop_wish",     // 위시리스트
  "shop_event",    // 기획전
];

const files = ["migrate.service.ts", "youngcart-map.ts", "gnuboard-map.ts"].map((f) =>
  readFileSync(join(ROOT, "apps/api/src/modules/migrate", f), "utf8"),
);
const src = files.join("\n");

/** 주석은 지운다 — 주석에 이름을 적어 두고 다루지 않는 것이 가장 나쁜 통과다 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const problems = [];
for (const table of KNOWN) {
  // 이전 코드가 읽는가: `${prefix}board_file` · YC_TABLES 의 값 · readRows 인자
  const read =
    new RegExp(`\\$\\{prefix\\}${table}\\b`).test(code) ||
    new RegExp(`["']${table}["']`).test(code.replace(/skipCandidates[\s\S]*?\];/, ""));
  // 안 옮긴다고 선언했는가: skipCandidates 나 skipped.push 에 이름이 있는가
  const declared =
    new RegExp(`\\["${table}",`).test(code) ||
    new RegExp(`YC_TABLES\\.\\w+[^\\n]*`).test(code) && new RegExp(`skipped\\.push[\\s\\S]{0,400}${table}`).test(code);
  if (!read && !declared) problems.push(table);
}

console.log("▶ 그누보드 덤프의 테이블을 말없이 버리지 않는다");
console.log(`  ✅ 알려진 테이블 ${KNOWN.length}개를 대조했습니다`);
for (const t of problems) {
  console.log(`  ❌ g5_${t} — 옮기지도, 안 옮긴다고 선언하지도 않았습니다`);
}
console.log(
  problems.length
    ? "\n없다고 착각하고 옮긴 뒤에 발견하면, 운영자는 원본 데이터베이스를 다시 찾아야 합니다."
    : "\n옮기거나, 옮기지 않는다고 말하거나 — 둘 중 하나입니다.",
);
process.exit(problems.length ? 1 : 0);
