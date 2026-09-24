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
 * 스크롤 위치는 주소의 `#y=` 로 되돌린다 — 편집할 때마다 미리보기를 새로 그리므로, 그대로 두면
 * 긴 페이지 아래쪽을 고치는 동안 매번 맨 위로 튄다.
 */
export const EDIT_RUNTIME = `<style>
.brick-edit-node.brick-edit-hover{outline:1px dashed rgba(37,99,235,.7);outline-offset:-1px;cursor:pointer}
.brick-edit-selected{position:relative;outline:2px solid #2563eb!important;outline-offset:-2px}
.brick-edit-selected::before{content:attr(data-brick-tag);position:absolute;top:0;left:0;z-index:2147483646;background:#2563eb;color:#fff;font:600 11px/1.7 system-ui,sans-serif;padding:0 6px;border-radius:0 0 var(--radius,4px) 0;pointer-events:none;white-space:nowrap}
.brick-edit-missing{border:2px dashed #d97706;border-radius:var(--radius,6px);padding:14px;margin:4px 0;color:#92400e;background:#fffbeb;font:13px/1.5 system-ui,sans-serif}
</style>
<script>
(function(){
  var P = window.parent;
  if (!P || P === window) return;
  var ORIGIN = location.origin;
  function tell(msg){ msg.brick = msg.brick || 'x'; P.postMessage(msg, ORIGIN); }
  function nodeOf(el){ return el && el.closest ? el.closest('[data-brick-node]') : null; }
  document.addEventListener('click', function(e){
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
