import { proxyPlain } from "@/lib/seo-proxy";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return await proxyPlain("/robots.txt", "text/plain; charset=utf-8");
}
