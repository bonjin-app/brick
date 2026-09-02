import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, type Db, type HelpSettings } from "./types.js";
import { listCategories, listFaqs } from "./faq.js";

/**
 * 스토어프론트 블록.
 *
 * FAQ 는 **서버 렌더**한다 — 공개 콘텐츠이고 검색 유입이 실제로 많다.
 * 1:1 문의는 껍데기만 내고 목록·상세는 클라이언트가 채운다 —
 * 내 문의만 보여야 하므로 렌더 캐시(비로그인 전용)에 담길 수 없다 (ADR-30 과 같은 판단).
 */
export function registerHelpdeskBlocks(
  ctx: PluginContext,
  db: Db,
  settings: () => Promise<HelpSettings>,
): void {
  // ── FAQ ───────────────────────────────────────────
  ctx.registerBlock({
    name: "faq",
    displayName: "FAQ",
    propsSchema: {
      type: "object",
      properties: {
        category: { type: "string", title: "분류 slug (비우면 전체)" },
        showSearch: { type: "boolean", title: "검색창", default: true },
        showTabs: { type: "boolean", title: "분류 탭", default: true },
        limit: { type: "number", title: "표시 개수", default: 100 },
      },
    },
    render: async (props, blockCtx) => {
      // 분류·검색어는 주소에서 읽는다 — 링크로 공유되고 검색엔진이 색인한다
      const category = String(blockCtx.query.category ?? props.category ?? "");
      const q = String(blockCtx.query.q ?? "").trim();

      const [{ items: faqs }, { items: cats }] = await Promise.all([
        listFaqs(db, { category, q, limit: Number(props.limit ?? 100) }),
        listCategories(db),
      ]);

      const tabs =
        props.showTabs !== false && cats.length > 1
          ? `<nav class="brick-faq-tabs">
    <a href="?"${!category ? ' class="is-on"' : ""}>전체</a>
    ${cats
      .map(
        (c) =>
          `<a href="?category=${encodeURIComponent(String(c.slug))}"${
            category === String(c.slug) ? ' class="is-on"' : ""
          }>${escapeHtml(c.name)} <span>${Number(c.faq_count)}</span></a>`,
      )
      .join("\n    ")}
  </nav>`
          : "";

      const search =
        props.showSearch !== false
          ? `<form class="brick-faq-search" method="get">
    ${category ? `<input type="hidden" name="category" value="${escapeHtml(category)}" />` : ""}
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="궁금한 내용을 검색하세요" />
    <button type="submit">검색</button>
  </form>`
          : "";

      if (!faqs.length) {
        const msg = q ? `"${escapeHtml(q)}"에 대한 결과가 없습니다.` : "등록된 FAQ가 없습니다.";
        return `<div class="brick-faq">${tabs}${search}<p class="brick-faq-empty">${msg}</p></div>${FAQ_CSS}`;
      }

      // details/summary 로 만든다 — JS 없이 접히고, 검색엔진은 내용을 다 읽는다.
      // 자체 아코디언을 구현하면 JS가 실패한 환경에서 답변이 안 보인다.
      const items = faqs
        .map(
          (f) => `    <details class="brick-faq-item" data-id="${escapeHtml(f.id)}">
      <summary>${escapeHtml(f.question)}</summary>
      <div class="brick-faq-answer">${String(f.answer ?? "")}</div>
      <div class="brick-faq-rate">
        <span>도움이 되었나요?</span>
        <button type="button" data-rate="1">예</button>
        <button type="button" data-rate="0">아니오</button>
        <em class="brick-faq-thanks" hidden>의견 감사합니다.</em>
      </div>
    </details>`,
        )
        .join("\n");

      return `<div class="brick-faq">
  ${tabs}
  ${search}
  <div class="brick-faq-list">
${items}
  </div>
</div>${FAQ_CSS}${FAQ_SCRIPT}`;
    },
  });

  // ── 1:1 문의 ──────────────────────────────────────
  ctx.registerBlock({
    name: "tickets",
    displayName: "1:1 문의",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string", title: "제목", default: "1:1 문의" },
      },
    },
    render: async (props, blockCtx) => {
      const s = await settings();
      // 껍데기만. 내 문의는 캐시에 담길 수 없다. 비로그인 여부는 서버가 알려 준다 —
      // 손님 브라우저가 401 을 받으러 갔다 오지 않게(콘솔 오류·한 번의 헛요청).
      return `<section class="brick-help" data-allow-guest="${s.allowGuest ? "1" : "0"}" data-guest="${blockCtx?.user ? "0" : "1"}">
  <h2 class="brick-help-title">${escapeHtml(props.title ?? "1:1 문의")}</h2>
  <div class="brick-help-body"><p class="brick-faq-empty">불러오는 중…</p></div>
</section>${FAQ_CSS}${HELP_CSS}${HELP_SCRIPT}`;
    },
  });
}

/* ── FAQ 스타일 ────────────────────────────────────── */
const FAQ_CSS = `
<style>
.brick-faq{margin:20px 0}
.brick-faq-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.brick-faq-tabs a{padding:7px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:20px;text-decoration:none;color:inherit;font-size:14px}
.brick-faq-tabs a.is-on{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent}
.brick-faq-tabs a span{opacity:.6;font-size:12px}
.brick-faq-search{display:flex;gap:8px;margin-bottom:20px}
.brick-faq-search input{flex:1;padding:11px;border:1px solid var(--color-line, #e4e4ea);border-radius:8px;font:inherit}
.brick-faq-search button{padding:11px 20px;border:0;border-radius:8px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);font-weight:700;cursor:pointer}
.brick-faq-empty{padding:40px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-faq-item{border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-faq-item summary{padding:16px 4px;cursor:pointer;font-weight:600;line-height:1.5}
.brick-faq-item summary::marker{color:var(--color-primary,#d0402c)}
.brick-faq-answer{padding:0 4px 16px;line-height:1.8;color:var(--color-text-soft, #45454f)}
.brick-faq-rate{display:flex;align-items:center;gap:8px;padding:0 4px 16px;font-size:13px;color:var(--color-muted, #6c6c7a)}
.brick-faq-rate button{padding:4px 12px;border:1px solid var(--color-line, #e4e4ea);border-radius:14px;background:var(--color-bg, #ffffff);font-size:13px;cursor:pointer}
.brick-faq-thanks{color:var(--color-primary,#d0402c);font-style:normal}
</style>`;

const HELP_CSS = `
<style>
.brick-help{margin:24px 0}
.brick-help-title{font-size:22px;margin:0 0 16px}
.brick-help-guest p{margin:0 0 14px}.brick-help-guest .brick-actions-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.brick-help-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}
.brick-help-toolbar button{padding:10px 18px;border:0;border-radius:8px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);font-weight:700;cursor:pointer}
.brick-help table{width:100%;border-collapse:collapse;font-size:14px}
.brick-help th,.brick-help td{padding:12px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);text-align:left}
.brick-help th{color:var(--color-muted, #6c6c7a);font-weight:600;font-size:13px}
.brick-help td a{color:inherit;text-decoration:none;font-weight:600}
.brick-badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:700}
.brick-badge.open{background:color-mix(in srgb, var(--color-danger, #c9342f) 13%, transparent);color:var(--color-danger, #c9342f)}
.brick-badge.answered{background:color-mix(in srgb, var(--color-success, #11795a) 14%, transparent);color:var(--color-success, #11795a)}
.brick-badge.closed{background:var(--color-bg-sunken, #eeeef3);color:var(--color-text-soft, #45454f)}
.brick-help-form{padding:20px;border:1px solid var(--color-line, #e4e4ea);border-radius:12px;margin-bottom:20px}
.brick-help-form label{display:block;font-size:14px;margin-bottom:10px}
.brick-help-form input,.brick-help-form select,.brick-help-form textarea{width:100%;padding:11px;margin-top:4px;border:1px solid var(--color-line, #e4e4ea);border-radius:8px;box-sizing:border-box;font:inherit}
.brick-help-form textarea{min-height:140px}
.brick-help-msg{font-size:13px;color:var(--color-danger, #c9342f);min-height:18px}
.brick-thread{margin-top:20px;display:grid;gap:14px}
.brick-thread-item{padding:16px;border-radius:10px;background:var(--color-bg-soft, #f6f6f9);white-space:pre-wrap;line-height:1.7}
.brick-thread-item.is-staff{background:color-mix(in srgb, var(--color-primary, #cf4437) 9%, transparent);border-left:3px solid var(--color-primary,#d0402c)}
.brick-thread-item b{display:block;font-size:13px;margin-bottom:6px;color:var(--color-text-soft, #45454f)}
</style>`;

/* ── FAQ 클라이언트 (조회수 · 평가) ────────────────── */
const FAQ_SCRIPT = `
<script>
(function(){
  var root = document.currentScript.parentNode.querySelector('.brick-faq');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  var API = '/api/plugins/brick-helpdesk';

  root.querySelectorAll('.brick-faq-item').forEach(function(item){
    var counted = false;
    // 펼칠 때 조회수를 센다. 목록에 뜬 것만으로는 읽었다고 볼 수 없다.
    item.addEventListener('toggle', function(){
      if (!item.open || counted) return;
      counted = true;
      fetch(API + '/faqs/' + item.dataset.id + '/viewed', { method: 'POST' }).catch(function(){});
    });
    item.querySelectorAll('[data-rate]').forEach(function(btn){
      btn.addEventListener('click', function(){
        fetch(API + '/faqs/' + item.dataset.id + '/rate', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({ helpful: btn.dataset.rate === '1' })
        }).catch(function(){});
        item.querySelectorAll('[data-rate]').forEach(function(b){ b.disabled = true; });
        var thanks = item.querySelector('.brick-faq-thanks');
        if (thanks) thanks.hidden = false;
      });
    });
  });
})();
</script>`;

/* ── 1:1 문의 클라이언트 ───────────────────────────── */
const HELP_SCRIPT = `
<script>
(function(){
  var root = document.currentScript.parentNode.querySelector('.brick-help');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  var body = root.querySelector('.brick-help-body');
  var API = '/api/plugins/brick-helpdesk';
  var allowGuest = root.dataset.allowGuest === '1';
  var config = { categories: ['일반'] };

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function day(s){ return String(s||'').slice(0,10); }
  function label(s){ return s === 'answered' ? '답변완료' : s === 'closed' ? '종료' : '접수'; }

  function json(url, opts){
    return fetch(url, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        return { ok: r.ok, status: r.status, d: d };
      });
    });
  }

  function guestView(){
    var next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML = '<div class="brick-empty brick-help-guest"><p>문의 내역을 보려면 로그인해주세요.' +
      (allowGuest ? ' 로그인 없이도 문의를 남길 수 있습니다.' : '') + '</p>' +
      '<div class="brick-actions-row"><a class="brick-btn brick-btn-primary" href="/login?next=' + next + '">로그인</a>' +
      (allowGuest ? '<button type="button" class="brick-btn" data-new>문의하기</button>' : '') + '</div></div>';
    bindNew();
  }

  function showList(){
    if (root.dataset.guest === '1') { guestView(); return; }
    json(API + '/my/tickets').then(function(res){
      if (res.status === 401) { guestView(); return; }
      if (!res.ok) { body.innerHTML = '<p class="brick-faq-empty">문의 내역을 불러올 수 없습니다.</p>'; return; }

      var rows = (res.d.items || []).map(function(t){
        return '<tr><td>' + esc(t.ticket_no) + '</td>' +
          '<td><a href="#" data-open="' + esc(t.id) + '">' + esc(t.title) + '</a></td>' +
          '<td>' + esc(t.category) + '</td>' +
          '<td><span class="brick-badge ' + esc(t.status) + '">' + label(t.status) + '</span></td>' +
          '<td>' + day(t.created_at) + '</td></tr>';
      }).join('');

      body.innerHTML =
        '<div class="brick-help-toolbar"><span>내 문의 ' + Number(res.d.total || 0) + '건</span>' +
        '<button data-new>문의하기</button></div>' +
        (rows
          ? '<table><thead><tr><th>문의번호</th><th>제목</th><th>분류</th><th>상태</th><th>접수일</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="brick-faq-empty">문의 내역이 없습니다.</p>');

      body.querySelectorAll('[data-open]').forEach(function(a){
        a.addEventListener('click', function(e){ e.preventDefault(); showDetail(a.dataset.open); });
      });
      bindNew();
    });
  }

  function bindNew(){
    var btn = body.querySelector('[data-new]');
    if (btn) btn.addEventListener('click', showForm);
  }

  function showForm(){
    var opts = config.categories.map(function(c){
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    body.innerHTML =
      '<div class="brick-help-form">' +
      '<label>분류<select data-category>' + opts + '</select></label>' +
      '<label>제목<input type="text" data-title maxlength="300" /></label>' +
      '<label>내용<textarea data-content placeholder="문의 내용을 자세히 적어주세요."></textarea></label>' +
      (allowGuest
        ? '<label>이름<input type="text" data-guest-name /></label>' +
          '<label>이메일<input type="email" data-guest-email placeholder="답변을 받을 주소" /></label>' +
          '<label>조회용 비밀번호<input type="password" data-guest-pw placeholder="4자 이상" /></label>'
        : '') +
      '<div class="brick-help-toolbar"><span class="brick-help-msg" data-msg></span>' +
      '<span><button data-cancel style="background:var(--color-line, #e4e4ea);color:var(--color-text, #17171c);margin-right:8px">취소</button>' +
      '<button data-submit>등록</button></span></div></div>';

    body.querySelector('[data-cancel]').addEventListener('click', showList);
    body.querySelector('[data-submit]').addEventListener('click', function(){
      var msg = body.querySelector('[data-msg]');
      msg.textContent = '';
      var payload = {
        category: body.querySelector('[data-category]').value,
        title: body.querySelector('[data-title]').value,
        content: body.querySelector('[data-content]').value
      };
      var gn = body.querySelector('[data-guest-name]');
      if (gn) {
        payload.guestName = gn.value;
        payload.guestEmail = body.querySelector('[data-guest-email]').value;
        payload.guestPassword = body.querySelector('[data-guest-pw]').value;
      }
      json(API + '/tickets', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload)
      }).then(function(res){
        if (!res.ok) { msg.textContent = res.d.message || '등록에 실패했습니다.'; return; }
        alert('문의가 접수되었습니다. 문의번호: ' + res.d.ticketNo);
        showList();
      });
    });
  }

  function showDetail(id){
    json(API + '/tickets/' + id).then(function(res){
      if (!res.ok) { body.innerHTML = '<p class="brick-faq-empty">문의를 찾을 수 없습니다.</p>'; return; }
      var t = res.d.ticket;
      var thread = (res.d.replies || []).map(function(r){
        return '<div class="brick-thread-item' + (r.is_staff ? ' is-staff' : '') + '">' +
          '<b>' + esc(r.author_name) + (r.is_staff ? ' (운영자)' : '') + ' · ' + day(r.created_at) + '</b>' +
          esc(r.content) + '</div>';
      }).join('');

      body.innerHTML =
        '<div class="brick-help-toolbar"><span>' + esc(t.ticket_no) +
        ' <span class="brick-badge ' + esc(t.status) + '">' + label(t.status) + '</span></span>' +
        '<button data-back style="background:var(--color-line, #e4e4ea);color:var(--color-text, #17171c)">목록</button></div>' +
        '<h3 style="margin:0 0 10px">' + esc(t.title) + '</h3>' +
        '<div class="brick-thread"><div class="brick-thread-item"><b>' + esc(t.author_name) +
        ' · ' + day(t.created_at) + '</b>' + esc(t.content) + '</div>' + thread + '</div>' +
        (t.status === 'closed' || !res.d.canReply ? ''
          : '<div class="brick-help-form" style="margin-top:20px">' +
            '<label>추가 문의<textarea data-reply></textarea></label>' +
            '<div class="brick-help-toolbar"><span class="brick-help-msg" data-msg></span>' +
            '<button data-send>등록</button></div></div>');

      body.querySelector('[data-back]').addEventListener('click', showList);
      var send = body.querySelector('[data-send]');
      if (send) send.addEventListener('click', function(){
        var msg = body.querySelector('[data-msg]');
        json(API + '/tickets/' + id + '/replies', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({ content: body.querySelector('[data-reply]').value })
        }).then(function(res2){
          if (!res2.ok) { msg.textContent = res2.d.message || '등록에 실패했습니다.'; return; }
          showDetail(id);
        });
      });
    });
  }

  // 분류 목록을 먼저 받는다 — 폼이 열릴 때 이미 있어야 한다
  json(API + '/config').then(function(res){
    if (res.ok && res.d.categories) config = res.d;
    showList();
  });
})();
</script>`;
