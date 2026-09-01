import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, type Db } from "./types.js";
import { countView, livePopups } from "./popups.js";
import { visitStats } from "./visits.js";

/**
 * 사이트 운영 블록.
 *
 * 세 개다:
 *   - 접속자 집계 (테마 푸터에 놓는 "오늘 N명")
 *   - 배너 (지정한 자리에 이미지/HTML)
 *   - 레이어 팝업 (페이지 위에 떠서 닫을 수 있는 것)
 *
 * 팝업만 클라이언트가 데이터를 가져온다. 이유는 '다시 보지 않기'다 —
 * 서버가 렌더한 HTML에 팝업이 들어 있으면, 이미 닫은 사용자에게도 캐시된
 * HTML이 전달되고 화면을 깜빡이며 지워야 한다.
 */
export function registerSiteBlocks(ctx: PluginContext, db: Db): void {
  // ── 접속자 집계 ───────────────────────────────────
  ctx.registerBlock({
    name: "visit-counter",
    displayName: "접속자 집계",
    propsSchema: {
      type: "object",
      properties: {
        style: { type: "string", title: "표시 (inline | box)", default: "inline" },
        showBest: { type: "boolean", title: "최고 방문자 표시", default: false },
      },
    },
    render: async (props) => {
      const s = await visitStats(db);
      const n = (v: number) => v.toLocaleString("ko-KR");
      const rows = [
        { label: "오늘", value: n(s.today) },
        { label: "어제", value: n(s.yesterday) },
        { label: "전체", value: n(s.total) },
      ];
      if (props.showBest && s.best) {
        rows.push({ label: "최고", value: `${n(s.best.total)} (${String(s.best.day).slice(0, 10)})` });
      }

      if (props.style === "box") {
        return `<dl class="brick-visit-box">${rows
          .map((r) => `<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`)
          .join("")}</dl>${VISIT_CSS}`;
      }
      return `<p class="brick-visit-inline">${rows
        .map((r) => `<span>${r.label} <b>${r.value}</b></span>`)
        .join("")}</p>${VISIT_CSS}`;
    },
  });

  // ── 배너 ─────────────────────────────────────────
  ctx.registerBlock({
    name: "banner",
    displayName: "배너",
    propsSchema: {
      type: "object",
      properties: {
        limit: { type: "number", title: "표시 개수", default: 3 },
      },
    },
    render: async (props, blockCtx) => {
      const path = String(blockCtx?.path ?? "/");
      const limit = Math.min(10, Math.max(1, Number(props.limit ?? 3)));
      const rows = (await livePopups(db, { path, kind: "banner" })).slice(0, limit);
      if (!rows.length) return "";

      // 배너는 캐시되어도 문제가 없다(모두에게 같은 내용) — 노출 카운트만
      // 캐시 적중 시 올라가지 않는데, 배너에서는 클릭 수가 더 중요한 지표다.
      await countView(db, rows.map((r) => String(r.id)));

      const items = rows.map((b) => {
        const inner = `
    ${b.image_url ? `<img src="${escapeHtml(b.image_url)}" alt="${escapeHtml(b.title)}" loading="lazy" />` : ""}
    ${b.content ? `<div class="brick-banner-body">${String(b.content)}</div>` : ""}`;
        if (!b.link_url) return `<div class="brick-banner-item">${inner}\n  </div>`;
        return `<a class="brick-banner-item" href="${escapeHtml(b.link_url)}"
     target="${escapeHtml(b.link_target)}" rel="noopener noreferrer"
     data-banner="${escapeHtml(b.id)}">${inner}\n  </a>`;
      }).join("");

      return `<div class="brick-banners">${items}\n</div>${BANNER_SCRIPT}${VISIT_CSS}`;
    },
  });

  // ── 레이어 팝업 ───────────────────────────────────
  ctx.registerBlock({
    name: "popup",
    displayName: "레이어 팝업",
    propsSchema: { type: "object", properties: {} },
    render: async () =>
      // 껍데기만 낸다. 어떤 팝업을 띄울지는 '다시 보지 않기' 상태를 아는
      // 브라우저가 정한다 (아래 스크립트).
      `<div class="brick-popup-host" hidden></div>${POPUP_SCRIPT}${VISIT_CSS}`,
  });
}

const VISIT_CSS = `
<style>
.brick-visit-inline{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--color-muted, #6c6c7a);margin:0}
.brick-visit-inline b{color:inherit;font-weight:600}
.brick-visit-box{display:flex;gap:0;margin:16px 0;padding:0;border:1px solid var(--color-line, #e4e4ea);border-radius:10px;overflow:hidden}
.brick-visit-box>div{flex:1;padding:14px;text-align:center;border-right:1px solid var(--color-line, #e4e4ea)}
.brick-visit-box>div:last-child{border-right:0}
.brick-visit-box dt{font-size:12px;color:var(--color-muted, #6c6c7a)}
.brick-visit-box dd{margin:4px 0 0;font-size:18px;font-weight:700}
.brick-banners{display:grid;gap:12px;margin:16px 0}
.brick-banner-item{display:block;text-decoration:none;color:inherit;border-radius:10px;overflow:hidden}
.brick-banner-item img{width:100%;height:auto;display:block}
.brick-banner-body{line-height:1.7}
.brick-popup{position:fixed;z-index:9000;background:var(--color-bg, #ffffff);border:1px solid var(--color-line, #e4e4ea);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.22);overflow:hidden;max-width:calc(100vw - 24px)}
.brick-popup-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--color-line, #e4e4ea);font-weight:700;font-size:15px}
.brick-popup-head button{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--color-muted, #6c6c7a);padding:0 4px}
.brick-popup-body{padding:14px;line-height:1.7;max-height:60vh;overflow:auto}
.brick-popup-body img{max-width:100%;height:auto}
.brick-popup-foot{display:flex;align-items:center;gap:6px;padding:10px 14px;border-top:1px solid var(--color-line, #e4e4ea);font-size:13px;color:var(--color-text-soft, #45454f)}
@media(max-width:640px){
  .brick-popup{left:12px !important;right:12px;top:12px !important;width:auto !important}
}
</style>`;

/* ── 배너 클릭 집계 ────────────────────────────────
   링크 이동을 막지 않는다 — keepalive로 보내고 브라우저는 그대로 이동한다. */
const BANNER_SCRIPT = `
<script>
(function(){
  var wrap = document.currentScript.parentNode.querySelector('.brick-banners');
  if (!wrap) return;
  wrap.querySelectorAll('[data-banner]').forEach(function(a){
    a.addEventListener('click', function(){
      try {
        fetch('/api/plugins/brick-site/popups/' + a.dataset.banner + '/click',
              { method: 'POST', keepalive: true });
      } catch (e) { /* 집계 실패가 이동을 막아서는 안 된다 */ }
    });
  });
})();
</script>`;

/* ── 레이어 팝업 ───────────────────────────────────
   '다시 보지 않기'는 localStorage에 만료 시각을 적어둔다.
   쿠키를 쓰지 않는 이유: 팝업 상태는 서버가 알 필요가 없고,
   쿠키는 모든 요청에 실려 나간다. */
const POPUP_SCRIPT = `
<script>
(function(){
  var host = document.currentScript.parentNode.querySelector('.brick-popup-host');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function hiddenUntil(id){
    try { return Number(localStorage.getItem('brick_popup_' + id) || 0); }
    catch (e) { return 0; }   // 시크릿 모드 등에서 접근이 막힐 수 있다
  }
  function hide(id, days){
    try {
      localStorage.setItem('brick_popup_' + id, String(Date.now() + days * 86400000));
    } catch (e) { /* 저장하지 못하면 다음에 다시 뜬다 — 기능이 깨지지는 않는다 */ }
  }

  fetch('/api/plugins/brick-site/popups?path=' + encodeURIComponent(location.pathname))
    .then(function(r){ return r.json(); })
    .then(function(d){
      var now = Date.now();
      (d.items || []).forEach(function(p, i){
        if (hiddenUntil(p.id) > now) return;

        var box = document.createElement('div');
        box.className = 'brick-popup';
        box.style.top  = (Number(p.pos_top)  + i * 24) + 'px';
        box.style.left = (Number(p.pos_left) + i * 24) + 'px';
        box.style.width = Number(p.width) + 'px';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', p.title);

        // 본문 HTML은 저장 시점에 새니타이즈되었다(popups.ts).
        // 제목처럼 평문으로 다루는 값은 여기서 이스케이프한다.
        var link = p.link_url
          ? '<p><a href="' + esc(p.link_url) + '" target="' + esc(p.link_target) +
            '" rel="noopener noreferrer" data-go>자세히 보기</a></p>'
          : '';
        box.innerHTML =
          '<div class="brick-popup-head"><span>' + esc(p.title) + '</span>' +
          '<button type="button" data-close aria-label="닫기">&times;</button></div>' +
          '<div class="brick-popup-body">' +
            (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="" />' : '') +
            (p.content || '') + link +
          '</div>' +
          (Number(p.hide_days) > 0
            ? '<div class="brick-popup-foot"><label><input type="checkbox" data-hide /> ' +
              Number(p.hide_days) + '일 동안 보지 않기</label></div>'
            : '');

        box.querySelector('[data-close]').addEventListener('click', function(){
          var chk = box.querySelector('[data-hide]');
          if (chk && chk.checked) hide(p.id, Number(p.hide_days));
          box.remove();
        });
        var go = box.querySelector('[data-go]');
        if (go) go.addEventListener('click', function(){
          try {
            fetch('/api/plugins/brick-site/popups/' + p.id + '/click',
                  { method: 'POST', keepalive: true });
          } catch (e) { /* 무시 */ }
        });

        host.parentNode.appendChild(box);
      });
    })
    .catch(function(){ /* 팝업을 못 불러와도 페이지는 정상이다 */ });
})();
</script>`;
