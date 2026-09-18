import { sql } from "drizzle-orm";
import { CAPTCHA_WIDGET_CSS, CAPTCHA_WIDGET_JS, STACK_TABLE_CSS, captchaFieldHtml, type PluginContext } from "@brick/plugin-sdk";
import { escapeHtml, type Db, type HelpSettings } from "./types.js";
import { listCategories, listFaqs } from "./faq.js";
import { bindI18n, t } from "./i18n.js";

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
  bindI18n(ctx);
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
    <a href="?"${!category ? ' class="is-on"' : ""}>${escapeHtml(t("faq.all"))}</a>
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
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="${escapeHtml(t("faq.searchPlaceholder"))}" aria-label="${escapeHtml(t("faq.searchPlaceholder"))}" />
    <button type="submit">${escapeHtml(t("faq.searchBtn"))}</button>
  </form>`
          : "";

      if (!faqs.length) {
        const msg = escapeHtml(q ? t("faq.noResult", { q }) : t("faq.empty"));
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
        <span>${escapeHtml(t("faq.helpful"))}</span>
        <button type="button" data-rate="1">${escapeHtml(t("faq.yes"))}</button>
        <button type="button" data-rate="0">${escapeHtml(t("faq.no"))}</button>
        <em class="brick-faq-thanks" hidden>${escapeHtml(t("faq.thanks"))}</em>
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
  <h2 class="brick-help-title">${escapeHtml(props.title ?? t("help.title"))}</h2>
  <div class="brick-help-body"><p class="brick-faq-empty">${escapeHtml(t("help.loading"))}</p></div>
</section>${FAQ_CSS}${HELP_CSS}${helpScript()}`;
    },
  });
}

/* ── FAQ 스타일 ────────────────────────────────────── */
const FAQ_CSS = `
<style>
.brick-faq{margin:20px 0}
.brick-faq-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.brick-faq-tabs a{padding:7px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 20px);text-decoration:none;color:inherit;font-size:14px}
.brick-faq-tabs a.is-on{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent}
.brick-faq-tabs a span{opacity:.6;font-size:12px}
.brick-faq-search{display:flex;gap:8px;margin-bottom:20px}
.brick-faq-search input{flex:1;padding:11px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius, 8px);font:inherit}
.brick-faq-search button{padding:11px 20px;border:0;border-radius:var(--radius, 8px);background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);font-weight:700;cursor:pointer}
.brick-faq-empty{padding:40px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-faq-item{border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-faq-item summary{padding:16px 4px;cursor:pointer;font-weight:600;line-height:1.5}
.brick-faq-item summary::marker{color:var(--color-primary,#d0402c)}
.brick-faq-answer{padding:0 4px 16px;line-height:1.8;color:var(--color-text-soft, #45454f)}
.brick-faq-rate{display:flex;align-items:center;gap:8px;padding:0 4px 16px;font-size:13px;color:var(--color-muted, #6c6c7a)}
/* 40px — 폰에서 누르는 자리다. 26px 이었고 화면 감사가 "작은 터치 38x26" 으로 잡았다 */
.brick-faq-rate button{min-height:40px;padding:4px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 20px);background:var(--color-bg, #ffffff);font-size:13px;cursor:pointer}
.brick-faq-thanks{color:var(--color-primary,#d0402c);font-style:normal}
</style>`;

const HELP_CSS = `
<style>
.brick-help{margin:24px 0}
.brick-help-title{font-size:22px;margin:0 0 16px}
.brick-help-guest p{margin:0 0 14px}.brick-help-guest .brick-actions-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.brick-help-lookup{max-width:340px;margin:0 auto 22px;text-align:left}
.brick-help-lookup label{display:block;margin-bottom:10px;font-size:13.5px}
.brick-help-lookup input{width:100%;box-sizing:border-box;margin-top:4px;padding:9px 11px;font:inherit}
/* 44px — 폰에서 누르는 자리다 */
.brick-help-lookup button{width:100%;min-height:44px;cursor:pointer}
.brick-help-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}
.brick-help-toolbar button{padding:10px 18px;border:0;border-radius:var(--radius, 8px);background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);font-weight:700;cursor:pointer}
.brick-help table{width:100%;border-collapse:collapse;font-size:14px}
.brick-help th,.brick-help td{padding:12px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);text-align:left}
.brick-help th{color:var(--color-muted, #6c6c7a);font-weight:600;font-size:13px}
.brick-help td a{color:inherit;text-decoration:none;font-weight:600}
.brick-badge{font-size:11px;padding:2px 8px;border-radius:var(--radius-lg, 10px);font-weight:700}
.brick-badge.open{background:color-mix(in srgb, var(--color-danger, #c9342f) 13%, transparent);color:var(--color-danger, #c9342f)}
.brick-badge.answered{background:color-mix(in srgb, var(--color-success, #11795a) 14%, transparent);color:var(--color-success, #11795a)}
.brick-badge.closed{background:var(--color-bg-sunken, #eeeef3);color:var(--color-text-soft, #45454f)}
.brick-help-form{padding:20px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius-lg, 12px);margin-bottom:20px}
.brick-help-form label{display:block;font-size:14px;margin-bottom:10px}
.brick-help-form input,.brick-help-form select,.brick-help-form textarea{width:100%;padding:11px;margin-top:4px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius, 8px);box-sizing:border-box;font:inherit}
.brick-help-form textarea{min-height:140px}
.brick-help-msg{font-size:13px;color:var(--color-danger, #c9342f);min-height:18px}
.brick-thread{margin-top:20px;display:grid;gap:14px}
.brick-thread-item{padding:16px;border-radius:var(--radius-lg, 10px);background:var(--color-bg-soft, #f6f6f9);white-space:pre-wrap;line-height:1.7}
.brick-thread-item.is-staff{background:color-mix(in srgb, var(--color-primary, #cf4437) 9%, transparent);border-left:3px solid var(--color-primary,#d0402c)}
.brick-thread-item b{display:block;font-size:13px;margin-bottom:6px;color:var(--color-text-soft, #45454f)}
${CAPTCHA_WIDGET_CSS}
/* 목록 표는 폰에서 카드로 접는다 — 맨 뒤에 와야 위의 너비 규칙을 덮는다 */
${STACK_TABLE_CSS}
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
/* 함수다 — 모듈 최상단에서 굳으면 bindI18n 보다 먼저 평가된다 */
const guestCaptchaHtml = () => captchaFieldHtml({
  label: t("captcha.label"),
  reload: t("captcha.reload"),
  placeholder: t("captcha.placeholder"),
});

const helpScript = () => `
<script>
${CAPTCHA_WIDGET_JS}
(function(){
  var root = document.currentScript.parentNode.querySelector('.brick-help');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  var body = root.querySelector('.brick-help-body');
  var API = '/api/plugins/brick-helpdesk';
  var allowGuest = root.dataset.allowGuest === '1';
  // 비회원 문의는 캡차를 요구한다 — 문의 한 건마다 운영자에게 메일이 나간다
  var isGuest = root.dataset.guest === '1';
  var config = { categories: [${JSON.stringify(t("help.defaultCategory"))}] };

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function day(s){ return String(s||'').slice(0,10); }
  function label(s){ return s === 'answered' ? ${JSON.stringify(t("help.statusAnswered"))} : s === 'closed' ? ${JSON.stringify(t("help.statusClosed"))} : ${JSON.stringify(t("help.statusOpen"))}; }

  function json(url, opts){
    return fetch(url, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        return { ok: r.ok, status: r.status, d: d };
      });
    });
  }

  /*
   * 비회원에게는 **조회 폼**이 있어야 한다.
   *
   * 문의를 남길 때 이름·이메일과 함께 "조회용 비밀번호" 를 받아 놓고, 접수 뒤에는
   * 문의번호를 알려 준 다음 이 화면이 "문의 내역을 보려면 로그인해주세요" 라고만
   * 했다. 조회 경로(by-no + pw)는 서버에 처음부터 있었는데 그것을 쓰는 자리가
   * 없어서, 비회원은 받아 적은 번호와 비밀번호를 쓸 곳이 없었다.
   */
  function guestView(){
    var next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML = '<div class="brick-empty brick-help-guest">' +
      (allowGuest
        ? '<form class="brick-help-lookup"><p>' + ${JSON.stringify(t("help.lookupIntro"))} + '</p>' +
          '<label>' + ${JSON.stringify(t("help.colNo"))} + '<input type="text" data-look-no required placeholder="H20260101-00001" /></label>' +
          '<label>' + ${JSON.stringify(t("help.lookupPw"))} + '<input type="password" data-look-pw required /></label>' +
          '<button class="brick-btn brick-btn-primary" type="submit">' + ${JSON.stringify(t("help.lookupBtn"))} + '</button>' +
          '<span class="brick-help-msg" role="alert" data-look-msg></span></form>'
        : '') +
      '<p>' + ${JSON.stringify(t("help.loginIntro"))} +
      (allowGuest ? ' ' + ${JSON.stringify(t("help.guestAlso"))} : '') + '</p>' +
      '<div class="brick-actions-row"><a class="brick-btn brick-btn-primary" href="/login?next=' + next + '">' + ${JSON.stringify(t("help.login"))} + '</a>' +
      (allowGuest ? '<button type="button" class="brick-btn" data-new>' + ${JSON.stringify(t("help.new"))} + '</button>' : '') + '</div></div>';
    bindNew();

    var form = body.querySelector('.brick-help-lookup');
    if (!form) return;
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var msg = form.querySelector('[data-look-msg]');
      var no = form.querySelector('[data-look-no]').value.trim();
      var pw = form.querySelector('[data-look-pw]').value;
      msg.textContent = '';
      json(API + '/tickets/by-no/' + encodeURIComponent(no) + '?pw=' + encodeURIComponent(pw))
        .then(function(res){
          // 있는 번호인지 알려주지 않는다 — 번호는 순차적이다
          if (!res.ok) { msg.textContent = res.d.message || ${JSON.stringify(t("help.lookupFail"))}; return; }
          guestPw = pw;
          showDetail(res.d.ticket.id);
        });
    });
  }

  function showList(){
    if (root.dataset.guest === '1') { guestView(); return; }
    json(API + '/my/tickets').then(function(res){
      if (res.status === 401) { guestView(); return; }
      if (!res.ok) { body.innerHTML = '<p class="brick-faq-empty">' + ${JSON.stringify(t("help.loadFail"))} + '</p>'; return; }

      /* 칸 이름은 머리글과 접힌 카드의 제목(data-label)에 같이 쓴다 */
      var C_NO = ${JSON.stringify(t("help.colNo"))};
      var C_TITLE = ${JSON.stringify(t("help.colTitle"))};
      var C_CAT = ${JSON.stringify(t("help.colCategory"))};
      var C_STATUS = ${JSON.stringify(t("help.colStatus"))};
      var C_DATE = ${JSON.stringify(t("help.colDate"))};
      var rows = (res.d.items || []).map(function(t){
        return '<tr><td data-label="' + C_NO + '">' + esc(t.ticket_no) + '</td>' +
          '<td data-label="' + C_TITLE + '"><a href="#" data-open="' + esc(t.id) + '">' + esc(t.title) + '</a></td>' +
          '<td data-label="' + C_CAT + '">' + esc(t.category) + '</td>' +
          '<td data-label="' + C_STATUS + '"><span class="brick-badge ' + esc(t.status) + '">' + label(t.status) + '</span></td>' +
          '<td data-label="' + C_DATE + '">' + day(t.created_at) + '</td></tr>';
      }).join('');

      body.innerHTML =
        '<div class="brick-help-toolbar"><span>' + ${JSON.stringify(t("help.myCount"))}.replace('{n}', Number(res.d.total || 0)) + '</span>' +
        '<button data-new>' + ${JSON.stringify(t("help.new"))} + '</button></div>' +
        (rows
          ? '<table class="brick-stack-table"><thead><tr><th>' + C_NO + '</th><th>' + C_TITLE + '</th><th>' + C_CAT + '</th><th>' + C_STATUS + '</th><th>' + C_DATE + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="brick-faq-empty">' + ${JSON.stringify(t("help.empty"))} + '</p>');

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
      '<label>' + ${JSON.stringify(t("help.colCategory"))} + '<select data-category>' + opts + '</select></label>' +
      '<label>' + ${JSON.stringify(t("help.colTitle"))} + '<input type="text" data-title maxlength="300" /></label>' +
      '<label>' + ${JSON.stringify(t("help.fieldContent"))} + '<textarea data-content placeholder="' + ${JSON.stringify(t("help.contentPlaceholder"))} + '"></textarea></label>' +
      (allowGuest
        ? '<label>' + ${JSON.stringify(t("help.fieldName"))} + '<input type="text" data-guest-name /></label>' +
          '<label>' + ${JSON.stringify(t("help.fieldEmail"))} + '<input type="email" data-guest-email placeholder="' + ${JSON.stringify(t("help.emailPlaceholder"))} + '" /></label>' +
          '<label>' + ${JSON.stringify(t("help.lookupPw"))} + '<input type="password" data-guest-pw placeholder="' + ${JSON.stringify(t("help.pwPlaceholder"))} + '" /></label>'
        : '') +
      (isGuest ? ${JSON.stringify(guestCaptchaHtml())} : '') +
      '<div class="brick-help-toolbar"><span class="brick-help-msg" data-msg></span>' +
      '<span><button data-cancel style="background:var(--color-line, #e4e4ea);color:var(--color-text, #17171c);margin-right:8px">' + ${JSON.stringify(t("common.cancel"))} + '</button>' +
      '<button data-submit>' + ${JSON.stringify(t("common.submit"))} + '</button></span></div></div>';

    window.brickCaptcha.attach(body);
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
      var cap = window.brickCaptcha.of(body);
      Object.keys(cap.fields).forEach(function(k){ payload[k] = cap.fields[k]; });
      json(API + '/tickets', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload)
      }).then(function(res){
        // 토큰은 1회용이므로 실패하면 새 문제를 받아야 한다
        if (!res.ok) { cap.reload(); msg.textContent = res.d.message || ${JSON.stringify(t("help.submitFail"))}; return; }
        alert(${JSON.stringify(t("help.created"))}.replace('{no}', res.d.ticketNo));
        showList();
      });
    });
  }

  /** 비회원이 방금 입력한 조회 비밀번호 — 상세·답변에 함께 보낸다 */
  var guestPw = '';

  function showDetail(id){
    json(API + '/tickets/' + id + (guestPw ? '?pw=' + encodeURIComponent(guestPw) : '')).then(function(res){
      if (!res.ok) { body.innerHTML = '<p class="brick-faq-empty">' + ${JSON.stringify(t("help.notFound"))} + '</p>'; return; }
      var t = res.d.ticket;
      var thread = (res.d.replies || []).map(function(r){
        return '<div class="brick-thread-item' + (r.is_staff ? ' is-staff' : '') + '">' +
          '<b>' + esc(r.author_name) + (r.is_staff ? ' (' + ${JSON.stringify(t("help.staff"))} + ')' : '') + ' · ' + day(r.created_at) + '</b>' +
          esc(r.content) + '</div>';
      }).join('');

      body.innerHTML =
        '<div class="brick-help-toolbar"><span>' + esc(t.ticket_no) +
        ' <span class="brick-badge ' + esc(t.status) + '">' + label(t.status) + '</span></span>' +
        '<button data-back style="background:var(--color-line, #e4e4ea);color:var(--color-text, #17171c)">' + ${JSON.stringify(t("help.back"))} + '</button></div>' +
        '<h3 style="margin:0 0 10px">' + esc(t.title) + '</h3>' +
        '<div class="brick-thread"><div class="brick-thread-item"><b>' + esc(t.author_name) +
        ' · ' + day(t.created_at) + '</b>' + esc(t.content) + '</div>' + thread + '</div>' +
        (t.status === 'closed' || !res.d.canReply ? ''
          : '<div class="brick-help-form" style="margin-top:20px">' +
            '<label>' + ${JSON.stringify(t("help.reply"))} + '<textarea data-reply></textarea></label>' +
            '<div class="brick-help-toolbar"><span class="brick-help-msg" data-msg></span>' +
            '<button data-send>' + ${JSON.stringify(t("common.submit"))} + '</button></div></div>');

      body.querySelector('[data-back]').addEventListener('click', function(){ showList(); });
      var send = body.querySelector('[data-send]');
      if (send) send.addEventListener('click', function(){
        var msg = body.querySelector('[data-msg]');
        json(API + '/tickets/' + id + '/replies', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({
            content: body.querySelector('[data-reply]').value,
            // 비회원은 세션이 없다 — 이것이 없으면 답변 칸이 보이는데 눌러도 403 이다
            pw: guestPw || undefined,
          })
        }).then(function(res2){
          if (!res2.ok) { msg.textContent = res2.d.message || ${JSON.stringify(t("help.submitFail"))}; return; }
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
