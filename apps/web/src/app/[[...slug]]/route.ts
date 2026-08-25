import type { NextRequest } from "next/server";

const API = process.env.BRICK_API_URL ?? "http://localhost:3001";

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
  if (install.state !== "installed") {
    return Response.redirect(new URL("/install", req.url), 302);
  }

  const path = (slug ?? []).join("/");
  const res = await fetch(`${API}/api/render/page?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!res.ok) {
    return new Response("렌더링 오류가 발생했습니다.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { html, status } = (await res.json()) as { html: string; status: number };
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
