#!/usr/bin/env node
/*
 * 웹 프록시가 서버 전송 이벤트(SSE)를 **흘려보내는가** — 실제 프록시 함수를 로컬 SSE 서버에 붙여 본다.
 *
 * 프록시는 텍스트 응답을 통째로 모아 압축한다(`text/` 는 모두 압축 대상). 이벤트 스트림은 끝나지 않으므로
 * 모으기 시작하면 첫 이벤트조차 브라우저에 닿지 않고, 실시간 알림은 켜진 것처럼 보이는데 아무것도 오지 않는다.
 * 서버와 브라우저 사이의 이 한 겹은 API 스모크(서버만 띄운다)로는 보이지 않는다.
 *
 * Node 22.6+ 의 `--experimental-strip-types` 로 TypeScript 원본을 그대로 부른다 (빌드 불필요).
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.__SSE_PROXY_CHILD) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], {
    stdio: "inherit", env: { ...process.env, __SSE_PROXY_CHILD: "1" },
  });
  process.exit(r.status ?? 1);
}

let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : ` (기대 ${JSON.stringify(want)}, 실제 ${JSON.stringify(got)})`}`);
};

console.log("▶ 웹 프록시의 이벤트 스트림 통과");

// 첫 이벤트 뒤 3초를 더 열어 두는 서버 — 프록시가 끝까지 모은다면 첫 이벤트가 3초 뒤에야 나온다
const server = http.createServer((req, res) => {
  if (req.url === "/api/notifications/stream") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    res.write('event: unread\ndata: {"unread":2}\n\n');
    const t = setTimeout(() => res.end(), 3000);
    req.on("close", () => { clearTimeout(t); res.end(); });
  } else {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("x".repeat(4000));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.BRICK_API_URL = `http://127.0.0.1:${server.address().port}`;

const { proxyToApi } = await import("../apps/web/src/lib/proxy.ts");
const call = (path) => proxyToApi(new Request(`http://localhost:3000${path}`, { headers: { "accept-encoding": "gzip, br" } }));

const t0 = Date.now();
const res = await call("/api/notifications/stream");
const first = await res.body.getReader().read();
const ms = Date.now() - t0;
eq("이벤트 스트림으로 내려온다", res.headers.get("content-type")?.startsWith("text/event-stream"), true);
eq("압축하지 않는다 (조각이 그대로 나가야 한다)", res.headers.get("content-encoding"), null);
eq("첫 이벤트가 스트림이 끝나기 전에 도착한다", ms < 1500, true);
eq("내용이 온전하다", new TextDecoder().decode(first.value).includes('"unread":2'), true);

const plain = await call("/api/plain");
eq("일반 텍스트는 여전히 압축된다", plain.headers.get("content-encoding") !== null, true);

server.closeAllConnections?.();
server.close();
console.log(bad ? `\n❌ ${bad}건 어긋납니다.` : "\n모두 맞습니다.");
process.exit(bad ? 1 : 0);
