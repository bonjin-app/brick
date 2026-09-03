import type { NextRequest } from "next/server";
import { compressedResponse } from "../../lib/proxy";

const API = (process.env.BRICK_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");

export const dynamic = "force-dynamic";

/**
 * 공개 사이트 catch-all.
 *
 * React 트리를 거치지 않고 완성 HTML을 그대로 응답한다:
 *  - 테마가 <html>부터 문서 전체를 소유한다 (WordPress와 같은 모델)
 *  - <title>/<meta>가 <head>에 올바르게 위치한다 (SEO)
 *  - 캐시는 API 쪽 태그 캐시(PostgreSQL)가 담당한다
 *
 * /admin, /install 등 정적 라우트가 이 catch-all보다 우선한다.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await ctx.params;

  const install = await fetch(`${API}/api/install/status`, { cache: "no-store" })
    .then((r) => r.json() as Promise<{ state: string }>)
    .catch(() => null);
  if (!install) {
    return new Response("Brick API에 연결할 수 없습니다. API 서버 상태를 확인하세요.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // "not_installed"(DB는 있으나 설치 전)와 "needs_database"(DB 설정 자체가 없음) 모두
  // 설치 마법사로 보낸다 — 마법사가 어느 단계부터 시작할지 스스로 판단한다.
  if (install.state !== "installed") {
    // 절대 URL을 만들면 바인딩 주소(0.0.0.0 등)가 노출될 수 있다 — 상대 경로로 보낸다
    return new Response(null, { status: 302, headers: { location: "/install" } });
  }

  const path = (slug ?? []).join("/");
  // 쿼리스트링과 세션 쿠키를 함께 넘긴다.
  // 검색·페이지네이션은 쿼리가 필요하고, 로그인 사용자는 캐시를 우회해야 한다.
  const incoming = new URL(req.url).searchParams;
  const params = new URLSearchParams();
  params.set("path", path);
  for (const [key, value] of incoming) {
    if (key !== "path") params.append(key, value);
  }
  const cookie = req.headers.get("cookie");
  const res = await fetch(`${API}/api/render/page?${params}`, {
    cache: "no-store",
    headers: cookie ? { cookie } : undefined,
  });
  if (!res.ok) {
    return new Response("렌더링 오류가 발생했습니다.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { html, status } = (await res.json()) as { html: string; status: number };
  // 서버 렌더 HTML 은 80KB 안팎 — br/gzip 으로 눌러 내보낸다 (Next 는 Route Handler 응답을 압축하지 않는다)
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  return compressedResponse(req, Buffer.from(html, "utf8"), { status, headers });
}
