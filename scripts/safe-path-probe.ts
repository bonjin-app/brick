/**
 * 되돌아갈 주소 검사가 우회되지 않는가 — 웹의 실제 함수(sameOriginPath)를 부른다.
 *
 * 문자열 규칙("//" 만 막기)은 "/\evil.example"·"/<탭>/evil.example" 에 뚫렸다. 브라우저의
 * URL 해석은 역슬래시를 슬래시로 읽고 탭을 지운다. Node 의 URL 도 같은 WHATWG 해석기다.
 *
 * 출력: 경우마다 "통과한 값 또는 거절" 을 JSON 으로 — 스모크가 기대값과 대조한다.
 */
import { sameOriginPath } from "../apps/web/src/lib/safe-path.ts";

const origin = "https://shop.example";
const cases = [
  "/account?tab=orders#top", // 받는다
  "//evil.example",
  "/\\evil.example",
  "/\t/evil.example",
  "/\\\\evil.example/x",
  "https://evil.example",
  "javascript:alert(1)",
  "",
];
console.log(JSON.stringify(cases.map((c) => sameOriginPath(c, origin) ?? "거절")));
