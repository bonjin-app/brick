import type { NextRequest } from "next/server";

/**
 * 내부 API로의 런타임 프록시.
 *
 * 왜 Next의 rewrites를 쓰지 않는가:
 *   `output: "standalone"` 빌드에서 rewrites의 destination은 **빌드 시점에 고정**된다.
 *   즉 빌드할 때의 API 포트가 그대로 박히므로, 배포본을 다른 포트로 띄우면 깨진다.
 *   cPanel/Plesk 같은 환경은 포트를 임의로 배정하므로 이 방식은 쓸 수 없다.
 *
 * Route Handler는 매 요청마다 환경변수를 읽으므로 런타임에 결정된다.
 */
function apiBase(): string {
  return (process.env.BRICK_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
}

/** 프록시가 직접 만들거나 호스트에 의존하는 헤더는 전달하지 않는다 */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding", // 압축을 이중으로 처리하지 않게 한다
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export async function proxyToApi(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const target = `${apiBase()}${url.pathname}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  // 내부 API가 실제 클라이언트 IP를 알 수 있게 한다 (요청 제한이 이 값을 쓴다)
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", req.headers.get("host") ?? url.host);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      // 파일 업로드를 메모리에 모으지 않고 그대로 흘려보낸다
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
    } as RequestInit & { duplex?: "half" });
  } catch {
    return new Response(
      JSON.stringify({ statusCode: 502, message: "Brick API에 연결할 수 없습니다." }),
      { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") {
      responseHeaders.set(key, value);
    }
  });
  // Set-Cookie는 여러 개일 수 있어 별도로 옮긴다 (세션 쿠키가 여기로 온다)
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
