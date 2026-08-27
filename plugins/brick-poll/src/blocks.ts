import { sql } from "drizzle-orm";
import type { PluginContext } from "@brick/plugin-sdk";
import { type Db } from "./poll.js";

/**
 * 설문 블록.
 *
 * **껍데기만 서버 렌더**한다. 질문과 선택지는 공개 정보지만
 * "내가 투표했는가"와 결과는 사람마다 다르다 — 렌더 캐시(비로그인 전용)에
 * 담기면 첫 방문자의 상태가 모두에게 보인다.
 *
 * 질문은 서버에서 낸다. 검색엔진이 읽어야 하고, JS 가 실패해도 무엇을 묻는
 * 설문인지는 보여야 한다.
 */
export function registerPollBlocks(ctx: PluginContext, db: Db): void {
  ctx.registerBlock({
    name: "poll",
    displayName: "설문조사",
    propsSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          title: "설문 slug",
          description: "비우면 진행 중인 가장 최근 설문을 보여줍니다",
        },
        showTotal: { type: "boolean", title: "참여자 수 표시", default: true },
      },
    },
    render: async (props, blockCtx) => {
      // 주소의 마지막 경로도 받는다 — /poll/<slug> 형태로 페이지를 만들 수 있다
      const slug = String(props.slug ?? blockCtx.pathTail?.replace(/^\/+/, "") ?? "");

      const { rows } = await db.execute(
        slug
          ? sql`
              SELECT id, slug, question, description, vote_count
              FROM poll_polls WHERE slug = ${slug} AND is_active = true LIMIT 1
            `
          : sql`
              SELECT id, slug, question, description, vote_count
              FROM poll_polls
              WHERE is_active = true
                AND (starts_at IS NULL OR starts_at <= now())
                AND (ends_at IS NULL OR ends_at >= now())
              ORDER BY created_at DESC LIMIT 1
            `,
      );
      const poll = rows[0];
      if (!poll) {
        return `<div class="brick-poll-empty">진행 중인 설문이 없습니다.</div>${POLL_CSS}`;
      }

      return `
<section class="brick-poll" data-slug="${escapeHtml(poll.slug)}">
  <h3 class="brick-poll-q">${escapeHtml(poll.question)}</h3>
  ${poll.description ? `<p class="brick-poll-desc">${escapeHtml(poll.description)}</p>` : ""}
  ${props.showTotal !== false ? `<p class="brick-poll-total" data-total>참여 ${Number(poll.vote_count)}명</p>` : ""}
  <div class="brick-poll-body"><p class="brick-poll-loading">불러오는 중…</p></div>
</section>${POLL_CSS}${POLL_SCRIPT}`;
    },
  });

  // ── 진행 중인 설문 목록 ───────────────────────────
  ctx.registerBlock({
    name: "poll-list",
    displayName: "설문 목록",
    propsSchema: {
      type: "object",
      properties: {
        limit: { type: "number", title: "표시 개수", default: 5 },
        title: { type: "string", title: "제목 (비우면 표시 안 함)" },
      },
    },
    render: async (props) => {
      const limit = Math.min(20, Math.max(1, Number(props.limit ?? 5)));
      const { rows } = await db.execute(sql`
        SELECT slug, question, vote_count, ends_at FROM poll_polls
        WHERE is_active = true
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at IS NULL OR ends_at >= now())
        ORDER BY created_at DESC LIMIT ${limit}
      `);
      if (!rows.length) {
        return `<div class="brick-poll-empty">진행 중인 설문이 없습니다.</div>${POLL_CSS}`;
      }
      const items = rows
        .map(
          (p) => `    <li>
      <a href="/poll/${encodeURIComponent(String(p.slug))}">${escapeHtml(p.question)}</a>
      <span>${Number(p.vote_count)}명</span>
    </li>`,
        )
        .join("\n");
      const heading = props.title
        ? `<h3 class="brick-poll-heading">${escapeHtml(props.title)}</h3>`
        : "";
      return `${heading}<ul class="brick-poll-list">\n${items}\n</ul>${POLL_CSS}`;
    },
  });
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

const POLL_CSS = `
<style>
.brick-poll{border:1px solid #e6e6ee;border-radius:12px;padding:20px 22px;margin:20px 0}
.brick-poll-q{margin:0 0 8px;font-size:17px;line-height:1.5}
.brick-poll-desc{margin:0 0 12px;color:#777;font-size:14px;line-height:1.6}
.brick-poll-total{margin:0 0 14px;color:#999;font-size:13px}
.brick-poll-loading,.brick-poll-empty{color:#999;font-size:14px;padding:12px 0;margin:0}
.brick-poll-empty{padding:30px;text-align:center;border:1px dashed #e6e6ee;border-radius:12px}
.brick-poll-opts{display:grid;gap:8px;margin:0 0 14px}
.brick-poll-opt{display:flex;align-items:center;gap:9px;padding:11px 13px;border:1px solid #e6e6ee;border-radius:8px;cursor:pointer;font-size:14px}
.brick-poll-opt:hover{border-color:var(--color-primary,#d0402c)}
.brick-poll-opt input{margin:0;flex:none}
.brick-poll-actions{display:flex;align-items:center;gap:10px}
.brick-poll-actions button{padding:11px 22px;border:0;border-radius:8px;background:var(--color-primary,#d0402c);color:#fff;font-weight:700;font-size:14px;cursor:pointer}
.brick-poll-actions button:disabled{opacity:.5;cursor:default}
.brick-poll-msg{font-size:13px;color:#b3261e}
.brick-poll-note{font-size:13px;color:#888;padding:10px 0;margin:0}
.brick-poll-comment{width:100%;min-height:70px;padding:11px;margin-bottom:12px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box;font:inherit}
/* 결과 */
.brick-poll-result{display:grid;gap:11px}
.brick-poll-row{font-size:14px}
.brick-poll-row-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:5px}
.brick-poll-row-head b{font-weight:600}
.brick-poll-row.is-mine b{color:var(--color-primary,#d0402c)}
.brick-poll-bar{height:9px;background:#eef0f5;border-radius:5px;overflow:hidden}
.brick-poll-bar i{display:block;height:100%;background:#c9cede;transition:width .3s}
.brick-poll-row.is-mine .brick-poll-bar i{background:var(--color-primary,#d0402c)}
.brick-poll-list{margin:12px 0;padding:0;list-style:none;display:grid;gap:8px}
.brick-poll-list li{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #f0f0f4;font-size:14px}
.brick-poll-list a{text-decoration:none;color:inherit}
.brick-poll-list span{color:#999;font-size:13px}
.brick-poll-heading{margin:8px 0;font-size:17px}
</style>`;

/**
 * 설문 클라이언트.
 *
 * 프레임워크 없이 쓴다 — 테마는 빌드를 타지 않으므로 어떤 테마에서도 동작해야 한다.
 * 서버가 준 데이터만 그리고 HTML 은 전부 이스케이프한다.
 */
const POLL_SCRIPT = `
<script>
(function(){
  var root = document.currentScript.parentNode.querySelector('.brick-poll');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  var API = '/api/plugins/brick-poll';
  var slug = root.dataset.slug;
  var body = root.querySelector('.brick-poll-body');

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function json(url, opts){
    return fetch(url, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        return { ok: r.ok, status: r.status, d: d };
      });
    });
  }

  function setTotal(n){
    var el = root.querySelector('[data-total]');
    if (el) el.textContent = '참여 ' + Number(n) + '명';
  }

  function renderResults(view){
    var rows = view.options.map(function(o){
      var pct = typeof o.percent === 'number' ? o.percent : 0;
      return '<div class="brick-poll-row' + (o.mine ? ' is-mine' : '') + '">' +
        '<div class="brick-poll-row-head"><b>' + esc(o.label) + (o.mine ? ' ✓' : '') + '</b>' +
        '<span>' + pct + '% (' + Number(o.voteCount || 0) + ')</span></div>' +
        '<div class="brick-poll-bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
    return '<div class="brick-poll-result">' + rows + '</div>';
  }

  function renderForm(view){
    var multiple = view.poll.allowMultiple;
    var type = multiple ? 'checkbox' : 'radio';
    var opts = view.options.map(function(o){
      return '<label class="brick-poll-opt">' +
        '<input type="' + type + '" name="poll-opt" value="' + esc(o.id) + '" />' +
        '<span>' + esc(o.label) + '</span></label>';
    }).join('');

    return '<div class="brick-poll-opts">' + opts + '</div>' +
      (view.poll.allowComment
        ? '<textarea class="brick-poll-comment" data-comment placeholder="기타 의견 (선택)"></textarea>'
        : '') +
      '<div class="brick-poll-actions"><button data-submit>투표하기</button>' +
      (multiple ? '<span class="brick-poll-note">최대 ' + view.poll.maxChoices + '개 선택</span>' : '') +
      '<span class="brick-poll-msg" data-msg></span></div>';
  }

  function paint(view){
    setTotal(view.poll.voteCount);

    // 투표할 수 없는 이유가 있으면 알려준다. 버튼만 비활성이면 사용자가 이유를 모른다.
    if (!view.poll.canVote) {
      var note = view.poll.blockedReason
        ? '<p class="brick-poll-note">' + esc(view.poll.blockedReason) + '</p>'
        : '';
      body.innerHTML = note + (view.showResults ? renderResults(view)
        : '<p class="brick-poll-note">결과는 ' +
          (view.poll.resultVisibility === 'after_close' ? '설문이 끝난 뒤' : '투표 후') +
          ' 공개됩니다.</p>');
      return;
    }

    body.innerHTML = renderForm(view);

    body.querySelector('[data-submit]').addEventListener('click', function(){
      var msg = body.querySelector('[data-msg]');
      var btn = body.querySelector('[data-submit]');
      msg.textContent = '';

      var picked = [].slice.call(body.querySelectorAll('input[name="poll-opt"]:checked'))
        .map(function(i){ return i.value; });
      if (!picked.length) { msg.textContent = '선택지를 골라주세요.'; return; }
      if (picked.length > view.poll.maxChoices) {
        msg.textContent = '최대 ' + view.poll.maxChoices + '개까지 선택할 수 있습니다.';
        return;
      }

      var commentEl = body.querySelector('[data-comment]');
      btn.disabled = true;
      json(API + '/polls/' + encodeURIComponent(slug) + '/vote', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({
          optionIds: picked,
          comment: commentEl ? commentEl.value : undefined
        })
      }).then(function(res){
        btn.disabled = false;
        if (!res.ok) { msg.textContent = res.d.message || '투표에 실패했습니다.'; return; }
        // 응답이 투표 후 상태를 함께 주므로 다시 요청하지 않는다
        paint(res.d);
      });
    });
  }

  json(API + '/polls/' + encodeURIComponent(slug)).then(function(res){
    if (!res.ok) { body.innerHTML = '<p class="brick-poll-note">설문을 불러올 수 없습니다.</p>'; return; }
    paint(res.d);
  });
})();
</script>`;
