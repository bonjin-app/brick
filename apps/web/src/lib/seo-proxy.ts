/**
 * SEO 파일 프록시.
 *
 * API 주소를 **요청 시점**에 읽는다. 빌드 타임에 굳히면 배포본을 다른 포트로
 * 실행할 때 깨진다 (ADR-18 과 같은 이유).
 */
export async function proxyPlain(path: string, contentType: string): Promise<Response> {
  const api = (process.env.BRICK_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  try {
    const res = await fetch(`${api}${path}`, { cache: "no-store" });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": contentType,
        // API가 준 캐시 정책을 그대로 전달한다
        "cache-control": res.headers.get("cache-control") ?? "public, max-age=3600",
      },
    });
  } catch {
    // API가 죽었을 때 500 대신 최소한의 robots 를 준다 —
    // 크롤러에게 500을 주면 사이트 전체를 문제 있는 것으로 취급할 수 있다
    return new Response("User-agent: *\nDisallow:\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
