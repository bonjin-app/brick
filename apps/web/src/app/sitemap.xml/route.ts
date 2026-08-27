import { proxyPlain } from "@/lib/seo-proxy";

/**
 * sitemap.xml 은 API가 만든다 — 게시글·상품 주소는 플러그인만 알기 때문이다.
 * catch-all([[...slug]])이 먼저 잡으면 페이지 렌더로 가서 404가 되므로
 * 명시 라우트로 둔다.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return await proxyPlain("/sitemap.xml", "application/xml; charset=utf-8");
}
