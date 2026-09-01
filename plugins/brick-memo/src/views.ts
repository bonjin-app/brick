/**
 * 쪽지 화면 — 받은함 / 보낸함 / 읽기 / 쓰기.
 *
 * 게시판과 같은 방식으로 페이지 하나(slug "memo")가 pathTail로 화면을 나눈다:
 *   ""       → 받은함
 *   "sent"   → 보낸함
 *   "write"  → 쓰기
 *   "blocks" → 차단 목록
 *   "<uuid>" → 읽기
 *
 * 목록·본문은 로그인 사용자별 내용이므로 서버 렌더 캐시가 적용되지 않는다
 * (코어가 로그인 요청을 캐시하지 않는다 — ADR-24).
 */
import { t } from "./i18n.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoView = "inbox" | "sent" | "read" | "write" | "blocks";

export function resolveMemoView(pathTail: string): { view: MemoView; memoId?: string } {
  const tail = pathTail.replace(/^\/+|\/+$/g, "");
  if (!tail) return { view: "inbox" };
  if (tail === "sent") return { view: "sent" };
  if (tail === "write") return { view: "write" };
  if (tail === "blocks") return { view: "blocks" };
  if (UUID_RE.test(tail)) return { view: "read", memoId: tail };
  return { view: "inbox" };
}

/**
 * 쪽지 화면의 껍데기.
 *
 * 내용은 클라이언트가 API로 채운다. 서버 렌더에 담지 않는 이유:
 * 쪽지는 사적인 내용이므로 HTML에 박아 두면 캐시·프록시·브라우저 이력에
 * 남을 위험이 커진다. 껍데기만 서버가 내고 본문은 인증된 요청으로만 가져온다.
 */
export function renderMemoShell(
  view: MemoView,
  memoId: string | undefined,
  loggedIn: boolean,
  /** 이 블록이 놓인 페이지의 기준 경로 — '/memo' 하드코딩이면 다른 slug 에서 깨진다 */
  base: string,
): string {
  if (!loggedIn) {
    return `<div class="brick-memo">
  <div class="brick-memo-head"><h2>${t("memo.title")}</h2></div>
  <p class="brick-memo-empty">${t("memo.loginRequired")} <a href="/login">${t("memo.login")}</a></p>
</div>`;
  }

  const tab = (key: MemoView, label: string, href: string) =>
    `<a href="${href}"${view === key ? ' class="is-active"' : ""}>${label}</a>`;

  return `<div class="brick-memo" data-memo-view="${view}" data-memo-base="${base}"${memoId ? ` data-memo-id="${memoId}"` : ""}>
  <div class="brick-memo-head">
    <h2>${t("memo.title")}</h2>
    <nav class="brick-memo-tabs">
      ${tab("inbox", t("memo.tabInbox"), base)}
      ${tab("sent", t("memo.tabSent"), `${base}/sent`)}
      ${tab("blocks", t("memo.tabBlocks"), `${base}/blocks`)}
      <a class="brick-memo-write-btn" href="${base}/write">${t("memo.write")}</a>
    </nav>
  </div>
  <div class="brick-memo-body" aria-live="polite">
    <p class="brick-memo-empty">${t("memo.loading")}</p>
  </div>
</div>`;
}

/** 쪽지 화면 스타일 — 테마가 빌드를 타지 않으므로 블록이 함께 낸다 */
export const MEMO_CSS = `
<style>
.brick-memo{margin:20px 0}
.brick-memo-head{border-bottom:2px solid var(--color-text,#1a1a1a);padding-bottom:10px;margin-bottom:6px}
.brick-memo-head h2{margin:0 0 10px;font-size:22px}
.brick-memo-tabs{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.brick-memo-tabs a{padding:6px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:16px;text-decoration:none;color:inherit;font-size:13.5px}
.brick-memo-tabs a.is-active{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent}
.brick-memo-write-btn{margin-left:auto;background:var(--color-primary, #cf4437);color:var(--color-on-primary, #ffffff)!important;border-color:transparent!important;font-weight:600}
.brick-memo-empty{padding:40px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-memo-table{width:100%;border-collapse:collapse;font-size:14px}
.brick-memo-table th{padding:10px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);color:var(--color-text-soft, #45454f);font-weight:600;font-size:13px;text-align:left}
.brick-memo-table td{padding:12px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);vertical-align:top}
.brick-memo-table tr.is-unread td{background:color-mix(in srgb, var(--color-warning, #96610a) 10%, transparent)}
.brick-memo-table a{color:inherit;text-decoration:none}
.brick-memo-table a:hover{text-decoration:underline}
.brick-memo-who{width:130px;color:var(--color-text-soft, #45454f)}
.brick-memo-date{width:110px;color:var(--color-muted, #6c6c7a);font-size:13px}
.brick-memo-actions{width:60px;text-align:right}
.brick-memo-actions button,.brick-memo-row-btn{border:none;background:none;color:var(--color-muted, #6c6c7a);cursor:pointer;font-size:12.5px;padding:2px 4px}
.brick-memo-actions button:hover{color:crimson}
.brick-unread-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-primary,#d0402c);margin-right:5px;vertical-align:middle}
.brick-memo-detail{padding:4px 0}
.brick-memo-detail-head{display:flex;gap:12px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--color-line, #e4e4ea);flex-wrap:wrap}
.brick-memo-detail-head strong{font-size:15px}
.brick-memo-detail-head time{color:var(--color-muted, #6c6c7a);font-size:13px}
.brick-memo-content{padding:20px 0;line-height:1.8;white-space:pre-wrap;word-break:break-word;min-height:80px}
.brick-memo-detail-foot{display:flex;gap:8px;padding-top:14px;border-top:1px solid var(--color-line, #e4e4ea);flex-wrap:wrap}
.brick-memo-detail-foot a,.brick-memo-detail-foot button{padding:8px 16px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);text-decoration:none;color:inherit;cursor:pointer;font-size:14px}
.brick-memo-form{margin-top:18px;max-width:620px}
.brick-memo-field{display:block;margin-bottom:14px;font-size:14px}
.brick-memo-field input,.brick-memo-field textarea{width:100%;padding:10px;margin-top:4px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px}
.brick-memo-field textarea{min-height:180px;line-height:1.7}
.brick-memo-hint{color:var(--color-muted, #6c6c7a);font-size:12.5px;margin-top:4px}
.brick-memo-suggest{border:1px solid var(--color-line, #e4e4ea);border-radius:6px;margin-top:4px;max-height:180px;overflow-y:auto}
.brick-memo-suggest button{display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;cursor:pointer;font-size:13.5px;border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-memo-suggest button:hover{background:var(--color-bg-soft, #f6f6f9)}
.brick-memo-msg{min-height:20px;font-size:14px;margin:8px 0}
.brick-memo-submit{padding:11px 26px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:15px}
.brick-memo-cost{color:var(--color-text-soft, #45454f);font-size:13px;margin-left:10px}
@media(max-width:640px){
  .brick-memo-date{display:none}
  .brick-memo-who{width:90px}
}
</style>`;

/**
 * 클라이언트 스크립트.
 * 순수 JS — 테마가 빌드를 타지 않으므로 프레임워크를 쓸 수 없다.
 */
export const memoScript = () => `
<script>
(function () {
  var root = document.querySelector('.brick-memo[data-memo-view]');
  if (!root) return;
  var API = '/api/plugins/brick-memo';
  var body = root.querySelector('.brick-memo-body');
  var view = root.dataset.memoView;
  var memoId = root.dataset.memoId || '';
  var base = root.dataset.memoBase || '/memo';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function req(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }
  function send(url, bodyObj, method) {
    return req(url, {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
  }
  function fmtDate(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return sameDay ? p(d.getHours()) + ':' + p(d.getMinutes())
                   : (d.getMonth() + 1) + '.' + d.getDate();
  }
  function fullDate(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fail(msg) { body.innerHTML = '<p class="brick-memo-empty">' + esc(msg) + '</p>'; }

  /* ── 목록 (받은/보낸) ─────────────────────────────── */
  function renderList(kind) {
    req(API + '/' + (kind === 'sent' ? 'sent' : 'inbox')).then(function (res) {
      if (!res.ok) return fail(res.data.message || ${JSON.stringify(t("memo.loadFail"))});
      var items = res.data.items || [];
      if (!items.length) {
        body.innerHTML = '<p class="brick-memo-empty">' +
          (kind === 'sent' ? ${JSON.stringify(t("memo.emptySent"))} : ${JSON.stringify(t("memo.emptyInbox"))}) + '</p>';
        return;
      }
      var isSent = kind === 'sent';
      var rows = items.map(function (m) {
        var unread = !isSent && !m.is_read;
        var who = isSent ? (m.receiver_name || ${JSON.stringify(t("memo.withdrawn"))}) : (m.sender_name || ${JSON.stringify(t("memo.withdrawn"))});
        return '<tr class="' + (unread ? 'is-unread' : '') + '" data-id="' + esc(m.id) + '">' +
          '<td class="brick-memo-who">' + (unread ? '<span class="brick-unread-dot"></span>' : '') + esc(who) + '</td>' +
          '<td><a href="' + base + '/' + esc(m.id) + '">' + esc(m.preview || ${JSON.stringify(t("memo.noContent"))}) + '</a>' +
          (isSent ? '<span class="brick-memo-hint">' + (m.is_read ? ${JSON.stringify(t("memo.read"))} : ${JSON.stringify(t("memo.unread"))}) + '</span>' : '') +
          '</td>' +
          '<td class="brick-memo-date">' + fmtDate(m.created_at) + '</td>' +
          '<td class="brick-memo-actions"><button type="button" data-del="' + esc(m.id) + '">' + ${JSON.stringify(t("memo.delete"))} + '</button></td>' +
          '</tr>';
      }).join('');

      body.innerHTML =
        (!isSent && res.data.unread > 0
          ? '<p class="brick-memo-hint">' + ${JSON.stringify(t("memo.unreadCount", { n: "__N__" }))}.replace('__N__', res.data.unread) + ' ' +
            '<button type="button" class="brick-memo-row-btn" data-read-all>' + ${JSON.stringify(t("memo.markAllRead"))} + '</button></p>'
          : '') +
        '<table class="brick-memo-table"><thead><tr>' +
        '<th class="brick-memo-who">' + (isSent ? ${JSON.stringify(t("memo.colTo"))} : ${JSON.stringify(t("memo.colFrom"))}) + '</th>' +
        '<th>' + ${JSON.stringify(t("memo.colContent"))} + '</th><th class="brick-memo-date">' + ${JSON.stringify(t("memo.colDate"))} + '</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';

      body.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm(${JSON.stringify(t("memo.deleteConfirm"))})) return;
          send(API + '/' + btn.dataset.del, null, 'DELETE').then(function (r) {
            if (!r.ok) { alert(r.data.message || ${JSON.stringify(t("memo.deleteFail"))}); return; }
            renderList(kind);
          });
        });
      });
      var readAll = body.querySelector('[data-read-all]');
      if (readAll) {
        readAll.addEventListener('click', function () {
          send(API + '/read-all').then(function () { renderList(kind); });
        });
      }
    });
  }

  /* ── 읽기 ──────────────────────────────────────────── */
  function renderRead() {
    req(API + '/' + memoId).then(function (res) {
      if (!res.ok) return fail(res.data.message || ${JSON.stringify(t("memo.memoLoadFail"))});
      var m = res.data.memo;
      var isReceiver = res.data.role === 'receiver';
      var who = isReceiver ? (m.sender_name || ${JSON.stringify(t("memo.withdrawn"))}) : (m.receiver_name || ${JSON.stringify(t("memo.withdrawn"))});
      body.innerHTML =
        '<div class="brick-memo-detail">' +
        '<div class="brick-memo-detail-head">' +
        '<strong>' + (isReceiver ? ${JSON.stringify(t("memo.colFrom"))} : ${JSON.stringify(t("memo.colTo"))}) + ': ' + esc(who) + '</strong>' +
        '<time>' + fullDate(m.created_at) + '</time>' +
        (!isReceiver ? '<span class="brick-memo-hint">' + (m.is_read ? ${JSON.stringify(t("memo.read"))} : ${JSON.stringify(t("memo.unread"))}) + '</span>' : '') +
        '</div>' +
        '<div class="brick-memo-content">' + esc(m.content) + '</div>' +
        '<div class="brick-memo-detail-foot">' +
        '<a href="' + base + (isReceiver ? '' : '/sent') + '">' + ${JSON.stringify(t("memo.list"))} + '</a>' +
        (isReceiver && m.sender_id
          ? '<a href="' + base + '/write?to=' + encodeURIComponent(m.sender_id) + '">' + ${JSON.stringify(t("memo.reply"))} + '</a>' +
            '<button type="button" data-block="' + esc(m.sender_id) + '">' + ${JSON.stringify(t("memo.block"))} + '</button>'
          : '') +
        '<button type="button" data-del-one>' + ${JSON.stringify(t("memo.delete"))} + '</button>' +
        '</div></div>';

      body.querySelector('[data-del-one]').addEventListener('click', function () {
        if (!confirm(${JSON.stringify(t("memo.deleteConfirm"))})) return;
        send(API + '/' + memoId, null, 'DELETE').then(function (r) {
          if (!r.ok) { alert(r.data.message || ${JSON.stringify(t("memo.deleteFail"))}); return; }
          location.href = base + (isReceiver ? '' : '/sent');
        });
      });
      var blockBtn = body.querySelector('[data-block]');
      if (blockBtn) {
        blockBtn.addEventListener('click', function () {
          if (!confirm(${JSON.stringify(t("memo.blockConfirm"))})) return;
          send(API + '/blocks/' + blockBtn.dataset.block).then(function (r) {
            alert(r.ok ? ${JSON.stringify(t("memo.blocked"))} : (r.data.message || ${JSON.stringify(t("memo.blockFail"))}));
          });
        });
      }
    });
  }

  /* ── 쓰기 ──────────────────────────────────────────── */
  function renderWrite() {
    var params = new URLSearchParams(location.search);
    var to = params.get('to') || '';

    body.innerHTML =
      '<form class="brick-memo-form">' +
      '<label class="brick-memo-field">' + ${JSON.stringify(t("memo.colTo"))} + '' +
      '<input name="receiver" placeholder="' + ${JSON.stringify(t("memo.searchPlaceholder"))} + '" autocomplete="off" required />' +
      '</label>' +
      '<div class="brick-memo-suggest" hidden></div>' +
      '<input type="hidden" name="receiverId" value="' + esc(to) + '" />' +
      '<label class="brick-memo-field">' + ${JSON.stringify(t("memo.content"))} + '' +
      '<textarea name="content" required placeholder="' + ${JSON.stringify(t("memo.contentPlaceholder"))} + '"></textarea>' +
      '</label>' +
      '<p class="brick-memo-msg" role="status"></p>' +
      '<div><button type="submit" class="brick-memo-submit">' + ${JSON.stringify(t("memo.send"))} + '</button>' +
      '<span class="brick-memo-cost" data-cost></span></div>' +
      '</form>';

    var form = body.querySelector('.brick-memo-form');
    var input = form.querySelector('input[name=receiver]');
    var hidden = form.querySelector('input[name=receiverId]');
    var suggest = body.querySelector('.brick-memo-suggest');
    var msgEl = form.querySelector('.brick-memo-msg');

    // 발송 비용 안내 — 정책이 있으면 미리 보여준다
    req(API + '/cost').then(function (r) {
      if (r.ok && r.data.sendPoint > 0) {
        body.querySelector('[data-cost]').textContent =
          ${JSON.stringify(t("memo.costNote", { n: "__N__" }))}.replace('__N__', r.data.sendPoint.toLocaleString('ko-KR'));
      }
    });

    var timer = null;
    input.addEventListener('input', function () {
      hidden.value = '';
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { suggest.hidden = true; return; }
      timer = setTimeout(function () {
        req(API + '/recipients/search?q=' + encodeURIComponent(q)).then(function (r) {
          var items = (r.data && r.data.items) || [];
          if (!items.length) { suggest.hidden = true; return; }
          suggest.innerHTML = items.map(function (u) {
            return '<button type="button" data-uid="' + esc(u.id) + '" data-name="' + esc(u.display_name) + '">' +
              esc(u.display_name) + ' <span class="brick-memo-hint">' + esc(u.email_masked) + '</span></button>';
          }).join('');
          suggest.hidden = false;
          suggest.querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
              hidden.value = b.dataset.uid;
              input.value = b.dataset.name;
              suggest.hidden = true;
            });
          });
        });
      }, 250);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      var payload = { content: form.querySelector('textarea[name=content]').value };
      if (hidden.value) payload.receiverId = hidden.value;
      else payload.receiverEmail = input.value.trim();

      btn.disabled = true;
      msgEl.textContent = ${JSON.stringify(t("memo.sending"))};
      msgEl.style.color = 'var(--color-text-soft, #45454f)';
      send(API, payload).then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          msgEl.textContent = r.data.message || ${JSON.stringify(t("memo.sendFail"))};
          msgEl.style.color = 'var(--color-danger, #c9342f)';
          return;
        }
        msgEl.style.color = 'var(--color-success, #11795a)';
        msgEl.textContent = ${JSON.stringify(t("memo.sentTo", { name: "__NAME__" }))}.replace('__NAME__', r.data.receiverName || '');
        setTimeout(function () { location.href = base + '/sent'; }, 700);
      });
    });
  }

  /* ── 차단 목록 ─────────────────────────────────────── */
  function renderBlocks() {
    req(API + '/blocks/list').then(function (res) {
      if (!res.ok) return fail(res.data.message || ${JSON.stringify(t("memo.loadFail"))});
      var items = res.data.items || [];
      if (!items.length) {
        body.innerHTML = '<p class="brick-memo-empty">' + ${JSON.stringify(t("memo.emptyBlocks"))} + '</p>';
        return;
      }
      body.innerHTML = '<table class="brick-memo-table"><thead><tr>' +
        '<th>' + ${JSON.stringify(t("memo.colMember"))} + '</th><th class="brick-memo-date">' + ${JSON.stringify(t("memo.colBlockedAt"))} + '</th><th></th></tr></thead><tbody>' +
        items.map(function (b) {
          return '<tr><td>' + esc(b.display_name) + '</td>' +
            '<td class="brick-memo-date">' + fmtDate(b.created_at) + '</td>' +
            '<td class="brick-memo-actions"><button type="button" data-unblock="' + esc(b.blocked_id) + '">' + ${JSON.stringify(t("memo.unblock"))} + '</button></td></tr>';
        }).join('') + '</tbody></table>';

      body.querySelectorAll('[data-unblock]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          send(API + '/blocks/' + btn.dataset.unblock, null, 'DELETE').then(renderBlocks);
        });
      });
    });
  }

  if (view === 'inbox') renderList('inbox');
  else if (view === 'sent') renderList('sent');
  else if (view === 'read') renderRead();
  else if (view === 'write') renderWrite();
  else if (view === 'blocks') renderBlocks();
})();
</script>`;
