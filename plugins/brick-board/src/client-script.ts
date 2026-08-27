/**
 * 게시판 클라이언트 스크립트.
 *
 * 테마는 빌드를 타지 않으므로 프레임워크를 쓸 수 없다 — 순수 JS로 작성한다.
 * 서버 렌더된 HTML에 동작만 붙인다(progressive enhancement):
 *  - 경량 에디터 (contenteditable + execCommand)
 *  - 글쓰기/수정 제출 + 첨부 업로드
 *  - 댓글 작성/삭제/답글
 *  - 추천/비추천
 *  - 첨부 다운로드 (권한 검사를 서버가 하므로 URL을 받아 이동)
 *
 * 에디터가 만든 HTML은 **서버에서 다시 새니타이즈**한다. 클라이언트 검증은
 * 편의일 뿐이고 신뢰하지 않는다.
 */
export const BOARD_SCRIPT = `
<script>
(function () {
  var API = '/api/plugins/brick-board';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function post(url, body, method) {
    return fetch(url, {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }
  function msg(el, text, isError) {
    if (!el) { if (text) alert(text); return; }
    el.textContent = text || '';
    el.style.color = isError ? 'crimson' : '#0a7';
  }

  /* ── 캡차 ──────────────────────────────────────────
     이미지를 서버 렌더에 넣으면 캐시된 페이지에 같은 문제가 박혀 무의미해진다.
     그래서 클라이언트가 매번 새로 받아 채운다. */
  document.querySelectorAll('[data-captcha]').forEach(function (box) {
    var img = box.querySelector('.brick-captcha-image');
    var tokenField = box.querySelector('input[name=captchaToken]');
    var answerField = box.querySelector('input[name=captchaAnswer]');

    function load() {
      img.innerHTML = '<span class="brick-captcha-loading">불러오는 중…</span>';
      fetch('/api/captcha', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.enabled) {
            // 캡차가 꺼져 있으면 필드를 숨기고 required도 해제한다
            box.hidden = true;
            if (answerField) answerField.required = false;
            return;
          }
          img.innerHTML = d.svg;
          tokenField.value = d.token;
        })
        .catch(function () {
          img.innerHTML = '<span class="brick-captcha-loading">불러올 수 없습니다</span>';
        });
    }
    load();
    // 폼 제출이 실패해 다시 시도할 때는 새 문제를 받아야 한다 (토큰은 1회용)
    box.captchaReload = load;
    var reload = box.querySelector('[data-captcha-reload]');
    if (reload) reload.addEventListener('click', function () { answerField.value = ''; load(); });
  });

  /** 캡차 값을 payload에 담고, 실패 후 재시도를 위해 새로고침 함수를 돌려준다 */
  function captchaOf(form) {
    var box = form.querySelector('[data-captcha]');
    if (!box || box.hidden) return { fields: {}, reload: function () {} };
    return {
      fields: {
        captchaToken: box.querySelector('input[name=captchaToken]').value,
        captchaAnswer: box.querySelector('input[name=captchaAnswer]').value
      },
      reload: function () { if (box.captchaReload) box.captchaReload(); }
    };
  }

  /* ── 경량 에디터 ───────────────────────────────── */
  var editor = document.querySelector('.brick-editor');
  if (editor) {
    var body = editor.querySelector('.brick-editor-body');
    var toolbar = editor.querySelector('.brick-toolbar');

    function apply(fn) {
      body.focus();
      fn();
      syncPlaceholder();
    }
    function syncPlaceholder() {
      var empty = !body.textContent.trim() && !body.querySelector('img');
      body.classList.toggle('is-empty', empty);
    }
    syncPlaceholder();
    body.addEventListener('input', syncPlaceholder);

    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.cmd) {
        apply(function () { document.execCommand(btn.dataset.cmd, false, null); });
      } else if (btn.dataset.block) {
        apply(function () { document.execCommand('formatBlock', false, btn.dataset.block); });
      } else if (btn.hasAttribute('data-link')) {
        var url = prompt('링크 주소를 입력하세요 (http:// 또는 https://)');
        if (!url) return;
        if (!/^https?:\\/\\//i.test(url) && url[0] !== '/') {
          alert('http:// 또는 https:// 로 시작하는 주소를 입력하세요.');
          return;
        }
        apply(function () { document.execCommand('createLink', false, url); });
      }
    });

    // 붙여넣기는 서식을 버리고 평문으로 넣는다.
    // 다른 사이트에서 복사한 HTML이 그대로 들어오면 서버 새니타이저가 대부분 걷어내
    // 사용자가 "왜 서식이 사라졌나" 혼란을 겪는다. 처음부터 평문이 예측 가능하다.
    body.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
  }

  /* ── 글쓰기 / 수정 ─────────────────────────────── */
  var writeRoot = document.querySelector('.brick-write');
  if (writeRoot) {
    var form = writeRoot.querySelector('.brick-write-form');
    var status = writeRoot.querySelector('.brick-write-msg');
    var slug = writeRoot.dataset.board;
    var editId = writeRoot.dataset.edit || '';
    var replyTo = writeRoot.dataset.replyTo || '';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var submitBtn = form.querySelector('button[type=submit]');
      var eb = writeRoot.querySelector('.brick-editor-body');
      var content = eb ? eb.innerHTML : '';
      if (!eb || !eb.textContent.trim()) { msg(status, '내용을 입력해주세요.', true); return; }

      var fd = new FormData(form);
      var cap = captchaOf(form);
      var payload = {
        title: fd.get('title'),
        content: content,
        category: fd.get('category') || null,
        isSecret: fd.get('isSecret') === 'on',
        isNotice: fd.get('isNotice') === 'on'
      };
      if (fd.get('guestName')) payload.guestName = fd.get('guestName');
      if (fd.get('guestPassword')) payload.guestPassword = fd.get('guestPassword');
      if (replyTo) payload.replyTo = replyTo;
      Object.keys(cap.fields).forEach(function (k) { payload[k] = cap.fields[k]; });

      submitBtn.disabled = true;
      msg(status, '저장 중...');

      var url = editId ? API + '/posts/' + editId : API + '/boards/' + encodeURIComponent(slug) + '/posts';
      post(url, payload, editId ? 'PUT' : 'POST').then(function (res) {
        if (!res.ok) {
          msg(status, res.data.message || '저장에 실패했습니다.', true);
          submitBtn.disabled = false;
          // 캡차 토큰은 1회용이므로 실패 후에는 새 문제를 받아야 한다
          cap.reload();
          return;
        }
        var postId = editId || res.data.id;
        var fileInput = form.querySelector('input[type=file]');
        var files = fileInput && fileInput.files.length ? fileInput.files : null;
        if (!files) { location.href = '/board/' + encodeURIComponent(slug) + '/' + postId; return; }

        // 첨부는 글 저장 후 별도 업로드한다 (multipart와 JSON을 섞지 않는다)
        msg(status, '파일 업로드 중...');
        var upload = new FormData();
        for (var i = 0; i < files.length; i++) upload.append('files', files[i]);
        var pw = fd.get('guestPassword');
        var upUrl = API + '/posts/' + postId + '/files' + (pw ? '?pw=' + encodeURIComponent(pw) : '');
        fetch(upUrl, { method: 'POST', body: upload })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (r) {
            if (!r.ok) {
              // 글은 저장되었으므로 상세로 보내고 업로드 실패만 알린다
              alert('글은 저장되었지만 파일 업로드에 실패했습니다: ' + (r.d.message || ''));
            }
            location.href = '/board/' + encodeURIComponent(slug) + '/' + postId;
          });
      });
    });
  }

  /* ── 상세: 추천 · 삭제 · 첨부 · 댓글 ───────────── */
  var postRoot = document.querySelector('.brick-post');
  if (postRoot) {
    var postId = postRoot.dataset.post;
    var boardSlug = postRoot.dataset.board;

    // 추천 / 비추천
    postRoot.querySelectorAll('[data-vote]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        post(API + '/posts/' + postId + '/vote', { value: Number(btn.dataset.vote) }).then(function (res) {
          if (!res.ok) { alert(res.data.message || '추천에 실패했습니다.'); return; }
          var up = postRoot.querySelector('[data-up]');
          var down = postRoot.querySelector('[data-down]');
          if (up) up.textContent = res.data.up;
          if (down) down.textContent = res.data.down;
        });
      });
    });

    // 첨부 다운로드 — 권한은 서버가 검사하고 URL을 돌려준다
    postRoot.querySelectorAll('[data-file]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        fetch(API + '/files/' + link.dataset.file)
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (r) {
            if (!r.ok) { alert(r.d.message || '다운로드할 수 없습니다.'); return; }
            location.href = r.d.url;
          });
      });
    });

    // 스크랩 토글
    var scrapBtn = postRoot.querySelector('[data-scrap]');
    if (scrapBtn) {
      scrapBtn.addEventListener('click', function () {
        post(API + '/posts/' + postId + '/scrap').then(function (res) {
          if (!res.ok) { alert(res.data.message || '스크랩에 실패했습니다.'); return; }
          scrapBtn.classList.toggle('is-on', res.data.scrapped);
          scrapBtn.setAttribute('aria-pressed', res.data.scrapped ? 'true' : 'false');
          scrapBtn.querySelector('[data-scrap-icon]').innerHTML = res.data.scrapped ? '\u2605' : '\u2606';
          scrapBtn.querySelector('[data-scrap-count]').textContent = res.data.count;
        });
      });
    }

    // 글 삭제
    var delBtn = postRoot.querySelector('[data-delete-post]');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('이 글을 삭제할까요? 되돌릴 수 없습니다.')) return;
        var qs = '';
        // 비회원 글은 비밀번호가 필요하다
        if (!document.cookie.match(/(^|;)\\s*brick_session=/)) {
          var pw = prompt('작성 시 입력한 비밀번호를 입력하세요');
          if (!pw) return;
          qs = '?pw=' + encodeURIComponent(pw);
        }
        post(API + '/posts/' + postId + qs, null, 'DELETE').then(function (res) {
          if (!res.ok) { alert(res.data.message || '삭제에 실패했습니다.'); return; }
          location.href = '/board/' + encodeURIComponent(boardSlug);
        });
      });
    }

    // 댓글 작성
    var cForm = postRoot.querySelector('.brick-comment-form');
    if (cForm) {
      var parentField = cForm.querySelector('input[name=parentId]');
      var replyNote = cForm.querySelector('.brick-reply-to');

      postRoot.querySelectorAll('[data-reply]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          parentField.value = btn.dataset.reply;
          if (replyNote) replyNote.hidden = false;
          cForm.querySelector('textarea').focus();
        });
      });
      var cancel = cForm.querySelector('[data-cancel-reply]');
      if (cancel) {
        cancel.addEventListener('click', function () {
          parentField.value = '';
          if (replyNote) replyNote.hidden = true;
        });
      }

      cForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(cForm);
        var cap = captchaOf(cForm);
        var payload = { content: fd.get('content'), isSecret: fd.get('isSecret') === 'on' };
        if (fd.get('parentId')) payload.parentId = fd.get('parentId');
        if (fd.get('guestName')) payload.guestName = fd.get('guestName');
        if (fd.get('guestPassword')) payload.guestPassword = fd.get('guestPassword');
        Object.keys(cap.fields).forEach(function (k) { payload[k] = cap.fields[k]; });

        post(API + '/posts/' + postId + '/comments', payload).then(function (res) {
          if (!res.ok) {
            alert(res.data.message || '댓글 등록에 실패했습니다.');
            cap.reload();
            return;
          }
          location.reload();
        });
      });
    }

    // 댓글 삭제
    postRoot.querySelectorAll('[data-del-comment]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('이 댓글을 삭제할까요?')) return;
        var qs = '';
        if (!document.cookie.match(/(^|;)\\s*brick_session=/)) {
          var pw = prompt('작성 시 입력한 비밀번호를 입력하세요');
          if (!pw) return;
          qs = '?pw=' + encodeURIComponent(pw);
        }
        post(API + '/comments/' + btn.dataset.delComment + qs, null, 'DELETE').then(function (res) {
          if (!res.ok) { alert(res.data.message || '삭제에 실패했습니다.'); return; }
          location.reload();
        });
      });
    });
  }
})();
</script>`;

/** 게시판 화면 스타일 — 테마가 빌드를 타지 않으므로 블록이 함께 낸다 */
export const BOARD_CSS = `
<style>
.brick-board{margin:20px 0}
.brick-board-head{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid var(--color-text,#1a1a1a);padding-bottom:10px}
.brick-board-head h2{margin:0;font-size:22px}
.brick-board-total{color:#888;font-size:13px}
.brick-board-desc{color:#666;font-size:14px;margin:10px 0}
.brick-cat-nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.brick-cat-nav a{padding:5px 12px;border:1px solid #e3e3ea;border-radius:16px;text-decoration:none;color:inherit;font-size:13px}
.brick-cat-nav a.is-active{background:var(--color-primary,#d0402c);color:#fff;border-color:transparent}
.brick-board-table{width:100%;border-collapse:collapse;font-size:14px}
.brick-board-table th{padding:10px 8px;border-bottom:1px solid #ddd;color:#666;font-weight:600;font-size:13px}
.brick-board-table td{padding:11px 8px;border-bottom:1px solid #f0f0f4}
.brick-board-table a{color:inherit;text-decoration:none}
.brick-board-table a:hover{text-decoration:underline}
.brick-notice{background:#fafafc}
.brick-notice .brick-c-num{color:var(--color-primary,#d0402c);font-weight:700;font-size:12px}
.brick-c-num{width:52px;text-align:center;color:#aaa;font-size:12px}
.brick-c-author{width:110px;color:#666}
.brick-c-date{width:60px;color:#999;font-size:13px;text-align:center}
.brick-c-view{width:56px;color:#999;font-size:13px;text-align:center}
.brick-cat{display:inline-block;padding:1px 7px;margin-right:5px;background:#f0f0f4;border-radius:10px;font-size:11.5px;color:#666}
.brick-reply-mark{color:#aaa;margin-right:4px;margin-left:calc((var(--d,1) - 1) * 14px)}
.brick-cmt{color:var(--color-primary,#d0402c);font-size:12.5px;margin-left:4px;font-weight:600}
.brick-clip,.brick-lock{font-size:12px;margin-left:3px}
.brick-board-search{display:flex;gap:6px;margin-top:18px;align-items:center;flex-wrap:wrap}
.brick-board-search select,.brick-board-search input{padding:8px;border:1px solid #ddd;border-radius:6px}
.brick-board-search button{padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer}
.brick-write-btn{margin-left:auto;padding:9px 20px;background:var(--color-primary,#d0402c);color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}
.brick-board-empty{padding:36px;text-align:center;color:#999}
.brick-pager{display:flex;gap:4px;justify-content:center;margin:20px 0;font-size:14px;align-items:center}
.brick-pager a,.brick-pager strong,.brick-pager span{padding:6px 11px;border-radius:6px;text-decoration:none;color:inherit}
.brick-pager a{border:1px solid #e3e3ea}
.brick-pager strong{background:var(--color-primary,#d0402c);color:#fff}

/* 상세 */
.brick-post-head{border-bottom:1px solid #e8e8ee;padding-bottom:14px;margin-bottom:18px}
.brick-post-head h2{margin:6px 0 8px;font-size:23px;line-height:1.4}
.brick-post-meta{display:flex;gap:12px;color:#888;font-size:13px;flex-wrap:wrap}
.brick-edited{color:#bbb}
.brick-post-content{line-height:1.8;min-height:80px;word-break:break-word}
.brick-post-content img{max-width:100%;height:auto}
.brick-post-content blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid #ddd;color:#555}
.brick-post-content pre{background:#f6f6f9;padding:12px;border-radius:6px;overflow-x:auto}
.brick-post-content table{border-collapse:collapse}
.brick-post-content td,.brick-post-content th{border:1px solid #ddd;padding:6px 10px}
.brick-files{background:#f8f8fb;border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:14px}
.brick-files ul{margin:8px 0 0;padding-left:18px}
.brick-files li{padding:3px 0}
.brick-file-meta{color:#999;font-size:12.5px;margin-left:6px}
.brick-file-locked{color:#aaa}
.brick-secret-notice{padding:40px;text-align:center;color:#666;background:#f8f8fb;border-radius:10px}
.brick-post-foot{display:flex;align-items:center;gap:14px;margin-top:28px;padding-top:16px;border-top:1px solid #e8e8ee;flex-wrap:wrap}
.brick-vote{display:flex;gap:8px}
.brick-vote button{padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:#fff;cursor:pointer;font-size:14px}
.brick-scrap{padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:#fff;cursor:pointer;font-size:14px}
.brick-scrap.is-on{border-color:var(--color-primary,#d0402c);color:var(--color-primary,#d0402c)}
.brick-post-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.brick-post-actions a,.brick-post-actions button{padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;text-decoration:none;color:inherit;cursor:pointer;font-size:14px}

/* 댓글 */
.brick-comments{margin-top:36px}
.brick-comments h3{font-size:16px;border-bottom:1px solid #e8e8ee;padding-bottom:10px}
.brick-comment-list{list-style:none;padding:0;margin:0}
.brick-comment{padding:14px 0;border-bottom:1px solid #f2f2f6;margin-left:calc(var(--d,0) * 26px)}
.brick-comment-head{display:flex;gap:8px;align-items:baseline;font-size:13.5px}
.brick-comment-head time{color:#aaa;font-size:12.5px}
.brick-comment-body{margin-top:5px;font-size:14.5px;line-height:1.7;word-break:break-word}
.brick-hidden{color:#aaa}
.brick-comment-actions{margin-top:6px;display:flex;gap:6px}
.brick-comment-actions button{border:none;background:none;color:#999;font-size:12.5px;cursor:pointer;padding:2px 4px}
.brick-comment-actions button:hover{color:var(--color-primary,#d0402c)}
.brick-comment-form{margin-top:18px}
.brick-comment-form textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px}
.brick-comment-submit{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13.5px}
.brick-comment-submit button[type=submit]{margin-left:auto;padding:9px 22px;background:var(--color-primary,#d0402c);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600}
.brick-reply-to{color:#888;font-size:12.5px}
.brick-guest-fields{display:flex;gap:8px;margin-bottom:8px}
.brick-guest-fields input{padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px}

/* 글쓰기 */
.brick-write-form{margin-top:18px}
.brick-field{display:block;margin-bottom:16px;font-size:14px}
.brick-field .brick-label{display:block;margin-bottom:4px}
.brick-field input[type=text],.brick-field input:not([type]),.brick-field input[type=password],.brick-field select{width:100%;padding:10px;margin-top:4px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px}
.brick-field small{color:#999;font-weight:400}
.brick-editor{border:1px solid #ddd;border-radius:6px;overflow:hidden}
.brick-toolbar{display:flex;gap:2px;padding:6px;background:#f8f8fb;border-bottom:1px solid #e8e8ee;flex-wrap:wrap}
.brick-toolbar button{min-width:32px;height:30px;border:1px solid transparent;background:none;border-radius:4px;cursor:pointer;font-size:14px}
.brick-toolbar button:hover{background:#fff;border-color:#ddd}
.brick-sep{width:1px;background:#ddd;margin:4px 4px}
.brick-editor-body{min-height:260px;padding:14px;outline:none;line-height:1.8;font-size:15px}
.brick-editor-body.is-empty::before{content:attr(data-placeholder);color:#bbb}
.brick-editor-body img{max-width:100%}
.brick-write-options{display:flex;gap:16px;font-size:14px;margin-bottom:12px}
.brick-write-msg{min-height:20px;font-size:14px;margin:6px 0}
.brick-write-actions{display:flex;gap:10px;align-items:center}
.brick-write-actions .brick-primary{padding:11px 28px;background:var(--color-primary,#d0402c);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:15px}
.brick-write-actions a{padding:11px 22px;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:inherit}

/* 캡차 */
.brick-captcha-row{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.brick-captcha-image{display:inline-flex;align-items:center;min-width:160px;min-height:56px;background:#f6f6f9;border-radius:6px}
.brick-captcha-image svg{display:block;border-radius:6px}
.brick-captcha-loading{color:#aaa;font-size:12.5px;padding:0 10px}
.brick-captcha-row button{width:34px;height:34px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:16px}
.brick-captcha-row input{width:150px;padding:9px;border:1px solid #ddd;border-radius:6px;font-size:15px;letter-spacing:2px;text-transform:uppercase}

/* 카드 · 위젯 */
.brick-board-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:18px 0}
.brick-board-card{display:block;padding:18px;border:1px solid #e8e8ee;border-radius:10px;text-decoration:none;color:inherit}
.brick-board-card strong{display:block;font-size:16px}
.brick-board-count{color:#999;font-size:12.5px}
.brick-board-card p{margin:8px 0 0;color:#666;font-size:13.5px}
.brick-latest-posts{list-style:none;padding:0;margin:10px 0}
.brick-latest-posts li{display:flex;align-items:baseline;gap:6px;padding:6px 0;border-bottom:1px solid #f4f4f7}
.brick-latest-posts a{color:inherit;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brick-latest-posts time{color:#aaa;font-size:12.5px}
.brick-widget-title{font-size:16px;margin:0 0 4px}
@media(max-width:640px){
  .brick-c-author,.brick-c-view{display:none}
  .brick-board-head h2{font-size:19px}
}
</style>`;
