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
export function renderMemoShell(view: MemoView, memoId: string | undefined, loggedIn: boolean): string {
  if (!loggedIn) {
    return `<div class="brick-memo">
  <div class="brick-memo-head"><h2>쪽지</h2></div>
  <p class="brick-memo-empty">쪽지는 로그인 후 이용할 수 있습니다. <a href="/login">로그인</a></p>
</div>`;
  }

  const tab = (key: MemoView, label: string, href: string) =>
    `<a href="${href}"${view === key ? ' class="is-active"' : ""}>${label}</a>`;

  return `<div class="brick-memo" data-memo-view="${view}"${memoId ? ` data-memo-id="${memoId}"` : ""}>
  <div class="brick-memo-head">
    <h2>쪽지</h2>
    <nav class="brick-memo-tabs">
      ${tab("inbox", "받은 쪽지", "/memo")}
      ${tab("sent", "보낸 쪽지", "/memo/sent")}
      ${tab("blocks", "차단 목록", "/memo/blocks")}
      <a class="brick-memo-write-btn" href="/memo/write">쪽지 쓰기</a>
    </nav>
  </div>
  <div class="brick-memo-body" aria-live="polite">
    <p class="brick-memo-empty">불러오는 중…</p>
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
.brick-memo-tabs a{padding:6px 14px;border:1px solid #e3e3ea;border-radius:16px;text-decoration:none;color:inherit;font-size:13.5px}
.brick-memo-tabs a.is-active{background:var(--color-primary,#d0402c);color:#fff;border-color:transparent}
.brick-memo-write-btn{margin-left:auto;background:#1e1e2e;color:#fff!important;border-color:transparent!important;font-weight:600}
.brick-memo-empty{padding:40px;text-align:center;color:#999}
.brick-memo-table{width:100%;border-collapse:collapse;font-size:14px}
.brick-memo-table th{padding:10px 8px;border-bottom:1px solid #ddd;color:#666;font-weight:600;font-size:13px;text-align:left}
.brick-memo-table td{padding:12px 8px;border-bottom:1px solid #f0f0f4;vertical-align:top}
.brick-memo-table tr.is-unread td{background:#fffdf7}
.brick-memo-table a{color:inherit;text-decoration:none}
.brick-memo-table a:hover{text-decoration:underline}
.brick-memo-who{width:130px;color:#555}
.brick-memo-date{width:110px;color:#999;font-size:13px}
.brick-memo-actions{width:60px;text-align:right}
.brick-memo-actions button,.brick-memo-row-btn{border:none;background:none;color:#999;cursor:pointer;font-size:12.5px;padding:2px 4px}
.brick-memo-actions button:hover{color:crimson}
.brick-unread-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-primary,#d0402c);margin-right:5px;vertical-align:middle}
.brick-memo-detail{padding:4px 0}
.brick-memo-detail-head{display:flex;gap:12px;align-items:baseline;padding:14px 0;border-bottom:1px solid #eee;flex-wrap:wrap}
.brick-memo-detail-head strong{font-size:15px}
.brick-memo-detail-head time{color:#aaa;font-size:13px}
.brick-memo-content{padding:20px 0;line-height:1.8;white-space:pre-wrap;word-break:break-word;min-height:80px}
.brick-memo-detail-foot{display:flex;gap:8px;padding-top:14px;border-top:1px solid #eee;flex-wrap:wrap}
.brick-memo-detail-foot a,.brick-memo-detail-foot button{padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;text-decoration:none;color:inherit;cursor:pointer;font-size:14px}
.brick-memo-form{margin-top:18px;max-width:620px}
.brick-memo-field{display:block;margin-bottom:14px;font-size:14px}
.brick-memo-field input,.brick-memo-field textarea{width:100%;padding:10px;margin-top:4px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px}
.brick-memo-field textarea{min-height:180px;line-height:1.7}
.brick-memo-hint{color:#999;font-size:12.5px;margin-top:4px}
.brick-memo-suggest{border:1px solid #e3e3ea;border-radius:6px;margin-top:4px;max-height:180px;overflow-y:auto}
.brick-memo-suggest button{display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;cursor:pointer;font-size:13.5px;border-bottom:1px solid #f4f4f7}
.brick-memo-suggest button:hover{background:#f8f8fb}
.brick-memo-msg{min-height:20px;font-size:14px;margin:8px 0}
.brick-memo-submit{padding:11px 26px;background:var(--color-primary,#d0402c);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:15px}
.brick-memo-cost{color:#666;font-size:13px;margin-left:10px}
@media(max-width:640px){
  .brick-memo-date{display:none}
  .brick-memo-who{width:90px}
}
</style>`;

/**
 * 클라이언트 스크립트.
 * 순수 JS — 테마가 빌드를 타지 않으므로 프레임워크를 쓸 수 없다.
 */
export const MEMO_SCRIPT = `
<script>
(function () {
  var root = document.querySelector('.brick-memo[data-memo-view]');
  if (!root) return;
  var API = '/api/plugins/brick-memo';
  var body = root.querySelector('.brick-memo-body');
  var view = root.dataset.memoView;
  var memoId = root.dataset.memoId || '';

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
  function fail(msg) { body.innerHTML = '<p class="brick-memo-empty">' + esc(msg) + '</p>'; }

  /* ── 목록 (받은/보낸) ─────────────────────────────── */
  function renderList(kind) {
    req(API + '/' + (kind === 'sent' ? 'sent' : 'inbox')).then(function (res) {
      if (!res.ok) return fail(res.data.message || '불러올 수 없습니다.');
      var items = res.data.items || [];
      if (!items.length) {
        body.innerHTML = '<p class="brick-memo-empty">' +
          (kind === 'sent' ? '보낸 쪽지가 없습니다.' : '받은 쪽지가 없습니다.') + '</p>';
        return;
      }
      var isSent = kind === 'sent';
      var rows = items.map(function (m) {
        var unread = !isSent && !m.is_read;
        var who = isSent ? (m.receiver_name || '(탈퇴)') : (m.sender_name || '(탈퇴)');
        return '<tr class="' + (unread ? 'is-unread' : '') + '" data-id="' + esc(m.id) + '">' +
          '<td class="brick-memo-who">' + (unread ? '<span class="brick-unread-dot"></span>' : '') + esc(who) + '</td>' +
          '<td><a href="/memo/' + esc(m.id) + '">' + esc(m.preview || '(내용 없음)') + '</a>' +
          (isSent ? '<span class="brick-memo-hint">' + (m.is_read ? '읽음' : '읽지 않음') + '</span>' : '') +
          '</td>' +
          '<td class="brick-memo-date">' + fmtDate(m.created_at) + '</td>' +
          '<td class="brick-memo-actions"><button type="button" data-del="' + esc(m.id) + '">삭제</button></td>' +
          '</tr>';
      }).join('');

      body.innerHTML =
        (!isSent && res.data.unread > 0
          ? '<p class="brick-memo-hint">읽지 않은 쪽지 ' + res.data.unread + '개 ' +
            '<button type="button" class="brick-memo-row-btn" data-read-all>모두 읽음으로</button></p>'
          : '') +
        '<table class="brick-memo-table"><thead><tr>' +
        '<th class="brick-memo-who">' + (isSent ? '받는 사람' : '보낸 사람') + '</th>' +
        '<th>내용</th><th class="brick-memo-date">날짜</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';

      body.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('이 쪽지를 삭제할까요?')) return;
          send(API + '/' + btn.dataset.del, null, 'DELETE').then(function (r) {
            if (!r.ok) { alert(r.data.message || '삭제에 실패했습니다.'); return; }
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
      if (!res.ok) return fail(res.data.message || '쪽지를 불러올 수 없습니다.');
      var m = res.data.memo;
      var isReceiver = res.data.role === 'receiver';
      var who = isReceiver ? (m.sender_name || '(탈퇴)') : (m.receiver_name || '(탈퇴)');
      body.innerHTML =
        '<div class="brick-memo-detail">' +
        '<div class="brick-memo-detail-head">' +
        '<strong>' + (isReceiver ? '보낸 사람' : '받는 사람') + ': ' + esc(who) + '</strong>' +
        '<time>' + new Date(m.created_at).toLocaleString('ko-KR') + '</time>' +
        (!isReceiver ? '<span class="brick-memo-hint">' + (m.is_read ? '읽음' : '읽지 않음') + '</span>' : '') +
        '</div>' +
        '<div class="brick-memo-content">' + esc(m.content) + '</div>' +
        '<div class="brick-memo-detail-foot">' +
        '<a href="/memo' + (isReceiver ? '' : '/sent') + '">목록</a>' +
        (isReceiver && m.sender_id
          ? '<a href="/memo/write?to=' + encodeURIComponent(m.sender_id) + '">답장</a>' +
            '<button type="button" data-block="' + esc(m.sender_id) + '">차단</button>'
          : '') +
        '<button type="button" data-del-one>삭제</button>' +
        '</div></div>';

      body.querySelector('[data-del-one]').addEventListener('click', function () {
        if (!confirm('이 쪽지를 삭제할까요?')) return;
        send(API + '/' + memoId, null, 'DELETE').then(function (r) {
          if (!r.ok) { alert(r.data.message || '삭제에 실패했습니다.'); return; }
          location.href = '/memo' + (isReceiver ? '' : '/sent');
        });
      });
      var blockBtn = body.querySelector('[data-block]');
      if (blockBtn) {
        blockBtn.addEventListener('click', function () {
          if (!confirm('이 회원을 차단하면 앞으로 쪽지를 받지 않습니다. 차단할까요?')) return;
          send(API + '/blocks/' + blockBtn.dataset.block).then(function (r) {
            alert(r.ok ? '차단했습니다.' : (r.data.message || '차단에 실패했습니다.'));
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
      '<label class="brick-memo-field">받는 사람' +
      '<input name="receiver" placeholder="이름 또는 이메일로 검색" autocomplete="off" required />' +
      '</label>' +
      '<div class="brick-memo-suggest" hidden></div>' +
      '<input type="hidden" name="receiverId" value="' + esc(to) + '" />' +
      '<label class="brick-memo-field">내용' +
      '<textarea name="content" required placeholder="내용을 입력하세요"></textarea>' +
      '</label>' +
      '<p class="brick-memo-msg" role="status"></p>' +
      '<div><button type="submit" class="brick-memo-submit">보내기</button>' +
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
          '발송 시 ' + r.data.sendPoint.toLocaleString('ko-KR') + ' 포인트가 차감됩니다.';
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
      msgEl.textContent = '보내는 중…';
      msgEl.style.color = '#666';
      send(API + '/', payload).then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          msgEl.textContent = r.data.message || '보내지 못했습니다.';
          msgEl.style.color = 'crimson';
          return;
        }
        msgEl.style.color = '#0a7';
        msgEl.textContent = (r.data.receiverName || '') + '님에게 보냈습니다.';
        setTimeout(function () { location.href = '/memo/sent'; }, 700);
      });
    });
  }

  /* ── 차단 목록 ─────────────────────────────────────── */
  function renderBlocks() {
    req(API + '/blocks/list').then(function (res) {
      if (!res.ok) return fail(res.data.message || '불러올 수 없습니다.');
      var items = res.data.items || [];
      if (!items.length) {
        body.innerHTML = '<p class="brick-memo-empty">차단한 회원이 없습니다.</p>';
        return;
      }
      body.innerHTML = '<table class="brick-memo-table"><thead><tr>' +
        '<th>회원</th><th class="brick-memo-date">차단일</th><th></th></tr></thead><tbody>' +
        items.map(function (b) {
          return '<tr><td>' + esc(b.display_name) + '</td>' +
            '<td class="brick-memo-date">' + fmtDate(b.created_at) + '</td>' +
            '<td class="brick-memo-actions"><button type="button" data-unblock="' + esc(b.blocked_id) + '">해제</button></td></tr>';
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
