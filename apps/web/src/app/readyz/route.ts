import { proxyToApi } from "@/lib/proxy";

/**
 * /readyz → 내부 API 프록시.
 * 호스팅 패널 환경에서는 내부 API 포트에 접근할 수 없으므로 공개 포트로 노출한다.
 */
export const dynamic = "force-dynamic";
export const GET = proxyToApi;
export const HEAD = proxyToApi;
