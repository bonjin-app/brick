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
    return errorPage(502, "잠시 후 다시 시도해주세요", "서버 내부 연결이 끊어졌습니다. 관리자라면 API 프로세스 상태를 확인하세요.");
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
    return errorPage(500, "페이지를 그리는 중 문제가 생겼습니다", "잠시 후 새로 고쳐 주세요. 계속되면 관리자에게 알려주세요.");
  }
  const { html, status } = (await res.json()) as { html: string; status: number };
  // 서버 렌더 HTML 은 80KB 안팎 — br/gzip 으로 눌러 내보낸다 (Next 는 Route Handler 응답을 압축하지 않는다)
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  return compressedResponse(req, Buffer.from(html, "utf8"), { status, headers });
}

/**
 * 테마를 못 그릴 때의 마지막 안전망 — API 가 없거나 렌더가 실패한 상황이라 테마도 토큰도 없다.
 * 외부 자산 없이 인라인 스타일만으로, 손님이 읽을 수 있는 화면을 낸다(text/plain 한 줄은 고장난 사이트로 보인다).
 */
function errorPage(status: number, title: string, detail: string): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f6f6f9;color:#17171c}
main{max-width:460px;padding:40px 28px;text-align:center}h1{font-size:22px;margin:0 0 10px;letter-spacing:-.5px}p{margin:0 0 22px;color:#45454f;line-height:1.6}
a{display:inline-block;padding:11px 20px;border-radius:10px;background:#17171c;color:#fff;text-decoration:none;font-weight:600}small{display:block;margin-top:26px;color:#9797a6;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#101116;color:#ececf1}p{color:#c3c3cd}a{background:#ececf1;color:#17171c}}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p><a href="javascript:location.reload()">다시 시도</a><small>${status} · Something went wrong. Please try again shortly.</small></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "10" },
  });
}
