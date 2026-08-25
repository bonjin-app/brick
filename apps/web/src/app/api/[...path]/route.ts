import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

/**
 * /api/* → 내부 Brick API 프록시 (런타임 결정).
 * Next의 rewrites는 standalone 빌드에서 대상이 고정되므로 사용하지 않는다.
 */
export const dynamic = "force-dynamic";

export const GET = proxyToApi;
export const POST = proxyToApi;
export const PUT = proxyToApi;
export const PATCH = proxyToApi;
export const DELETE = proxyToApi;
export const HEAD = proxyToApi;
export const OPTIONS = (req: NextRequest) => proxyToApi(req);
