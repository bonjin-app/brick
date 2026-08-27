#!/usr/bin/env node
/**
 * 테스트용 OpenID Connect 공급자 스텁.
 *
 * 소셜 로그인은 외부 서버가 있어야 흐름 전체를 볼 수 있는 기능이다.
 * 구글·카카오에 실제로 붙어 테스트할 수는 없으므로, 표준 OIDC를 말하는
 * 최소 서버를 띄워 Brick의 `oidc` 공급자로 연결한다.
 *
 * 검증되는 것: 인증 리다이렉트 → state 쿠키 결속 → 코드 교환 → 프로필 조회
 * → 계정 생성/연결 → 세션 발급. 즉 실패하면 실제 공급자에서도 실패한다.
 *
 * 사용법:
 *   node scripts/oidc-stub.mjs --port 45999
 *
 * 프로필은 요청마다 바꿀 수 있다 (테스트가 여러 사용자를 흉내내야 한다):
 *   PUT /_profile  {"sub":"u1","email":"a@b.c","email_verified":true,"name":"홍길동"}
 */
import { createServer } from "node:http";

const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 45999;

const CLIENT_ID = "stub-client";
const CLIENT_SECRET = "stub-secret";

/** 현재 로그인시킬 사용자 — 테스트가 PUT /_profile 로 바꾼다 */
let profile = {
  sub: "stub-user-1",
  email: "sso-user@stub.test",
  email_verified: true,
  name: "SSO 사용자",
};

/** 발급한 코드 → 프로필 스냅샷. 코드는 1회용이어야 한다 */
const codes = new Map();

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // 테스트가 다음 로그인 사용자를 지정한다
  if (url.pathname === "/_profile" && req.method === "PUT") {
    profile = { ...profile, ...JSON.parse((await body(req)) || "{}") };
    return json(200, { ok: true, profile });
  }

  // 1) 인증 — 사용자 동의 화면 없이 바로 되돌려 보낸다
  if (url.pathname === "/authorize") {
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("client_id") !== CLIENT_ID) {
      return json(400, { error: "invalid_client" });
    }
    if (!redirect || !state) return json(400, { error: "invalid_request" });

    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { ...profile });
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  // 사용자가 취소한 경우를 흉내내는 경로
  if (url.pathname === "/authorize-deny") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  // 2) 코드 → 토큰
  if (url.pathname === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await body(req));
    if (params.get("client_id") !== CLIENT_ID || params.get("client_secret") !== CLIENT_SECRET) {
      return json(401, { error: "invalid_client" });
    }
    const code = params.get("code");
    if (!codes.has(code)) return json(400, { error: "invalid_grant" });
    // 1회용 — 재사용 시도는 위 검사에서 걸린다
    const claims = codes.get(code);
    codes.delete(code);
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    tokens.set(token, claims);
    return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
  }

  // 3) 프로필
  if (url.pathname === "/userinfo") {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokens.has(token)) return json(401, { error: "invalid_token" });
    return json(200, tokens.get(token));
  }

  json(404, { error: "not_found" });
});

const tokens = new Map();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[oidc-stub] listening on http://127.0.0.1:${PORT}`);
});
