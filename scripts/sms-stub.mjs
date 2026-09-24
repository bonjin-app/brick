#!/usr/bin/env node
/**
 * 문자 공급자 스텁 — 알리고 API 흉내 (문자 + 알림톡).
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
/** 알림톡 — 알리고에 등록된 템플릿 (`PUT /_templates` 로 채운다) */
let templates = [];
/** 다음 n 건의 알림톡을 실패시킨다 (`PUT /_kakao_fail`) — 포인트 부족 등 요청 자체의 거절 */
let kakaoFailNext = 0;

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
    if (req.method === "PUT" && req.url === "/_templates") {
      templates = JSON.parse(body || "[]");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "PUT" && req.url === "/_kakao_fail") {
      kakaoFailNext = Number(JSON.parse(body || "{}").n ?? 0) || 0;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    // ── 알림톡 (kakaoapi.aligo.in 흉내) ──
    if (req.url?.startsWith("/akv10/")) {
      const form = Object.fromEntries(new URLSearchParams(body));
      const kind = req.url.startsWith("/akv10/template/list") ? "template-list" : req.url.startsWith("/akv10/alimtalk/send") ? "alimtalk" : "unknown";
      // 키는 기록하지 않는다 — 맞게 왔는지만
      const { apikey, ...rest } = form;
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), kind, apikeyOk: Boolean(apikey), ...rest })}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      if (!apikey || !form.userid || !form.senderkey) {
        res.end(JSON.stringify({ code: -99, message: "인증오류입니다." }));
        return;
      }
      if (kind === "template-list") {
        const list = form.tpl_code ? templates.filter((t) => t.templtCode === form.tpl_code) : templates;
        res.end(JSON.stringify({ code: 0, message: "정상적으로 호출하였습니다.", list }));
        return;
      }
      if (kind === "alimtalk") {
        if (kakaoFailNext > 0) {
          kakaoFailNext -= 1;
          res.end(JSON.stringify({ code: -101, message: "잔여포인트가 부족합니다." }));
          return;
        }
        // 실제처럼: 본문이 승인된 템플릿과 (변수 자리를 빼고) 같아야 한다
        const tpl = templates.find((t) => t.templtCode === form.tpl_code);
        const pattern = tpl ? new RegExp("^" + tpl.templtContent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/#\\\{[^}]+\\\}/g, "[\\s\\S]*") + "$") : null;
        if (!tpl || !pattern.test(form.message_1 ?? "")) {
          res.end(JSON.stringify({ code: -3, message: "템플릿과 일치하지 않는 메시지입니다." }));
          return;
        }
        res.end(JSON.stringify({ code: 0, message: "성공적으로 전송요청 하였습니다.", info: { type: "AT", mid: 1, scnt: 1, fcnt: 0 } }));
        return;
      }
      res.end(JSON.stringify({ code: -1, message: "unknown" }));
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
