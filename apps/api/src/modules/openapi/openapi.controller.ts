import { Controller, Get, Header } from "@nestjs/common";
import { OpenApiService } from "./openapi.service.js";

/**
 * GET /api/openapi.json — OpenAPI 3.1 문서 (기계용)
 * GET /api/docs         — 사람용 API 레퍼런스 (외부 자원 없이 자체 완결)
 *
 * 공개다. 경로 목록은 오픈소스 저장소에 이미 다 있는 정보이고, 인증이
 * 필요한 라우트는 여기 실려 있어도 인증 없이는 열리지 않는다 — 숨겨서
 * 지키는 보안은 보안이 아니다.
 */
@Controller("api")
export class OpenApiController {
  constructor(private readonly openapi: OpenApiService) {}

  @Get("openapi.json")
  document() {
    return this.openapi.buildDocument();
  }

  @Get("docs")
  @Header("content-type", "text/html; charset=utf-8")
  docsPage(): string {
    // 문서 데이터는 클라이언트가 /api/openapi.json 을 다시 불러 그린다 —
    // 페이지를 캐시해도 문서는 항상 현재 라우트를 보여준다.
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Brick API 문서</title>
<style>
  :root { --fg:#14141f; --muted:#5b5b6e; --line:#e6e6ee; --card:#fafafc; --brand:#d0402c; --bg:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f0f0f6; --muted:#a2a2b8; --line:#2a2a3d; --card:#1b1b2b; --brand:#f2725f; --bg:#131320; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,'Apple SD Gothic Neo','Segoe UI',sans-serif; line-height:1.6; }
  .wrap { max-width:880px; margin:0 auto; padding:32px 20px 80px; }
  h1 { letter-spacing:-1px; margin:0 0 4px; }
  p.lead { color:var(--muted); margin:0 0 20px; font-size:14.5px; }
  input#q { width:100%; padding:10px 14px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--fg); font-size:14px; margin-bottom:24px; }
  h2 { font-size:16px; margin:28px 0 8px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  .ep { display:flex; gap:10px; align-items:baseline; padding:5px 8px; border-radius:8px; font-size:13.5px; }
  .ep:hover { background:var(--card); }
  .m { font-family:ui-monospace,Menlo,monospace; font-weight:700; font-size:11.5px; width:52px; flex:none; text-align:right; }
  .m-get{color:#2f6fce} .m-post{color:#2ea043} .m-put{color:#b58a00} .m-delete{color:#d0402c} .m-patch{color:#8250df}
  .p { font-family:ui-monospace,Menlo,monospace; word-break:break-all; }
  .s { color:var(--muted); font-size:12.5px; }
  .lock { font-size:11px; }
  a { color:var(--brand); }
  .count { color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Brick API</h1>
  <p class="lead">실제로 등록된 라우트에서 생성됩니다 — 플러그인을 켜고 끄면 이 문서도 함께 변합니다.
  기계용 스펙: <a href="/api/openapi.json">/api/openapi.json</a> · 인증: 세션 쿠키 (<code>POST /api/auth/login</code>)</p>
  <input id="q" placeholder="경로·설명으로 거르기 (예: products, 주문)" />
  <div id="list">불러오는 중…</div>
</div>
<script>
(async () => {
  const doc = await (await fetch("/api/openapi.json")).json();
  const groups = new Map();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = (op.tags && op.tags[0]) || "etc";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push({ method, path, summary: op.summary || "", locked: !!op.security });
    }
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  const order = ["get","post","put","patch","delete"];
  let total = 0;
  const html = [...groups.keys()].sort().map((tag) => {
    const eps = groups.get(tag).sort((a,b) => a.path === b.path
      ? order.indexOf(a.method) - order.indexOf(b.method)
      : a.path.localeCompare(b.path));
    total += eps.length;
    return \`<section data-tag="\${esc(tag)}"><h2>\${esc(tag)}</h2>\` + eps.map((e) =>
      \`<div class="ep" data-k="\${esc((e.method+" "+e.path+" "+e.summary).toLowerCase())}">
         <span class="m m-\${e.method}">\${e.method.toUpperCase()}</span>
         <span class="p">\${esc(e.path)}</span>
         \${e.locked ? '<span class="lock" title="관리자 세션 필요">🔒</span>' : ""}
         <span class="s">\${esc(e.summary)}</span>
       </div>\`).join("") + "</section>";
  }).join("");
  document.getElementById("list").innerHTML =
    \`<p class="count">엔드포인트 \${total}개 · 그룹 \${groups.size}개</p>\` + html;

  document.getElementById("q").addEventListener("input", (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    for (const el of document.querySelectorAll(".ep")) {
      el.style.display = !q || el.dataset.k.includes(q) ? "" : "none";
    }
    for (const sec of document.querySelectorAll("section")) {
      const any = [...sec.querySelectorAll(".ep")].some((e) => e.style.display !== "none");
      sec.style.display = any ? "" : "none";
    }
  });
})();
</script>
</body>
</html>`;
  }
}
