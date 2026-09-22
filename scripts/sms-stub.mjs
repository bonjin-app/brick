#!/usr/bin/env node
/**
 * 문자 공급자 스텁 — 알리고 API 흉내.
 *
 * 실제 공급자에 붙으면 **요금이 나가고** 계정도 필요하다. 그래서 검증은
 * 스텁으로 한다(PG 스텁·SMTP 싱크와 같은 방식): 받은 요청을 JSONL 로 남겨
 * 스모크가 "무엇이 어느 번호로 나갔는가" 를 직접 읽는다.
 *
 * 사용법: node scripts/sms-stub.mjs --port 42900 --out /tmp/sms.jsonl
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg("port", 42900));
const OUT = arg("out", "");
/** 다음 n 건을 실패시킨다 (`PUT /_fail` 로 조절) */
let failNext = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "PUT" && req.url === "/_fail") {
      failNext = Number(JSON.parse(body || "{}").n ?? 0) || 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, failNext }));
      return;
    }
    if (!req.url?.startsWith("/send")) {
      res.writeHead(404).end("not found");
      return;
    }
    const form = Object.fromEntries(new URLSearchParams(body));
    if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...form })}\n`);
    res.writeHead(200, { "content-type": "application/json" });
    if (failNext > 0) {
      failNext -= 1;
      // 알리고는 실패도 200 으로 주고 result_code 가 음수다 — 그 모양을 그대로 흉내낸다
      res.end(JSON.stringify({ result_code: -101, message: "인증오류입니다." }));
      return;
    }
    res.end(JSON.stringify({ result_code: 1, message: "success", msg_type: form.msg_type }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sms-stub] listening on 127.0.0.1:${PORT} → ${OUT || "(기록 안 함)"}`);
});
