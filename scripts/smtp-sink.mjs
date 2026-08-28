#!/usr/bin/env node
/**
 * 테스트용 SMTP 싱크.
 *
 * 단체메일은 **무엇이 실제로 발송되는가**가 법적으로 중요하다 —
 * (광고) 표기, 수신거부 링크, 수신 동의 재확인. 대상 선정만 확인하고
 * 발송 내용을 안 보면 정작 중요한 것을 검증하지 못한다.
 *
 * 실제 SMTP 서버를 세울 수 없으므로, nodemailer 가 말을 걸 수 있는 최소한의
 * SMTP 서버를 구현한다. 받은 메일을 JSON Lines 파일에 적어 테스트가 읽는다.
 *
 * 구현하는 명령: EHLO/HELO · MAIL FROM · RCPT TO · DATA · QUIT · RSET · NOOP
 * 구현하지 않는 것: AUTH · STARTTLS · 파이프라이닝 (테스트에 필요 없다)
 *
 * 사용법:
 *   node scripts/smtp-sink.mjs --port 42525 --out /tmp/mails.jsonl
 */
import { createServer } from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", 42525));
const OUT = arg("out", "/tmp/brick-mails.jsonl");

// 매 실행마다 비운다 — 이전 실행의 메일이 섞이면 검증이 거짓으로 통과한다
writeFileSync(OUT, "");

/**
 * MIME 본문 디코딩.
 *
 * nodemailer 는 한글 본문을 base64 또는 quoted-printable 로 인코딩한다.
 * 그대로 두면 "(광고)" 를 찾을 수 없어 검증이 무의미해진다.
 */
function decodeBody(raw, headers) {
  const encoding = String(headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (encoding === "quoted-printable") {
    // 바이트로 모아 UTF-8 로 디코딩한다.
    // String.fromCharCode 로 문자를 만들면 각 바이트가 latin1 문자가 되어
    // 한글이 깨진다 — "할인합니다"가 "í\x95\xa0..." 로 보인다.
    const unfolded = raw.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < unfolded.length; i += 1) {
      if (unfolded[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        // ASCII 범위 밖의 문자는 이미 UTF-8 바이트로 들어온 것이다
        for (const b of Buffer.from(unfolded[i], "utf8")) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return raw;
}

/**
 * RFC 2047 인코딩된 헤더 (제목 등) 디코딩.
 *
 * 긴 헤더는 여러 encoded-word 로 쪼개져 접힌다. 붙어 있는 encoded-word 사이의
 * 공백은 **구분자일 뿐 내용이 아니므로 지워야 한다** — 남기면 "안내"가
 * "안 내"로 보인다.
 */
function decodeHeader(value) {
  return String(value)
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, kind, text) => {
      try {
        if (kind.toUpperCase() === "B") {
          return Buffer.from(text, "base64").toString("utf8");
        }
        // Q 인코딩도 바이트로 모아 UTF-8 로 디코딩한다
        const bytes = [];
        const src = text.replace(/_/g, " ");
        for (let i = 0; i < src.length; i += 1) {
          if (src[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
            bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            for (const b of Buffer.from(src[i], "utf8")) bytes.push(b);
          }
        }
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return text;
      }
    },
  );
}

/**
 * 메시지 파싱 — 헤더와 (멀티파트면) 각 파트의 본문.
 *
 * 텍스트와 HTML 을 모두 꺼낸다. 텍스트 대안이 실제로 들어 있는지도 검증 대상이다
 * (HTML 만 보내면 스팸 판정을 받는다).
 */
function parseMessage(data) {
  const sep = data.indexOf("\r\n\r\n");
  const headerBlock = sep < 0 ? data : data.slice(0, sep);
  const bodyBlock = sep < 0 ? "" : data.slice(sep + 4);

  const headers = {};
  // 접힌 헤더(다음 줄이 공백으로 시작)를 이어붙인다
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, " ");
  for (const line of unfolded.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    headers[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim();
  }

  const contentType = String(headers["content-type"] ?? "");
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];

  let text = "";
  let html = "";

  if (boundary) {
    const parts = bodyBlock.split(`--${boundary}`);
    for (const part of parts) {
      const psep = part.indexOf("\r\n\r\n");
      if (psep < 0) continue;
      const ph = {};
      for (const line of part.slice(0, psep).replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        ph[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim();
      }
      const body = decodeBody(part.slice(psep + 4), ph);
      const type = String(ph["content-type"] ?? "");
      if (type.includes("text/html")) html += body;
      else if (type.includes("text/plain")) text += body;
      // 중첩 멀티파트는 무시한다 — 테스트 메일은 2단을 넘지 않는다
    }
  } else {
    text = decodeBody(bodyBlock, headers);
  }

  return {
    subject: decodeHeader(headers.subject ?? ""),
    to: decodeHeader(headers.to ?? ""),
    from: decodeHeader(headers.from ?? ""),
    text: text.trim(),
    html: html.trim(),
  };
}

const server = createServer((socket) => {
  let buffer = "";
  let inData = false;
  let dataLines = [];
  let envelopeTo = [];

  const send = (line) => socket.write(`${line}\r\n`);
  send("220 brick-smtp-sink ready");

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    for (;;) {
      const nl = buffer.indexOf("\r\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);

      if (inData) {
        if (line === ".") {
          inData = false;
          const parsed = parseMessage(dataLines.join("\r\n"));
          // 봉투 수신자를 함께 남긴다 — 헤더의 To 와 다를 수 있다
          appendFileSync(OUT, `${JSON.stringify({ ...parsed, envelopeTo })}\n`);
          dataLines = [];
          envelopeTo = [];
          send("250 2.0.0 Ok: queued");
          continue;
        }
        // 점 스터핑 해제 (RFC 5321)
        dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        continue;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        // AUTH 를 광고하지 않는다 — nodemailer 가 인증을 시도하지 않게
        send("250-brick-smtp-sink");
        send("250 8BITMIME");
      } else if (upper.startsWith("MAIL FROM")) {
        send("250 2.1.0 Ok");
      } else if (upper.startsWith("RCPT TO")) {
        const addr = /<([^>]*)>/.exec(line)?.[1] ?? "";
        envelopeTo.push(addr);
        send("250 2.1.5 Ok");
      } else if (upper === "DATA") {
        inData = true;
        send("354 End data with <CR><LF>.<CR><LF>");
      } else if (upper === "RSET") {
        dataLines = [];
        envelopeTo = [];
        send("250 2.0.0 Ok");
      } else if (upper === "NOOP") {
        send("250 2.0.0 Ok");
      } else if (upper === "QUIT") {
        send("221 2.0.0 Bye");
        socket.end();
      } else {
        send("502 5.5.1 Command not implemented");
      }
    }
  });

  socket.on("error", () => {
    // 클라이언트가 갑자기 끊는 것은 정상이다 (풀 정리)
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[smtp-sink] listening on 127.0.0.1:${PORT} → ${OUT}`);
});
