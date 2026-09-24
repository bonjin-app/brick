#!/usr/bin/env node
/**
 * 요청 제한의 시간 창이 버킷마다 지켜지는가.
 *
 * 정리(sweep)가 **지금 호출한 쪽의 창**으로 모든 버킷을 판단했다. 15분 창을 쓰는 로그인
 * 요청이 정리를 부르면, 60분 창인 "비밀번호 재설정 제출"(IP 당 한 시간에 20번) 버킷이
 * 15분 만에 지워져 한도가 풀렸다. 시계를 앞으로 돌려 본다.
 *
 * 출력: "exhausted=<소진 직후 막혔나> after21m=<21분 뒤에도 막혔나>"
 */
const ROOT = new URL("..", import.meta.url).pathname;
const { RateLimitService } = await import(`${ROOT}apps/api/dist/modules/auth/rate-limit.service.js`);
let now = 1_000_000_000_000;
Date.now = () => now;
const rl = new RateLimitService();
const H = 60 * 60_000, Q = 15 * 60_000;
for (let i = 0; i < 20; i++) rl.consume("reset-submit:1.2.3.4", 20, H);
const exhausted = !rl.check("reset-submit:1.2.3.4", 20, H).allowed;
now += 20 * 60_000;
rl.consume("login:someone", 10, Q);   // 15분 창 호출이 정리를 부른다
now += 61_000;                         // 정리 주기(60초)를 넘긴다
rl.consume("login:someone", 10, Q);
const after = !rl.check("reset-submit:1.2.3.4", 20, H).allowed;
console.log(`exhausted=${exhausted} after21m=${after}`);
