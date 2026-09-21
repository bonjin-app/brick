import { escapeHtml } from "@brick/core";

/**
 * 테마 파일이 하나도 없을 때 쓰는 **내장 레이아웃** — 최후의 방어선.
 *
 * 테마는 디스크의 파일이다. 그래서 디스크가 어긋나면(볼륨이 안 붙은 컨테이너,
 * BRICK_THEMES_DIR 오타, ZIP 전개 실패, 운영자가 직접 고치다 깨뜨린 JSON)
 * **사이트의 모든 페이지가 500 이 된다.** 글도 상품도 DB 에 멀쩡히 있는데
 * 손님에게는 사이트가 통째로 사라진 것으로 보인다 — 확장 파일이 없을 때
 * 손님 화면만 조용히 비던 것(docs/operations.md)의 더 나쁜 판본이다.
 *
 * 그래서 마지막에 이 레이아웃이 받는다. 테마의 디자인은 없지만
 * **제목·본문·메뉴·푸터가 그대로 나가고 링크가 살아 있다.** 손님은 느린
 * 사이트가 아니라 수수한 사이트를 보고, 주문도 글쓰기도 계속된다.
 * 운영자에게는 대시보드가 원인과 고치는 법을 말해 준다.
 *
 * 고장을 손님에게 알리지 않는다 — 손님이 할 수 있는 일이 없고,
 * "테마 오류" 같은 문구는 사이트를 신뢰할 수 없는 곳으로 만든다.
 */
export function renderBuiltinLayout(scope: Record<string, unknown>): string {
  const site = (scope.site ?? {}) as Record<string, unknown>;
  const menu = Array.isArray(scope.menu) ? (scope.menu as MenuItem[]) : [];
  const locale = typeof scope.locale === "string" ? scope.locale : "ko";
  const siteName = String(site.name ?? "");
  const pageTitle = String(scope.pageTitle ?? siteName);
  const heading = String(scope.title ?? "");
  const seo = (scope.seo ?? {}) as { description?: string };
  const description = String(seo.description ?? site.description ?? "");
  // 블록이 만든 HTML 이다 — 이미 위생 처리되어 있으므로 그대로 넣는다
  const body = String(scope.blocksHtml ?? scope.content ?? "");
  const business = site.business as Record<string, string> | null | undefined;

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pageTitle)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}" />\n` : ""}<meta name="color-scheme" content="light dark" />
<link rel="stylesheet" href="/api/themes/tokens.css" />
<style>${BUILTIN_CSS}</style>
</head>
<body>
<header class="b-head">
  <a class="b-brand" href="/">${escapeHtml(siteName)}</a>
  ${menu.length ? `<nav class="b-nav">${menu.map(navLink).join("")}</nav>` : ""}
</header>
<main class="b-main">
${heading ? `<h1>${escapeHtml(heading)}</h1>\n` : ""}${body}
</main>
<footer class="b-foot">
  <p>${escapeHtml(siteName)}</p>
  ${business ? `<p>${Object.values(business).filter(Boolean).map((v) => escapeHtml(v)).join(" · ")}</p>` : ""}
</footer>
</body>
</html>`;
}

interface MenuItem {
  label?: string;
  url?: string;
  children?: MenuItem[];
}

/**
 * 메뉴 링크. **url 은 손님이 누르는 곳이므로 스킴을 제한한다** — 메뉴는
 * 관리자가 넣지만 백업 복원·가져오기로도 들어오고, `javascript:` 가 섞이면
 * 테마 없이 그리는 이 화면이 그대로 실행한다.
 */
function navLink(item: MenuItem): string {
  const raw = String(item?.url ?? "").trim();
  const safe = /^(https?:\/\/|\/|#)/i.test(raw) ? raw : "/";
  return `<a href="${escapeHtml(safe)}">${escapeHtml(item?.label ?? "")}</a>`;
}

/**
 * 토큰(/api/themes/tokens.css)이 살아 있으면 그 색을 쓰고, 그것마저 없으면
 * var() 의 기본값으로 떨어진다 — 어느 쪽이든 읽을 수 있는 화면이 나온다.
 */
const BUILTIN_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--color-bg,#fff);color:var(--color-text,#17171c);
  font:16px/1.7 -apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',Roboto,sans-serif}
img{max-width:100%;height:auto}
a{color:var(--color-primary-text,#b63a2e)}
.b-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;
  padding:16px 20px;border-bottom:1px solid var(--color-line,#e4e4ea)}
.b-brand{font-size:18px;font-weight:700;text-decoration:none;color:inherit}
.b-nav{display:flex;flex-wrap:wrap;gap:16px}
.b-nav a{text-decoration:none}
.b-main{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
.b-main h1{font-size:24px;margin:8px 0 20px}
.b-foot{border-top:1px solid var(--color-line,#e4e4ea);padding:24px 20px;
  color:var(--color-muted,#6a6a78);font-size:13px}
.b-foot p{margin:4px 0}
@media (prefers-color-scheme:dark){
  body:not([data-theme="light"]){background:var(--color-bg,#15151a);color:var(--color-text,#f2f2f5)}
  /* 링크 색은 어두운 바탕에서 다시 정한다 — 라이트용 진한 빨강은 대비가 3:1 도 안 된다 */
  body:not([data-theme="light"]) a{color:var(--color-primary-text,#ff9d90)}
  body:not([data-theme="light"]) .b-head,
  body:not([data-theme="light"]) .b-foot{border-color:var(--color-line,#33333d)}
}
`.trim();
