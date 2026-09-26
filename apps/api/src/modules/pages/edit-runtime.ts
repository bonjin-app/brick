/**
 * 배치 편집기 미리보기 안에서 도는 스크립트 — 초안 미리보기 응답에만 붙는다(공개 렌더에는 없다).
 *
 * 하는 일은 셋뿐이다.
 *  1. 누른 자리의 블록 위치(`data-brick-node`)를 편집기에 알린다 — 편집기가 그 블록을 고른다.
 *  2. 편집기가 고른 블록을 테두리로 보여 준다(편집기 → 미리보기).
 *  3. 미리보기 안에서 **아무 데도 가지 않게** 한다 — 링크·폼이 미리보기 창을 다른 화면으로 바꾸면
 *     편집기와 미리보기가 어긋난다.
 *
 * 메시지는 **같은 출처끼리만** 주고받는다. 보내는 쪽은 받는 창의 출처를 못박고, 받는 쪽은 보낸 창이
 * 부모인지와 출처를 함께 본다 — 다른 사이트가 이 창을 띄워 "이 블록을 골라라" 를 보낼 수 없다
 * (애초에 frame-ancestors 'self' 라 다른 사이트는 띄우지도 못한다).
 *
 * 4. **글자를 그 자리에서 고친다** — 블록이 `data-brick-prop` 을 단 요소(제목·문단 등)를 두 번 누르면 고칠 수
 *    있게 되고, Enter(여러 줄이면 Ctrl+Enter)나 다른 곳을 누르면 그 값을 편집기에 보낸다. Esc 는 되돌린다.
 *    보내는 것은 **글자(innerText)** 다 — HTML 을 보내지 않는다. 편집기가 그 블록의 스키마에 있는 글자 속성인지
 *    다시 보고 저장하며, 블록은 그 값을 이스케이프해 그린다.
 *
 * 5. **미리보기 안에서 끌어다 놓는다** — 고른 블록의 이름표가 손잡이다(블록 전체를 끌게 하면 글자 선택·고치기가
 *    망가진다). 다른 블록 위를 지나면 앞·뒤를 가리키는 선이 보이고(가로로 나란한 칸이면 좌·우), 빈 컨테이너의
 *    "빈 칸" 에 놓으면 그 안으로 들어간다. 놓으면 옮길 블록·놓은 블록·앞/뒤/안을 편집기에 보내고, 편집기가
 *    트리에서 다시 확인해 옮긴다(자기 안쪽으로는 못 옮긴다).
 *
 * 스크롤 위치는 주소의 `#y=` 로 되돌린다 — 편집할 때마다 미리보기를 새로 그리므로, 그대로 두면
 * 긴 페이지 아래쪽을 고치는 동안 매번 맨 위로 튄다.
 */
export const EDIT_RUNTIME = `<style>
.brick-edit-node.brick-edit-hover{outline:1px dashed rgba(37,99,235,.7);outline-offset:-1px;cursor:pointer}
.brick-edit-selected{position:relative;outline:2px solid #2563eb!important;outline-offset:-2px}
.brick-edit-handle{position:absolute;top:0;left:0;z-index:2147483646;background:#2563eb;color:#fff;font:600 11px/1.7 system-ui,sans-serif;padding:0 6px;border-radius:0 0 var(--radius,4px) 0;white-space:nowrap;cursor:grab;user-select:none;-webkit-user-select:none}
.brick-edit-drop{position:fixed;z-index:2147483647;background:#2563eb;pointer-events:none;border-radius:var(--radius,2px)}
.brick-edit-drop-inside{outline:3px dashed #2563eb!important;outline-offset:-3px}
[data-brick-prop]:hover{cursor:text}
.brick-editing{outline:2px dashed #2563eb!important;outline-offset:2px;cursor:text;min-width:1em;white-space:pre-wrap}
.brick-edit-missing{border:2px dashed #d97706;border-radius:var(--radius,6px);padding:14px;margin:4px 0;color:#92400e;background:#fffbeb;font:13px/1.5 system-ui,sans-serif}
</style>
<script>
(function(){
  var P = window.parent;
  if (!P || P === window) return;
  var ORIGIN = location.origin;
  function tell(msg){ msg.brick = msg.brick || 'x'; P.postMessage(msg, ORIGIN); }
  function nodeOf(el){ return el && el.closest ? el.closest('[data-brick-node]') : null; }
  // ── 그 자리에서 글자 고치기 ──
  var editing = null;
  function finish(save){
    if (!editing) return;
    var el = editing.el, before = editing.before, node = nodeOf(el);
    // 편집 표시(white-space: pre-wrap)를 떼기 **전에** 읽는다 — 떼고 읽으면 Enter 로 넣은 줄바꿈이 공백으로 접힌다
    var value = el.innerText.replace(/\\n+$/, '');
    editing = null;
    el.removeAttribute('contenteditable');
    el.classList.remove('brick-editing');
    if (!save) { el.innerText = before; return; }
    if (value === before || !node) return;
    var msg = { brick: 'text', path: node.getAttribute('data-brick-node'), prop: el.getAttribute('data-brick-prop'), value: value.slice(0, 20000) };
    // 목록형 속성의 한 칸 — 편집기가 원문의 그 줄·그 칸만 바꾼다
    if (el.hasAttribute('data-brick-row')) { msg.row = Number(el.getAttribute('data-brick-row')); msg.col = Number(el.getAttribute('data-brick-col')); }
    tell(msg);
  }
  document.addEventListener('dblclick', function(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-brick-prop]') : null;
    if (!el || el === (editing && editing.el)) return;
    e.preventDefault();
    finish(true);
    // 원래 값도 편집 표시를 단 뒤에 읽는다 — 끝낼 때와 같은 조건으로 비교해야 고치지 않은 것을 고친 것으로 보지 않는다
    el.classList.add('brick-editing');
    editing = { el: el, before: el.innerText.replace(/\\n+$/, '') };
    el.setAttribute('contenteditable', 'plaintext-only');
    if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
    el.focus();
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }, true);
  document.addEventListener('keydown', function(e){
    if (!editing) return;
    var multi = editing.el.getAttribute('data-brick-multiline') === '1';
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
  }, true);
  // 서식 있는 붙여넣기(글꼴·링크)를 막는다 — plaintext-only 를 모르는 브라우저에서도 글자만 들어가게
  document.addEventListener('paste', function(e){
    if (!editing || !e.clipboardData) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }, true);
  document.addEventListener('focusout', function(e){ if (editing && e.target === editing.el) finish(true); }, true);
  document.addEventListener('click', function(e){
    // 고치는 중인 글자 안의 클릭은 커서를 옮기는 것이다 — 선택을 다시 보내지 않는다
    if (editing && editing.el.contains(e.target)) {
      // 버튼·카드처럼 링크 안의 글자를 고치는 중이면 링크로 가지 않는다
      if (e.target.closest && e.target.closest('a')) e.preventDefault();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    var n = nodeOf(e.target);
    tell({ brick: 'select', path: n ? n.getAttribute('data-brick-node') : '' });
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
  var hov = null;
  document.addEventListener('mouseover', function(e){
    var n = nodeOf(e.target);
    if (n === hov) return;
    if (hov) hov.classList.remove('brick-edit-hover');
    hov = n;
    if (n) n.classList.add('brick-edit-hover');
  }, true);
  var sel = null;
  window.addEventListener('message', function(e){
    if (e.source !== P || e.origin !== ORIGIN) return;
    var d = e.data || {};
    if (d.brick !== 'highlight') return;
    if (sel) {
      sel.classList.remove('brick-edit-selected');
      var old = sel.querySelector(':scope > .brick-edit-handle');
      if (old) old.remove();
    }
    sel = d.path ? document.querySelector('[data-brick-node="' + String(d.path).replace(/[^0-9.]/g, '') + '"]') : null;
    if (!sel) return;
    sel.classList.add('brick-edit-selected');
    // 이름표가 곧 손잡이다 — 이것만 끌린다
    var h = document.createElement('span');
    h.className = 'brick-edit-handle';
    h.setAttribute('draggable', 'true');
    h.setAttribute('aria-hidden', 'true');
    h.textContent = '⋮⋮ ' + String(d.label || '');
    sel.appendChild(h);
    if (d.reveal) sel.scrollIntoView({ block: 'nearest' });
  });
  // ── 끌어다 놓기 ──
  var drag = null, target = null, line = null, inside = null;
  function pathOf(n){ return n.getAttribute('data-brick-node') || ''; }
  // b 가 a 자신이거나 a 의 안쪽인가 — 자기 안으로는 놓을 수 없다
  function within(a, b){ return b === a || b.indexOf(a + '.') === 0; }
  function clearDrop(){
    if (line) { line.remove(); line = null; }
    if (inside) { inside.classList.remove('brick-edit-drop-inside'); inside = null; }
    target = null;
  }
  // 옆 형제와 윗변이 같으면 가로로 나란한 칸이다(다단 레이아웃) — 그때는 좌·우로 판정한다
  function isRow(n){
    var p = pathOf(n).split('.'); var last = Number(p.pop());
    var near = [last + 1, last - 1].map(function(i){ return document.querySelector('[data-brick-node="' + p.concat(i).join('.') + '"]'); })
      .filter(function(x){ return x; })[0];
    if (!near) return false;
    return Math.abs(near.getBoundingClientRect().top - n.getBoundingClientRect().top) < 4;
  }
  function showLine(r, row, before){
    if (!line) { line = document.createElement('div'); line.className = 'brick-edit-drop'; document.body.appendChild(line); }
    var s = line.style;
    if (row) { s.left = ((before ? r.left : r.right) - 2) + 'px'; s.top = r.top + 'px'; s.width = '4px'; s.height = r.height + 'px'; }
    else { s.left = r.left + 'px'; s.top = ((before ? r.top : r.bottom) - 2) + 'px'; s.width = r.width + 'px'; s.height = '4px'; }
  }
  document.addEventListener('dragstart', function(e){
    var h = e.target && e.target.closest ? e.target.closest('.brick-edit-handle') : null;
    // 손잡이가 아니면 끌지 않는다 — 그림·링크를 끌어 새 창으로 여는 브라우저 기본 동작도 막는다
    if (!h || editing) { e.preventDefault(); return; }
    var n = nodeOf(h);
    if (!n) { e.preventDefault(); return; }
    drag = pathOf(n);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag);
  }, true);
  document.addEventListener('dragover', function(e){
    if (!drag) return;
    var empty = e.target && e.target.closest ? e.target.closest('.brick-edit-empty') : null;
    var box = empty ? nodeOf(empty) : null;
    if (box && !within(drag, pathOf(box))) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      if (line) { line.remove(); line = null; }
      if (inside !== box) { if (inside) inside.classList.remove('brick-edit-drop-inside'); inside = box; box.classList.add('brick-edit-drop-inside'); }
      target = { path: pathOf(box), where: 'inside' };
      return;
    }
    var n = nodeOf(e.target);
    if (!n || within(drag, pathOf(n))) { clearDrop(); return; }
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (inside) { inside.classList.remove('brick-edit-drop-inside'); inside = null; }
    var r = n.getBoundingClientRect(), row = isRow(n);
    var before = row ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    showLine(r, row, before);
    target = { path: pathOf(n), where: before ? 'before' : 'after' };
  }, true);
  document.addEventListener('drop', function(e){
    if (!drag) return;
    e.preventDefault();
    var t = target, from = drag;
    clearDrop(); drag = null;
    if (t && t.path !== from) tell({ brick: 'move', from: from, to: t.path, where: t.where });
  }, true);
  document.addEventListener('dragend', function(){ clearDrop(); drag = null; }, true);

  var timer;
  window.addEventListener('scroll', function(){
    clearTimeout(timer);
    timer = setTimeout(function(){ tell({ brick: 'scroll', y: Math.round(window.scrollY) }); }, 120);
  }, { passive: true });
  function restore(){
    var m = /[#&]y=(\\d+)/.exec(location.hash);
    if (m) window.scrollTo(0, Number(m[1]));
    tell({ brick: 'ready' });
  }
  if (document.readyState === 'complete') restore(); else window.addEventListener('load', restore);
})();
</script>`;
