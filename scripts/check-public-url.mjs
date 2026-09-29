#!/usr/bin/env node
/*
 * 공개 주소 검사(`publicUrl` · `publicUrls` · `toAbsoluteUrl`)의 규칙을 못박는다.
 *
 * 이 규칙은 여섯 곳에 넷으로 갈라져 적혀 있었고, 그 어긋남이 결함이었다 — 후기·문의 첨부·반품 사진·글 썸네일이
 * `//남의도메인/x.png` 를 통과시켜 보는 사람의 브라우저가 남의 서버를 불렀고, `HTTPS://` 는 한쪽만 대소문자를 가려
 * 깨진 주소를 만들었다. 지금은 코어의 함수 하나를 모두가 쓴다. 이 검사는 그 하나가 규칙을 지키는지 본다
 * (API 없이 돈다 — 빌드된 @brick/core 만 읽는다).
 */
import { publicUrl, publicUrls, toAbsoluteUrl } from "../packages/core/dist/index.js";

let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : ` (기대 ${JSON.stringify(want)}, 실제 ${JSON.stringify(got)})`}`);
};

console.log("▶ 공개 주소 검사가 한 규칙을 지킨다");
eq("절대 주소는 통과", publicUrl("https://cdn.example/a.jpg"), "https://cdn.example/a.jpg");
eq("대소문자 무관 (HTTPS://)", publicUrl("HTTPS://cdn.example/a.jpg"), "HTTPS://cdn.example/a.jpg");
eq("사이트 안 경로는 통과", publicUrl("/uploads/a.png"), "/uploads/a.png");
eq("앞뒤 공백은 다듬는다", publicUrl("  /uploads/a.png \n"), "/uploads/a.png");
eq("// 프로토콜 상대 주소는 거절 (남의 서버를 부른다)", publicUrl("//evil.test/x.png"), null);
eq("javascript: 거절", publicUrl("javascript:alert(1)"), null);
eq("data: 거절", publicUrl("data:image/png;base64,AAAA"), null);
eq("호스트 없는 https:/// 거절", publicUrl("https:///x"), null);
eq("역슬래시 거절 (브라우저가 / 로 읽는다)", publicUrl("/\\evil.test/x"), null);
eq("주소 안의 공백 거절", publicUrl("/a b.png"), null);
eq("제어문자 거절 (사이트맵 XML 을 깨뜨린다)", publicUrl("/a\u0001b.png"), null);
eq("빈 값·null·숫자 거절", [publicUrl(""), publicUrl(null), publicUrl(undefined), publicUrl(5)], [null, null, null, null]);
eq("길이 상한 (기본 2000)", [publicUrl("/" + "a".repeat(1999)) !== null, publicUrl("/" + "a".repeat(2000))], [true, null]);
eq("길이 상한을 고를 수 있다", publicUrl("/" + "a".repeat(10), { maxLen: 5 }), null);
eq("한글 경로는 통과", publicUrl("/uploads/사진.png"), "/uploads/사진.png");

eq("목록: 거를 것은 거르고 같은 것은 한 번", publicUrls(["/a.png", "//x/y", "/a.png", "javascript:1", "https://c/d.jpg"]), ["/a.png", "https://c/d.jpg"]);
eq("목록: max 까지", publicUrls(["/1", "/2", "/3"], { max: 2 }), ["/1", "/2"]);
eq("목록: 배열이 아니면 빈 목록", [publicUrls("x"), publicUrls(null), publicUrls({})], [[], [], []]);

eq("절대 주소로: 경로는 사이트 주소를 붙인다", toAbsoluteUrl("/uploads/a.png", "https://site.test/"), "https://site.test/uploads/a.png");
eq("절대 주소로: 끝 슬래시가 여럿이어도", toAbsoluteUrl("/a.png", "https://site.test///"), "https://site.test/a.png");
eq("절대 주소로: 이미 절대면 그대로 (대소문자 무관)", toAbsoluteUrl("HTTPS://c.test/a.png", "https://site.test"), "HTTPS://c.test/a.png");
eq("절대 주소로: 빈 값", toAbsoluteUrl("", "https://site.test"), "");

console.log(bad ? `\n${bad}개 실패 — 이 규칙이 어긋나면 남의 서버 호출·깨진 og:image·깨진 사이트맵이 됩니다.` : "\n모두 맞습니다.");
process.exit(bad ? 1 : 0);
