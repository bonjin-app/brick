#!/usr/bin/env node
/*
 * Brick MCP 서버 — AI 에이전트(Claude Code·Cursor 등)가 **돌고 있는 사이트를 읽는다**. 읽기 전용.
 *
 * 의존성이 없다(Node 20+ 의 fetch 만 쓴다). 표준입출력으로 MCP(JSON-RPC 2.0, 한 줄에 하나)를 말한다.
 *
 *   BRICK_URL=https://내사이트.com BRICK_TOKEN=brk_… node scripts/brick-mcp.mjs
 *
 * 토큰은 관리자 → 시스템의 "API 토큰"(POST /api/admin/api-tokens)에서 만든다. 로그인 세션이 아니라 **읽기(GET) 전용,
 * 진단 경로만 열리고, 언제든 폐기되는** 토큰이다 — 설정 파일이 새도 사이트를 바꾸거나 회원 정보를 볼 수 없다.
 * 이 서버도 같은 제한을 한 번 더 건다: 아래 표에 없는 경로는 부르지 않고 GET 외의 메서드는 코드에 없다.
 *
 * Claude Code 에 등록:
 *   claude mcp add brick -e BRICK_URL=https://내사이트.com -e BRICK_TOKEN=brk_… -- node /경로/scripts/brick-mcp.mjs
 */
import { createInterface } from "node:readline";

const BASE = (process.env.BRICK_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.BRICK_TOKEN ?? "";
const MAX_TEXT = 60_000;
const PROTOCOL = "2024-11-05";
const SERVER_INFO = { name: "brick", version: "1.0.0" };

/** 서버에 요청 — GET 만 있다 */
async function get(path, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`${BASE} 에 연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`거절됨 (${res.status}) — BRICK_TOKEN 이 없거나 폐기·만료됐거나 이 경로를 열어 주지 않는 토큰입니다.`);
  }
  if (!res.ok) throw new Error(`요청 실패 (${res.status}): ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const clip = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n…(${s.length - MAX_TEXT}자 생략)` : s;
};

const TOOLS = [
  {
    name: "site_status",
    description: "사이트가 살아 있는지(readyz)와 Brick 버전을 본다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const [ready, version] = await Promise.all([get("/readyz").catch((e) => ({ error: e.message })), get("/api/admin/version").catch((e) => ({ error: e.message }))]);
      return { ready, version };
    },
  },
  {
    name: "dashboard",
    description: "관리자 대시보드의 상태 — 설정 경고(메일 미설정·테마 문제·꺼진 플러그인)와 카드별 수치.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => get("/api/admin/dashboard"),
  },
  {
    name: "list_plugins",
    description: "설치된 플러그인과 활성 여부·버전.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => get("/api/plugins"),
  },
  {
    name: "list_themes",
    description: "설치된 테마와 지금 쓰는 테마.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => get("/api/themes"),
  },
  {
    name: "check_updates",
    description: "코어·플러그인·테마에 나온 업데이트.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => get("/api/admin/updates"),
  },
  {
    name: "admin_areas",
    description: "관리 화면 목록(어떤 관리 영역이 있는지).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => get("/api/admin/areas"),
  },
  {
    name: "render_page",
    description: "사이트의 한 경로를 서버가 그린 결과를 본다(상태 코드·제목·본문). 예: path=\"\"(홈), \"board/free\", \"shop\". 손님 화면 기준이다.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "슬래시 없는 경로. 홈은 빈 문자열" } },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await get("/api/render/page", { path: String(args?.path ?? "").replace(/^\/+/, "") });
      const html = String(r?.html ?? "");
      return {
        status: r?.status, slug: r?.slug,
        title: (html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? null,
        htmlBytes: html.length,
        html,
      };
    },
  },
  {
    name: "api_reference",
    description: "이 사이트의 API 목록(OpenAPI) — 경로와 메서드만 요약한다. 자세한 스키마가 필요하면 path 를 준다.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "이 경로의 전체 정의를 본다 (예: /api/plugins)" } },
      additionalProperties: false,
    },
    run: async (args) => {
      const doc = await get("/api/openapi.json");
      const paths = doc?.paths ?? {};
      if (args?.path) return paths[String(args.path)] ?? { error: "그 경로는 문서에 없습니다." };
      return { title: doc?.info?.title, version: doc?.info?.version, count: Object.keys(paths).length, paths: Object.fromEntries(Object.entries(paths).map(([p, v]) => [p, Object.keys(v ?? {})])) };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

async function handle(msg) {
  const { method, params, id } = msg;
  switch (method) {
    case "initialize":
      return { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const tool = byName.get(String(params?.name));
      if (!tool) throw Object.assign(new Error(`알 수 없는 도구: ${params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: "text", text: clip(await tool.run(params?.arguments ?? {})) }] };
      } catch (e) {
        // 도구 실행 실패는 프로토콜 오류가 아니라 결과다 — 에이전트가 읽고 스스로 고칠 수 있게
        return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
    default:
      if (id === undefined) return undefined; // 알림(notifications/*)은 답하지 않는다
      throw Object.assign(new Error(`지원하지 않는 메서드: ${method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (!TOKEN) {
  // 시작은 하되 첫 호출에서 이유를 말한다 — 에이전트 화면에 "서버가 죽었다" 로만 보이는 것보다 낫다
  process.stderr.write("BRICK_TOKEN 이 없습니다. 관리자 → API 토큰에서 만든 brk_… 값을 환경 변수로 주세요.\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e?.code ?? -32603, message: e instanceof Error ? e.message : String(e) } });
  }
});
rl.on("close", () => process.exit(0));
