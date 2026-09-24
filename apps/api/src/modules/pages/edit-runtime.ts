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
 * 스크롤 위치는 주소의 `#y=` 로 되돌린다 — 편집할 때마다 미리보기를 새로 그리므로, 그대로 두면
 * 긴 페이지 아래쪽을 고치는 동안 매번 맨 위로 튄다.
 */
export const EDIT_RUNTIME = `<style>
.brick-edit-node.brick-edit-hover{outline:1px dashed rgba(37,99,235,.7);outline-offset:-1px;cursor:pointer}
.brick-edit-selected{position:relative;outline:2px solid #2563eb!important;outline-offset:-2px}
.brick-edit-selected::before{content:attr(data-brick-tag);position:absolute;top:0;left:0;z-index:2147483646;background:#2563eb;color:#fff;font:600 11px/1.7 system-ui,sans-serif;padding:0 6px;border-radius:0 0 var(--radius,4px) 0;pointer-events:none;white-space:nowrap}
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
    tell({ brick: 'text', path: node.getAttribute('data-brick-node'), prop: el.getAttribute('data-brick-prop'), value: value.slice(0, 20000) });
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
    if (editing && editing.el.contains(e.target)) return;
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
    if (sel) { sel.classList.remove('brick-edit-selected'); sel.removeAttribute('data-brick-tag'); }
    sel = d.path ? document.querySelector('[data-brick-node="' + String(d.path).replace(/[^0-9.]/g, '') + '"]') : null;
    if (!sel) return;
    sel.classList.add('brick-edit-selected');
    sel.setAttribute('data-brick-tag', String(d.label || ''));
    if (d.reveal) sel.scrollIntoView({ block: 'nearest' });
  });
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
