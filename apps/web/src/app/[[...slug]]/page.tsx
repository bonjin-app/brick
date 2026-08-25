import { notFound, redirect } from "next/navigation";

const API = process.env.BRICK_API_URL ?? "http://localhost:3001";

/**
 * 공개 사이트 catch-all 라우트.
 *
 * 렌더 파이프라인:
 *   1. 설치 안 됐으면 /install 로
 *   2. slug → 페이지 조회 → 블록 트리를 서버 렌더(HTML) → 활성 테마 템플릿에 주입
 *   3. 결과 HTML을 그대로 출력 (SSR — 검색엔진은 완성된 HTML을 본다)
 *
 * 테마가 런타임 템플릿이므로 여기서는 dangerouslySetInnerHTML로 주입한다.
 * (테마 HTML은 관리자가 설치한 신뢰 자산이며, 사용자 입력은 렌더 전에 이스케이프된다)
 */
export default async function CatchAllPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;

  const status = await fetch(`${API}/api/install/status`, { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => null);
  if (!status) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: 48 }}>
        <h1>Brick API에 연결할 수 없습니다</h1>
        <p>BRICK_API_URL({API})의 API 서버가 실행 중인지 확인하세요.</p>
      </main>
    );
  }
  if (status.state !== "installed") redirect("/install");

  const path = (slug ?? []).join("/") || "home";
  const res = await fetch(`${API}/api/themes/render/${path === "home" ? "home" : "page"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { site: { name: "Brick" }, path } }),
    next: { revalidate: 60, tags: [`page:${path}`] },
  });
  if (!res.ok) notFound();
  const { html } = (await res.json()) as { html: string };

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
