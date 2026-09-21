import { escapeHtml } from "@brick/plugin-sdk";
import { t } from "./i18n.js";

/**
 * 우편번호·주소 검색.
 *
 * 주문서는 우편번호를 다섯 자리 숫자로 **직접 받고** 있었다. 한국에서 자기
 * 우편번호를 외우는 사람은 거의 없다 — 새 주소 체계(2015년)로 바뀐 뒤로는
 * 더 그렇다. 그래서 손님은 주문하다 말고 다른 창에서 우편번호를 찾아 와야
 * 했고, 그 지점이 한국 쇼핑몰에서 가장 흔한 이탈 자리다. 게다가 이 사이트는
 * 우편번호로 **제주·도서산간 추가 배송비**를 계산하므로, 손님이 대충 적으면
 * 금액까지 틀어진다.
 *
 * 다음(카카오) 우편번호 서비스를 쓴다 — 키도 계약도 없고, 한국 쇼핑몰이
 * 사실상 전부 쓰는 그 창이다. 두 가지를 지킨다:
 *
 *  1. **누르기 전에는 아무것도 불러오지 않는다.** 스크립트는 손님이 "주소
 *     검색"을 누른 순간 처음 내려온다 — 주문서를 열기만 한 사람의 브라우저가
 *     제3자에 붙지 않는다.
 *  2. **없어도 주문은 된다.** 스크립트를 못 불러오면 안내만 띄우고 칸은 그대로
 *     쓸 수 있다. 편의 기능이 결제를 막으면 안 된다.
 *
 * 운영자가 끌 수 있다(쇼핑몰 설정의 `addressSearch`) — 해외로만 파는 가게나
 * 제3자 스크립트를 일절 두지 않으려는 곳을 위해서다.
 */
export const ADDRESS_SEARCH_SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";

/** 우편번호 칸 옆에 붙는 버튼 + 검색 창이 열릴 자리 */
export function addressSearchField(): string {
  return `<button type="button" class="brick-addr-btn" data-addr-search>${escapeHtml(t("addr.search"))}</button>
<div class="brick-addr-layer" data-addr-layer hidden>
  <div class="brick-addr-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("addr.title"))}">
    <div class="brick-addr-head">
      <strong>${escapeHtml(t("addr.title"))}</strong>
      <button type="button" class="brick-addr-close" data-addr-close>${escapeHtml(t("addr.close"))}</button>
    </div>
    <div class="brick-addr-embed" data-addr-embed></div>
  </div>
</div>
<p class="brick-addr-msg" role="alert"></p>`;
}

/**
 * 검색 스크립트.
 *
 * 폼 안의 `[name=postcode]`·`[name=address1]`·`[name=address2]` 를 채운다 —
 * 주문서와 정기배송 신청서가 같은 칸 이름을 쓰므로 한 벌로 둘 다 산다.
 */
export function addressSearchScript(): string {
  return `
<script>
(function(){
  var root = document.querySelector('[data-addr-search]');
  if (!root) return;
  var form = root.closest('form') || document;
  var layer = form.querySelector('[data-addr-layer]') || document.querySelector('[data-addr-layer]');
  var box = layer && layer.querySelector('[data-addr-embed]');
  var msg = form.querySelector('.brick-addr-msg') || document.querySelector('.brick-addr-msg');
  var loading = null;

  function say(text){ if (msg) msg.textContent = text; }

  /* 스크립트는 **누른 뒤에** 처음 내려온다. 한 번만 받고 다시 쓴다. */
  function loadScript(){
    if (window.daum && window.daum.Postcode) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = ${JSON.stringify(ADDRESS_SEARCH_SRC)};
      s.onload = function(){ resolve(); };
      s.onerror = function(){ loading = null; reject(new Error('load')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function close(){
    if (!layer) return;
    layer.hidden = true;
    if (box) box.innerHTML = '';
    root.focus();
  }

  function fill(data){
    var road = data.roadAddress || data.jibunAddress || '';
    /*
     * 참고항목(동 이름·건물명)은 **도로명 주소일 때만** 붙인다 — 지번 주소에
     * 붙이면 같은 말이 두 번 들어간다. 다음이 배포하는 예제와 같은 규칙이다.
     */
    var extra = '';
    if (data.userSelectedType !== 'J') {
      var parts = [];
      if (data.bname && /[동|로|가]$/.test(data.bname)) parts.push(data.bname);
      if (data.buildingName && data.apartment === 'Y') parts.push(data.buildingName);
      if (parts.length) extra = ' (' + parts.join(', ') + ')';
    }
    var post = form.querySelector('[name="postcode"]');
    var addr1 = form.querySelector('[name="address1"]');
    var addr2 = form.querySelector('[name="address2"]');
    if (post) {
      post.value = data.zonecode || '';
      // 지역 추가 배송비는 우편번호가 바뀔 때 다시 계산된다 — 그 경로를 깨우려면 이벤트가 필요하다
      post.dispatchEvent(new Event('input', { bubbles: true }));
      post.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (addr1) {
      addr1.value = road + extra;
      addr1.dispatchEvent(new Event('input', { bubbles: true }));
    }
    close();
    // 손님이 이어서 할 일은 **상세 주소**다 — 거기로 데려간다
    if (addr2) addr2.focus();
  }

  root.addEventListener('click', function(){
    say('');
    root.disabled = true;
    loadScript().then(function(){
      root.disabled = false;
      if (!layer || !box) return;
      layer.hidden = false;
      new window.daum.Postcode({
        oncomplete: fill,
        onclose: function(state){ if (state === 'FORCE_CLOSE') close(); },
        width: '100%',
        height: '100%',
      }).embed(box);
      /*
       * **빈 상자를 그냥 두지 않는다.**
       *
       * 창이 뜨지 않는 이유는 여럿이다(사이트 정책에 출처가 없다, 서비스가
       * 잠시 죽었다, 회사망이 막았다). 어느 쪽이든 손님에게는 까만 네모일
       * 뿐이라 고장으로 보이고, 주문을 그만두게 된다. 몇 초 뒤에도 창이
       * 그려지지 않았으면 닫고 **직접 입력하면 된다고** 말한다.
       *
       * 브라우저의 정책 위반 신호(securitypolicyviolation)로는 못 잡는다 —
       * 그 위반은 위젯이 만든 iframe 안에서 일어나므로 이 문서까지 오지 않는다.
       * 그래서 "그려졌는가"를 직접 본다.
       */
      setTimeout(function(){
        if (!layer || layer.hidden) return;
        var frame = box.querySelector('iframe');
        if (frame && frame.getBoundingClientRect().height > 0) return;
        close();
        say(${JSON.stringify(t("addr.blocked"))});
      }, 6000);
    }).catch(function(){
      root.disabled = false;
      // 편의 기능이 결제를 막으면 안 된다 — 직접 입력하면 된다고 말한다
      say(${JSON.stringify(t("addr.failed"))});
    });
  });

  if (layer) {
    layer.addEventListener('click', function(e){ if (e.target === layer) close(); });
    var closeBtn = layer.querySelector('[data-addr-close]');
    if (closeBtn) closeBtn.addEventListener('click', close);
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && layer && !layer.hidden) close();
  });
})();
</script>`;
}

export const ADDRESS_SEARCH_CSS = `
<style>
.brick-addr-btn { min-height: 40px; padding: 0 14px; cursor: pointer; font: inherit; font-size: 13.5px; white-space: nowrap; }
.brick-addr-msg { font-size: 12.5px; color: var(--color-danger, #c8322f); margin: 6px 0 0; min-height: 16px; }
.brick-addr-layer { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; }
.brick-addr-layer[hidden] { display: none; }
.brick-addr-panel { background: var(--color-bg, #fff); border-radius: var(--radius-lg, 12px); width: min(520px, 100%); max-height: min(640px, 90vh); display: flex; flex-direction: column; overflow: hidden; }
.brick-addr-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-line, #e4e4ea); }
.brick-addr-close { min-height: 36px; padding: 0 12px; cursor: pointer; font: inherit; font-size: 13.5px; }
.brick-addr-embed { flex: 1; min-height: 420px; }
.brick-addr-embed > div { width: 100% !important; height: 100% !important; }
</style>`;
