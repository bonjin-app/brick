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
  /*
   * 이 HTML 은 **손님마다 다르다** — 주문 목록, 내 쪽지, 비밀글, 장바구니 수,
   * 머리글의 로그인/로그아웃까지 세션에 따라 달라진다. 그런데 지금까지 이 응답에는
   * cache-control 이 없었다. 위쪽 fetch 는 `cache: "no-store"` 로 막아 두었지만
   * 그것은 **우리가 API 를 부를 때**의 이야기고, 아래로 내보내는 응답이 중간
   * 캐시에게 무엇도 말하지 않았다.
   *
   * 설치 안내는 앞에 Nginx·Caddy 를 두라고 하고, 그 앞에 CDN 을 얹는 사이트가 많다.
   * cache-control 없는 200 HTML 은 그런 캐시가 자기 판단으로 담는다 — 그러면 한
   * 손님의 주문 화면이 다른 손님에게 그대로 나간다.
   *
   * `private` 는 공유 캐시에게 "담지 말라"고 말한다(브라우저 캐시는 허용).
   * 세션 쿠키를 들고 온 요청은 확실히 개인화된 화면이므로 `no-store` 까지 건다 —
   * 공용 PC 의 뒤로 가기로 남의 주문이 보이면 안 된다.
   */
  headers.set("cache-control", cookie ? "private, no-store" : "private, max-age=0, must-revalidate");
  /*
   * 이 라우트는 API 의 JSON 을 받아 HTML 을 **새로** 만든다 — 그래서 API 가 붙인 응답 헤더가
   * 그냥 버려진다. 공개 화면의 보안 헤더를 여기서 옮겨 준다. 특히 CSP 는 테마·플러그인이
   * 선언한 출처를 합친 것이라 API 만이 알고 있다(next.config 의 고정 정책으로 대신할 수 없다).
   */
  for (const name of SECURITY_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  /*
   * 점검 모드(503)에는 `Retry-After` 를 붙인다.
   *
   * 503 만 보내면 크롤러는 "언제 다시 올지" 를 스스로 정한다 — 그 사이 색인이
   * 흔들릴 수 있다. "삼십 분 뒤" 라고 말해 주면 색인을 건드리지 않고 기다린다.
   * 점검 화면은 어떤 캐시에도 담기면 안 된다: 끄는 순간 정상 화면이 나가야 한다.
   */
  if (status === 503) {
    headers.set("retry-after", "1800");
    headers.set("cache-control", "no-store");
  }
  return compressedResponse(req, Buffer.from(html, "utf8"), { status, headers });
}

/**
 * 테마를 못 그릴 때의 마지막 안전망 — API 가 없거나 렌더가 실패한 상황이라 테마도 토큰도 없다.
 * 외부 자산 없이 인라인 스타일만으로, 손님이 읽을 수 있는 화면을 낸다(text/plain 한 줄은 고장난 사이트로 보인다).
 */
/** API 응답에서 그대로 옮길 헤더 — 정책을 아는 쪽은 API 하나여야 한다 */
const SECURITY_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
];

function errorPage(status: number, title: string, detail: string): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f6f6f9;color:#17171c}
main{max-width:460px;padding:40px 28px;text-align:center}h1{font-size:22px;margin:0 0 10px;letter-spacing:-.5px}p{margin:0 0 22px;color:#45454f;line-height:1.6}
a{display:inline-block;padding:11px 20px;border-radius:10px;background:#17171c;color:#fff;text-decoration:none;font-weight:600}small{display:block;margin-top:26px;color:#9797a6;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#101116;color:#ececf1}p{color:#c3c3cd}a{background:#ececf1;color:#17171c}}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p><a href="">다시 시도</a><small>${status} · Something went wrong. Please try again shortly.</small></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "10",
      /*
       * API 가 죽은 상황이라 정책을 물어볼 곳이 없다 — 이 화면은 외부 자산이 하나도 없는
       * 자기완결 HTML 이므로 가장 좁은 정책을 직접 건다. 스크립트는 아예 실행되지 않는다.
       */
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
