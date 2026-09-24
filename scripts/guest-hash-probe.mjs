#!/usr/bin/env node
/**
 * 비회원 비밀번호 검증이 이벤트 루프를 멈추는가 — 직접 잰다.
 *
 * 게시판의 검증은 scryptSync 였다. 한 번에 약 70ms 동안 Node 의 이벤트 루프 전체가 멈춰,
 * 틀린 비밀번호를 쏟아부으면 사이트의 모든 요청이 섰다. 스모크의 "대입 중에도 사이트가
 * 답한다" 는 사용자에게 보이는 결과를 보지만, 요청 제한이 켜져 있으면 검증이 다섯 번만
 * 일어나 동기로 되돌려도 문턱을 간신히 넘거나 못 넘는다 — 그래서 여기서 따로 잰다.
 *
 * 검증 10건을 동시에 돌리는 동안 10ms 타이머가 가장 크게 밀린 시간을 잰다.
 * 출력: "maxLagMs=<ms>" — 동기면 수백 ms, 비동기면 수십 ms 이하.
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { hashGuestPassword, verifyGuestPassword } = await import(`${ROOT}plugins/brick-board/dist/guest.js`);
const stored = await hashGuestPassword("4821");
let maxLag = 0;
let last = performance.now();
const timer = setInterval(() => {
  const t = performance.now();
  maxLag = Math.max(maxLag, t - last - 10);
  last = t;
}, 10);
await new Promise((r) => setTimeout(r, 50));
maxLag = 0; last = performance.now();
await Promise.all(Array.from({ length: 10 }, (_, i) => verifyGuestPassword(String(i).padStart(4, "0"), stored)));
await new Promise((r) => setTimeout(r, 30));
clearInterval(timer);
console.log(`maxLagMs=${Math.round(maxLag)}`);
