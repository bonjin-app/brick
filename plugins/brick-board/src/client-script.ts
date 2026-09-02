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
    el.style.color = isError ? 'var(--color-danger, #c9342f)' : 'var(--color-success, #11795a)';
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
      } else if (btn.hasAttribute('data-image')) {
        var picker = toolbar.querySelector('[data-image-input]');
        if (picker) picker.click();
      }
    });

    // 이미지 삽입 — 글보다 먼저 올릴 수 있는 회원 전용 통로(/boards/:slug/images)로
    // 업로드하고 URL 을 본문에 넣는다. 서버가 회원·권한·형식을 다시 검사한다.
    var imagePicker = toolbar.querySelector('[data-image-input]');
    if (imagePicker) {
      imagePicker.addEventListener('change', function () {
        var file = imagePicker.files && imagePicker.files[0];
        if (!file) return;
        var root = document.querySelector('.brick-write');
        var slug = root ? root.dataset.board : '';
        var status = root ? root.querySelector('.brick-write-msg') : null;
        var fd = new FormData(); fd.append('files', file);
        msg(status, '이미지 업로드 중…');
        fetch(API + '/boards/' + encodeURIComponent(slug) + '/images', { method: 'POST', body: fd })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (r) {
            imagePicker.value = '';
            if (!r.ok) { msg(status, r.d.message || '이미지를 올리지 못했습니다.', true); return; }
            msg(status, '');
            apply(function () { document.execCommand('insertImage', false, r.d.url); });
            body.dispatchEvent(new Event('input'));
          });
      });
    }

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

    /* ── 자동 임시저장 ──────────────────────────────
       길게 쓴 글이 새로고침·뒤로가기·세션 만료로 사라지는 것이 게시판의 가장 흔한
       상실이다. 입력마다 브라우저 저장소에 적고, 다시 열면 복원한다.
       서버에 저장하지 않는 이유: 비회원도 쓰고, 초안은 사적이며, 서버 표면을 넓힐 이유가 없다. */
    var draftKey = writeRoot.dataset.draftKey || '';
    var titleField = form.querySelector('input[name=title]');
    var catField = form.querySelector('select[name=category]');
    var editorBody = writeRoot.querySelector('.brick-editor-body');
    var draftNote = writeRoot.querySelector('[data-draft-note]');
    var draftTimer = null;
    function readDraft() { try { return JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch (e) { return null; } }
    function clearDraft() { try { localStorage.removeItem(draftKey); } catch (e) {} if (draftNote) draftNote.hidden = true; }
    function saveDraft() {
      if (!draftKey || !editorBody) return;
      var data = { title: titleField ? titleField.value : '', content: editorBody.innerHTML,
                   category: catField ? catField.value : '', at: Date.now() };
      var empty = !data.title.trim() && !editorBody.textContent.trim() && !editorBody.querySelector('img');
      try { if (empty) localStorage.removeItem(draftKey); else localStorage.setItem(draftKey, JSON.stringify(data)); } catch (e) {}
    }
    if (draftKey && editorBody) {
      var saved = readDraft();
      // 수정 화면은 서버 값이 이미 채워져 있다 — 비어 있을 때(새 글)만 되살린다
      var isBlank = !(titleField && titleField.value.trim()) && !editorBody.textContent.trim() && !editorBody.querySelector('img');
      if (saved && isBlank && (saved.title || saved.content)) {
        if (titleField) titleField.value = saved.title || '';
        editorBody.innerHTML = saved.content || '';
        if (catField && saved.category) catField.value = saved.category;
        editorBody.dispatchEvent(new Event('input'));
        if (draftNote) draftNote.hidden = false;
      }
      var discard = writeRoot.querySelector('[data-draft-discard]');
      if (discard) discard.addEventListener('click', function () {
        clearDraft();
        if (titleField) titleField.value = '';
        editorBody.innerHTML = '';
        editorBody.dispatchEvent(new Event('input'));
      });
      var schedule = function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600); };
      if (titleField) titleField.addEventListener('input', schedule);
      if (catField) catField.addEventListener('change', schedule);
      editorBody.addEventListener('input', schedule);
      window.addEventListener('pagehide', saveDraft);
    }

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
        clearDraft(); // 저장됐으니 초안은 필요 없다 — 남으면 다음 글쓰기에 되살아난다
        var fileInput = form.querySelector('input[name=files]');
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

  /* ── 프로필 카드 — 글쓴이 이름을 누르면 가입일·글·댓글 수 ─────────
     코어(/api/members/:id/card)와 게시판(/authors/:id/stats)이 각자 아는 것을 준다. */
  var cardEl = null;
  function closeCard() { if (cardEl) { cardEl.remove(); cardEl = null; } }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-author]');
    if (!btn) { if (cardEl && !e.target.closest('.brick-profile-card')) closeCard(); return; }
    e.preventDefault();
    closeCard();
    var id = btn.dataset.author;
    var card = document.createElement('div');
    card.className = 'brick-profile-card';
    card.setAttribute('role', 'dialog');
    card.innerHTML = '<div class="brick-profile-loading">불러오는 중…</div>';
    btn.parentElement.insertAdjacentElement('afterend', card);
    cardEl = card;
    Promise.all([
      fetch('/api/members/' + id + '/card').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch(API + '/authors/' + id + '/stats').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      var m = res[0], st = res[1];
      if (!m) { card.innerHTML = '<div class="brick-profile-loading">회원 정보를 볼 수 없습니다.</div>'; return; }
      var joined = m.joinedAt ? new Date(m.joinedAt) : null;
      var joinedText = joined ? joined.getFullYear() + '.' + String(joined.getMonth() + 1).padStart(2, '0') + '.' + String(joined.getDate()).padStart(2, '0') : '-';
      card.innerHTML =
        '<div class="brick-profile-head">' +
          (m.avatarUrl ? '<img class="brick-avatar brick-avatar-lg" src="' + esc(m.avatarUrl) + '" alt="">'
                       : '<span class="brick-avatar brick-avatar-lg" style="--h:' + (hashHue(m.displayName)) + '">' + esc((m.displayName || '?').trim()[0]) + '</span>') +
          '<div><strong>' + esc(m.displayName) + '</strong>' +
          (m.roleLabel ? '<span class="brick-profile-role">' + esc(m.roleLabel) + '</span>' : '') + '</div>' +
        '</div>' +
        '<dl class="brick-profile-stats">' +
          '<div><dt>가입</dt><dd>' + joinedText + '</dd></div>' +
          (st ? '<div><dt>글</dt><dd>' + st.posts + '</dd></div><div><dt>댓글</dt><dd>' + st.comments + '</dd></div>' : '') +
        '</dl>' +
        '<button type="button" class="brick-profile-close" aria-label="닫기">&times;</button>';
      card.querySelector('.brick-profile-close').addEventListener('click', closeCard);
    });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCard(); });
  function hashHue(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

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

    // 공유 — Web Share API 가 있으면(모바일) OS 공유창을 연다: 카카오톡·문자 등이 거기 다 있다.
    // 없으면 링크 복사와 X·페이스북 링크. 카카오 SDK 는 앱 키가 필요해 기본 테마가 가정하지 않는다.
    var shareBar = postRoot.querySelector('[data-share-bar]');
    if (shareBar) {
      var pageUrl = location.href.split('#')[0];
      var pageTitle = document.title;
      var nativeBtn = shareBar.querySelector('[data-share=native]');
      if (nativeBtn && navigator.share) {
        nativeBtn.hidden = false;
        nativeBtn.addEventListener('click', function () {
          navigator.share({ title: pageTitle, url: pageUrl }).catch(function () {});
        });
      }
      var copyBtn = shareBar.querySelector('[data-share=copy]');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var done = function () { var old = copyBtn.textContent; copyBtn.textContent = '복사됨'; setTimeout(function () { copyBtn.textContent = old; }, 1600); };
        if (navigator.clipboard) navigator.clipboard.writeText(pageUrl).then(done, function () { prompt('주소를 복사하세요', pageUrl); });
        else prompt('주소를 복사하세요', pageUrl);
      });
      var x = shareBar.querySelector('[data-share=x]');
      if (x) { x.href = 'https://twitter.com/intent/tweet?url=' + encodeURIComponent(pageUrl) + '&text=' + encodeURIComponent(pageTitle); x.target = '_blank'; }
      var fb = shareBar.querySelector('[data-share=facebook]');
      if (fb) { fb.href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(pageUrl); fb.target = '_blank'; }
      var pr = shareBar.querySelector('[data-print]');
      if (pr) pr.addEventListener('click', function () { window.print(); });
    }

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
.brick-board-head{display:flex;align-items:baseline;gap:10px;padding-bottom:6px}
.brick-board-head h1,.brick-board-head h2{margin:0;font-size:23px;letter-spacing:-0.6px;font-weight:800}
.brick-board-head h2 a{color:inherit;text-decoration:none}
.brick-board-head h2 a:hover{color:var(--color-primary-text, #b63a2e)}
.brick-board-total{color:var(--color-muted, #6c6c7a);font-size:13px}
.brick-board-desc{color:var(--color-text-soft, #45454f);font-size:14px;margin:10px 0}
.brick-cat-nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.brick-cat-nav a{padding:5px 12px;border:1px solid var(--color-line, #e4e4ea);border-radius:16px;text-decoration:none;color:inherit;font-size:13px}
.brick-cat-nav a.is-active{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-color:transparent}
.brick-board-table{width:100%;border-collapse:collapse;font-size:14px}
.brick-board-table th{padding:10px 8px;border-bottom:1px solid var(--color-line, #e4e4ea);color:var(--color-text-soft, #45454f);font-weight:600;font-size:13px}
.brick-board-table td{padding:11px 8px;border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-board-table a{color:inherit;text-decoration:none}
.brick-board-table a:hover{text-decoration:underline}
.brick-notice{background:var(--color-bg-soft, #f6f6f9)}
.brick-notice .brick-c-num{color:var(--color-primary,#d0402c);font-weight:700;font-size:12px}
.brick-c-num{width:52px;text-align:center;color:var(--color-muted, #6c6c7a);font-size:12px}
.brick-c-author{width:110px;color:var(--color-text-soft, #45454f)}
.brick-c-date{width:60px;color:var(--color-muted, #6c6c7a);font-size:13px;text-align:center}
.brick-c-view{width:56px;color:var(--color-muted, #6c6c7a);font-size:13px;text-align:center}
.brick-cat{display:inline-block;padding:1px 7px;margin-right:5px;background:var(--color-line, #e4e4ea);border-radius:10px;font-size:11.5px;color:var(--color-text-soft, #45454f)}
.brick-reply-mark{color:var(--color-muted, #6c6c7a);margin-right:4px;margin-left:calc((var(--d,1) - 1) * 14px)}
.brick-cmt{color:var(--color-primary,#d0402c);font-size:12.5px;margin-left:4px;font-weight:600}
.brick-clip,.brick-lock{font-size:12px;margin-left:3px}
.brick-board-search{display:flex;gap:6px;margin-top:22px;align-items:center;flex-wrap:wrap;justify-content:center}
.brick-board-search select,.brick-board-search input{padding:8px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px}
.brick-board-search button{padding:8px 16px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);cursor:pointer}
.brick-write-btn{margin-left:auto;padding:9px 20px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}
.brick-board-empty{padding:36px;text-align:center;color:var(--color-muted, #6c6c7a)}
.brick-pager{display:flex;gap:4px;justify-content:center;margin:20px 0;font-size:14px;align-items:center}
.brick-pager a,.brick-pager strong,.brick-pager span{padding:6px 11px;border-radius:6px;text-decoration:none;color:inherit}
.brick-pager a{border:1px solid var(--color-line, #e4e4ea)}
.brick-pager strong{background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff)}

/* 상세 */
.brick-post-head{border-bottom:1px solid var(--color-line, #e4e4ea);padding-bottom:14px;margin-bottom:18px}
.brick-post-head h1,.brick-post-head h2{margin:6px 0 10px;font-size:24px;line-height:1.4;letter-spacing:-0.6px;font-weight:800}
.brick-post-meta{display:flex;gap:12px;color:var(--color-muted, #6c6c7a);font-size:13px;flex-wrap:wrap}
.brick-edited{color:var(--color-muted, #6c6c7a)}
.brick-post-content{line-height:1.8;padding-bottom:28px;word-break:break-word}
.brick-post-content img{max-width:100%;height:auto}
.brick-post-content blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--color-line, #e4e4ea);color:var(--color-text-soft, #45454f)}
.brick-post-content pre{background:var(--color-bg-soft, #f6f6f9);padding:12px;border-radius:6px;overflow-x:auto}
.brick-post-content table{border-collapse:collapse}
.brick-post-content td,.brick-post-content th{border:1px solid var(--color-line, #e4e4ea);padding:6px 10px}
.brick-files{background:var(--color-bg-soft, #f6f6f9);border-radius:8px;padding:14px 16px;margin-bottom:18px;font-size:14px}
.brick-files ul{margin:8px 0 0;padding-left:18px}
.brick-files li{padding:3px 0}
.brick-file-meta{color:var(--color-muted, #6c6c7a);font-size:12.5px;margin-left:6px}
.brick-file-locked{color:var(--color-muted, #6c6c7a)}
.brick-secret-notice{padding:40px;text-align:center;color:var(--color-text-soft, #45454f);background:var(--color-bg-soft, #f6f6f9);border-radius:10px}
.brick-post-foot{display:flex;align-items:center;gap:14px;margin-top:28px;padding-top:16px;border-top:1px solid var(--color-line, #e4e4ea);flex-wrap:wrap}
.brick-vote{display:flex;gap:8px}
.brick-vote button{padding:8px 16px;border:1px solid var(--color-line, #e4e4ea);border-radius:20px;background:var(--color-bg, #ffffff);cursor:pointer;font-size:14px}
.brick-scrap{padding:8px 16px;border:1px solid var(--color-line, #e4e4ea);border-radius:20px;background:var(--color-bg, #ffffff);cursor:pointer;font-size:14px}
.brick-scrap.is-on{border-color:var(--color-primary,#d0402c);color:var(--color-primary,#d0402c)}
.brick-post-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.brick-post-actions a,.brick-post-actions button{padding:8px 16px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);text-decoration:none;color:inherit;cursor:pointer;font-size:14px}

/* 댓글 */
.brick-comments{margin-top:36px}
.brick-comments h3{font-size:16px;border-bottom:1px solid var(--color-line, #e4e4ea);padding-bottom:10px}
.brick-comment-list{list-style:none;padding:0;margin:0}
.brick-comment{padding:14px 0;border-bottom:1px solid var(--color-line, #e4e4ea);margin-left:calc(var(--d,0) * 26px)}
.brick-comment-head{display:flex;gap:8px;align-items:baseline;font-size:13.5px}
.brick-comment-head time{color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-comment-body{margin-top:5px;font-size:14.5px;line-height:1.7;word-break:break-word}
.brick-hidden{color:var(--color-muted, #6c6c7a)}
.brick-comment-actions{margin-top:6px;display:flex;gap:6px}
.brick-comment-actions button{border:none;background:none;color:var(--color-muted, #6c6c7a);font-size:12.5px;cursor:pointer;padding:2px 4px}
.brick-comment-actions button:hover{color:var(--color-primary,#d0402c)}
.brick-comment-form{margin-top:18px}
.brick-comment-form textarea{width:100%;padding:10px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px}
.brick-comment-submit{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13.5px}
.brick-comment-submit button[type=submit]{margin-left:auto;padding:9px 22px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border:none;border-radius:6px;cursor:pointer;font-weight:600}
.brick-reply-to{color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-guest-fields{display:flex;gap:8px;margin-bottom:8px}
.brick-guest-fields input{padding:8px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;font-size:14px}

/* 글쓰기 */
.brick-write-form{margin-top:18px}
.brick-field{display:block;margin-bottom:16px;font-size:14px}
.brick-field .brick-label{display:block;margin-bottom:4px}
.brick-field input[type=text],.brick-field input:not([type]),.brick-field input[type=password],.brick-field select{width:100%;padding:10px;margin-top:4px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;box-sizing:border-box;font-size:14px}
.brick-field small{color:var(--color-muted, #6c6c7a);font-weight:400}
.brick-editor{border:1px solid var(--color-line, #e4e4ea);border-radius:6px;overflow:hidden}
.brick-toolbar{display:flex;gap:2px;padding:6px;background:var(--color-bg-soft, #f6f6f9);border-bottom:1px solid var(--color-line, #e4e4ea);flex-wrap:wrap}
.brick-toolbar button{min-width:32px;height:30px;border:1px solid transparent;background:none;border-radius:4px;cursor:pointer;font-size:14px}
.brick-toolbar button:hover{background:var(--color-bg, #ffffff);border-color:var(--color-line, #e4e4ea)}
.brick-sep{width:1px;background:var(--color-line, #e4e4ea);margin:4px 4px}
.brick-editor-body{min-height:260px;padding:14px;outline:none;line-height:1.8;font-size:15px}
.brick-editor-body.is-empty::before{content:attr(data-placeholder);color:var(--color-muted, #6c6c7a)}
.brick-editor-body img{max-width:100%}
.brick-write-options{display:flex;gap:16px;font-size:14px;margin-bottom:12px}
.brick-write-msg{min-height:20px;font-size:14px;margin:6px 0}
.brick-write-actions{display:flex;gap:10px;align-items:center}
.brick-write-actions .brick-primary{padding:11px 28px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:15px}
.brick-write-actions a{padding:11px 22px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;text-decoration:none;color:inherit}

/* 캡차 */
.brick-captcha-row{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.brick-captcha-image{display:inline-flex;align-items:center;min-width:160px;min-height:56px;background:var(--color-bg-soft, #f6f6f9);border-radius:6px}
.brick-captcha-image svg{display:block;border-radius:6px}
.brick-captcha-loading{color:var(--color-muted, #6c6c7a);font-size:12.5px;padding:0 10px}
.brick-captcha-row button{width:34px;height:34px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);cursor:pointer;font-size:16px}
.brick-captcha-row input{width:150px;padding:9px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;font-size:15px;letter-spacing:2px;text-transform:uppercase}

/* 카드 · 위젯 */
.brick-board-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:18px 0}
.brick-board-card{display:block;padding:18px;border:1px solid var(--color-line, #e4e4ea);border-radius:10px;text-decoration:none;color:inherit}
.brick-board-card strong{display:block;font-size:16px}
.brick-board-count{color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-board-card p{margin:8px 0 0;color:var(--color-text-soft, #45454f);font-size:13.5px}
/* ── 작성자 아바타 · 프로필 카드 ─────────────────── */
.brick-author{display:inline-flex;align-items:center;gap:7px;position:relative}
.brick-avatar{display:inline-grid;place-items:center;border-radius:50%;object-fit:cover;flex:0 0 auto;font-weight:700;color:#fff;
  background:hsl(var(--h,200) 45% 48%);letter-spacing:0;line-height:1}
.brick-avatar-sm{width:22px;height:22px;font-size:11px}
.brick-avatar-md{width:30px;height:30px;font-size:13px}
.brick-avatar-lg{width:48px;height:48px;font-size:20px}
.brick-author-name{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;font-weight:600}
.brick-author-name:hover{color:var(--color-primary-text, #b63a2e);text-decoration:underline}
span.brick-author-name{cursor:default;font-weight:500}
.brick-profile-card{position:absolute;z-index:30;top:calc(100% + 8px);left:0;min-width:240px;padding:14px 16px 12px;border-radius:var(--radius-lg, 14px);
  background:var(--color-bg, #fff);border:1px solid var(--color-line, #e4e4ea);box-shadow:var(--shadow-md, 0 8px 28px rgba(0,0,0,.12));font-size:13.5px}
.brick-profile-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.brick-profile-head strong{display:block;font-size:15px}
.brick-profile-role{font-size:12px;color:var(--color-muted, #6c6c7a)}
.brick-profile-stats{display:flex;gap:16px;margin:0}
.brick-profile-stats div{display:flex;flex-direction:column;gap:2px}
.brick-profile-stats dt{font-size:11.5px;color:var(--color-muted, #6c6c7a)}
.brick-profile-stats dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}
.brick-profile-close{position:absolute;top:6px;right:8px;border:0;background:none;font-size:18px;line-height:1;color:var(--color-muted, #6c6c7a);cursor:pointer;padding:4px}
.brick-profile-loading{color:var(--color-muted, #6c6c7a)}
.brick-post-meta .brick-author{margin-right:2px}
/* ── 목록 스킨: 갤러리 · 웹진 ─────────────────────── */
.brick-gallery-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin:14px 0 4px}
.brick-gallery-item{display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit;min-width:0}
.brick-gallery-thumb,.brick-webzine-thumb{position:relative;display:block;aspect-ratio:4/3;overflow:hidden;border-radius:var(--radius, 10px);background:var(--color-bg-soft, #f6f6f9);border:1px solid var(--color-line, #e4e4ea)}
.brick-gallery-thumb img,.brick-webzine-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s ease}
.brick-gallery-item:hover .brick-gallery-thumb img,.brick-webzine-item:hover .brick-webzine-thumb img{transform:scale(1.04)}
/* 자리표시 — 아이콘 위, 글자 아래. 절대 배치로 겹치게 두면 글자가 아이콘 위에 얹힌다 */
.brick-thumb-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:12.5px;color:var(--color-muted, #6c6c7a)}
.brick-thumb-empty::before{content:"";width:34px;height:28px;border:2px solid currentColor;border-radius:5px;opacity:.45}
.brick-gallery-title,.brick-webzine-title{font-weight:600;font-size:14.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.brick-gallery-item:hover .brick-gallery-title,.brick-webzine-item:hover .brick-webzine-title{color:var(--color-primary-text, #b63a2e)}
.brick-list-meta{display:flex;gap:10px;font-size:12.5px;color:var(--color-muted, #6c6c7a)}
.brick-list-badge{position:absolute;top:8px;left:8px;background:var(--color-primary, #cf4437);color:var(--color-on-primary, #fff);font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:999px;z-index:1}
.brick-webzine{list-style:none;padding:0;margin:8px 0 4px}
.brick-webzine-item{border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-webzine-item>a{display:grid;grid-template-columns:220px 1fr;gap:20px;padding:18px 0;text-decoration:none;color:inherit;align-items:start}
.brick-webzine-thumb{aspect-ratio:16/10}
.brick-webzine-body{display:flex;flex-direction:column;gap:8px;min-width:0}
.brick-webzine-title{font-size:17px;-webkit-line-clamp:2}
.brick-webzine-excerpt{font-size:14px;line-height:1.6;color:var(--color-text-soft, #45454f);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@media(max-width:640px){.brick-webzine-item>a{grid-template-columns:120px 1fr;gap:14px;padding:14px 0}.brick-webzine-title{font-size:15px}.brick-webzine-excerpt{display:none}.brick-gallery-grid{grid-template-columns:repeat(2,1fr);gap:12px}}
/* ── 상세: 첨부 이미지 · 공유 · 이전/다음 ─────────── */
.brick-post-images{display:flex;flex-direction:column;gap:14px;margin:8px 0 18px}
.brick-post-images figure{margin:0}
.brick-post-images img{max-width:100%;height:auto;border-radius:var(--radius, 10px);display:block}
.brick-share{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:18px 0 0;padding-top:14px;border-top:1px dashed var(--color-line, #e4e4ea)}
.brick-share-label{font-size:12.5px;color:var(--color-muted, #6c6c7a);margin-right:4px}
.brick-share a,.brick-share button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid var(--color-line, #e4e4ea);background:var(--color-bg, #fff);color:var(--color-text-soft, #45454f);text-decoration:none;cursor:pointer}
.brick-share a:hover,.brick-share button:hover{border-color:var(--color-muted, #6c6c7a);color:var(--color-text, #17171c)}
.brick-post-nav{display:grid;gap:10px;margin:26px 0 8px}
.brick-post-nav-item{display:flex;align-items:baseline;gap:14px;padding:12px 14px;border:1px solid var(--color-line, #e4e4ea);border-radius:var(--radius, 10px);text-decoration:none;color:inherit;min-width:0}
.brick-post-nav-item small{flex:0 0 auto;font-size:12px;color:var(--color-muted, #6c6c7a);font-weight:600}
.brick-post-nav-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14.5px}
.brick-post-nav-item:not(.is-empty):hover{border-color:var(--color-line-strong, #d0d0d9);background:var(--color-bg-soft, #f6f6f9)}
.brick-post-nav-item.is-empty{color:var(--color-muted, #6c6c7a)}
.brick-draft-note{font-size:13px;color:var(--color-success, #11795a);margin:6px 0 0}
.brick-draft-note button{font:inherit;font-size:12.5px;margin-left:6px;padding:2px 8px;border-radius:6px;border:1px solid var(--color-line, #e4e4ea);background:var(--color-bg, #fff);color:var(--color-text-soft, #45454f);cursor:pointer}
@media print{.brick-share,.brick-post-nav,.brick-comments,.brick-post-foot,.brick-files{display:none!important}}
.brick-latest-posts{list-style:none;padding:0;margin:10px 0}
.brick-latest-posts li{display:flex;align-items:baseline;gap:6px;padding:8px 0;border-bottom:1px solid var(--color-line, #e4e4ea)}
.brick-latest-posts li:last-child{border-bottom:0;padding-bottom:0}
.brick-latest-posts a:hover{color:var(--color-primary-text, #b63a2e)}
.brick-latest-posts a{color:inherit;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brick-latest-posts time{color:var(--color-muted, #6c6c7a);font-size:12.5px}
.brick-widget-title{font-size:16px;margin:0 0 4px}
@media(max-width:640px){
  .brick-c-author,.brick-c-view{display:none}
  .brick-board-head h1,.brick-board-head h2{font-size:20px}
}
</style>`;
