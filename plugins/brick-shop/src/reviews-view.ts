import { escapeHtml } from "./types.js";

/**
 * 상품 상세의 후기·문의 영역.
 *
 * 껍데기만 서버에서 내고 목록은 클라이언트가 채운다. 이유는 캐시다:
 * 페이지 렌더 캐시(비회원 전용)에 "내 문의만 보이는 비밀 문의"나
 * "내가 쓴 후기 수정 버튼"이 섞이면 다른 사람에게 새어 나간다.
 * 후기 **개수와 평점**은 SEO에 필요하므로 서버에서 렌더한다.
 */
export function reviewSection(product: {
  id: string;
  reviewCount: number;
  ratingAvg: number;
  inquiryCount: number;
}): string {
  const stars = starBar(product.ratingAvg);
  return `
<section class="brick-pd-tabs" data-product="${escapeHtml(product.id)}">
  <nav class="brick-pd-tabnav" role="tablist">
    <button type="button" data-tab="reviews" class="is-on" role="tab">
      상품후기 <span>${product.reviewCount}</span>
    </button>
    <button type="button" data-tab="inquiries" role="tab">
      상품문의 <span>${product.inquiryCount}</span>
    </button>
  </nav>

  <div class="brick-pd-panel" data-panel="reviews">
    <div class="brick-review-summary">
      <div class="brick-review-score">
        <strong>${product.ratingAvg ? product.ratingAvg.toFixed(1) : "-"}</strong>
        <div class="brick-stars" aria-label="평균 별점 ${product.ratingAvg}점">${stars}</div>
        <small>후기 ${product.reviewCount}개</small>
      </div>
      <div class="brick-review-dist" data-dist></div>
    </div>
    <div data-review-form></div>
    <div data-review-list><p class="brick-shop-empty">불러오는 중…</p></div>
  </div>

  <div class="brick-pd-panel" data-panel="inquiries" hidden>
    <div data-inquiry-form></div>
    <div data-inquiry-list><p class="brick-shop-empty">불러오는 중…</p></div>
  </div>
</section>
${REVIEW_CSS}${REVIEW_SCRIPT}`;
}

/** 반개는 표현하지 않는다 — 텍스트 별은 반개가 오히려 읽기 어렵다 */
function starBar(avg: number): string {
  const filled = Math.round(avg);
  return "★★★★★".slice(0, filled) + "☆☆☆☆☆".slice(0, 5 - filled);
}

const REVIEW_CSS = `
<style>
.brick-pd-tabs{margin:48px 0}
.brick-pd-tabnav{display:flex;gap:0;border-bottom:2px solid #e6e6ee}
.brick-pd-tabnav button{flex:1;padding:14px;border:0;background:none;font-size:16px;cursor:pointer;color:#888;border-bottom:2px solid transparent;margin-bottom:-2px}
.brick-pd-tabnav button.is-on{color:inherit;font-weight:700;border-bottom-color:var(--color-primary,#d0402c)}
.brick-pd-tabnav button span{color:var(--color-primary,#d0402c)}
.brick-pd-panel{padding:24px 0}
.brick-review-summary{display:flex;gap:32px;align-items:center;padding:24px;background:#f8f8fb;border-radius:12px;flex-wrap:wrap}
.brick-review-score{text-align:center;min-width:120px}
.brick-review-score strong{display:block;font-size:38px;line-height:1}
.brick-stars{color:#f5a623;font-size:18px;letter-spacing:2px}
.brick-review-score small{color:#888;font-size:13px}
.brick-review-dist{flex:1;min-width:220px;display:grid;gap:5px}
.brick-dist-row{display:grid;grid-template-columns:34px 1fr 40px;align-items:center;gap:8px;font-size:13px;color:#666}
.brick-dist-bar{height:8px;background:#e6e6ee;border-radius:4px;overflow:hidden}
.brick-dist-bar i{display:block;height:100%;background:#f5a623}
.brick-review-item,.brick-inquiry-item{padding:20px 4px;border-bottom:1px solid #eee}
.brick-review-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px}
.brick-review-head time{color:#aaa;font-size:13px}
.brick-verified{font-size:11px;padding:2px 7px;border-radius:10px;background:#e8f4ea;color:#2b7a3d;font-weight:700}
.brick-hidden-flag{font-size:11px;padding:2px 7px;border-radius:10px;background:#fdecea;color:#b3261e;font-weight:700}
.brick-review-body{margin:10px 0 0;line-height:1.7;white-space:pre-wrap}
.brick-review-photos{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.brick-review-photos img{width:88px;height:88px;object-fit:cover;border-radius:8px}
.brick-admin-reply{margin:12px 0 0;padding:14px;background:#f6f7fb;border-radius:8px;font-size:14px;line-height:1.7;white-space:pre-wrap}
.brick-admin-reply b{display:block;margin-bottom:5px;font-size:13px;color:var(--color-primary,#d0402c)}
.brick-write-box{padding:20px;border:1px solid #e6e6ee;border-radius:12px;margin-bottom:24px}
.brick-write-box h3{margin:0 0 14px;font-size:16px}
.brick-write-box textarea{width:100%;min-height:96px;padding:11px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box;font:inherit}
.brick-write-box input[type=text]{width:100%;padding:11px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box;font:inherit;margin-bottom:10px}
.brick-rating-pick{display:flex;gap:4px;margin-bottom:12px;font-size:28px;line-height:1;cursor:pointer;color:#ddd}
.brick-rating-pick b{cursor:pointer;font-weight:400}
.brick-rating-pick b.is-on{color:#f5a623}
.brick-write-actions{display:flex;gap:10px;align-items:center;margin-top:12px}
.brick-write-actions button{padding:11px 22px;border:0;border-radius:8px;background:var(--color-primary,#d0402c);color:#fff;font-size:14px;font-weight:700;cursor:pointer}
.brick-write-msg{font-size:13px;color:#b3261e}
.brick-write-note{padding:16px;background:#f8f8fb;border-radius:10px;font-size:14px;color:#777;margin-bottom:24px}
.brick-secret-label{display:flex;gap:6px;align-items:center;font-size:14px;color:#666;margin-top:10px}
.brick-row-actions{margin-top:10px;display:flex;gap:8px}
.brick-row-actions button{padding:5px 12px;font-size:13px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer}
.brick-pd-more{display:block;width:100%;padding:13px;margin-top:16px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
.brick-gallery{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.brick-gallery button{padding:0;border:2px solid transparent;border-radius:8px;overflow:hidden;background:none;cursor:pointer;line-height:0}
.brick-gallery button.is-on{border-color:var(--color-primary,#d0402c)}
.brick-gallery img{width:64px;height:64px;object-fit:cover}
</style>`;

/**
 * 후기·문의 클라이언트.
 *
 * 프레임워크 없이 쓴다 — 테마는 빌드를 타지 않으므로 어떤 테마에서도 그대로 동작해야 한다.
 * 서버가 준 데이터만 그리고, HTML은 전부 이스케이프한다(저장형 XSS 방어).
 */
const REVIEW_SCRIPT = `
<script>
(function(){
  var root = document.currentScript.parentNode.querySelector('.brick-pd-tabs');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  var pid = root.dataset.product;
  var API = '/api/plugins/brick-shop';
  var state = { reviews: 1, inquiries: 1, myRating: 5 };

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function stars(n){ n = Math.round(Number(n)||0);
    return '★★★★★'.slice(0,n) + '☆☆☆☆☆'.slice(0, 5-n); }
  function day(s){ return String(s||'').slice(0,10); }
  function img(u){ return '<img src="' + esc(u) + '" alt="" loading="lazy" />'; }
  function photos(list){
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="brick-review-photos">' + list.slice(0,5).map(img).join('') + '</div>';
  }
  function reply(text){
    if (!text) return '';
    return '<div class="brick-admin-reply"><b>판매자 답변</b>' + esc(text) + '</div>';
  }
  function get(el, sel){ return el.querySelector(sel); }

  function json(url, opts){
    return fetch(url, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        return { ok: r.ok, status: r.status, d: d };
      });
    });
  }

  /* ── 탭 ── */
  root.querySelectorAll('.brick-pd-tabnav button').forEach(function(btn){
    btn.addEventListener('click', function(){
      root.querySelectorAll('.brick-pd-tabnav button').forEach(function(b){ b.classList.toggle('is-on', b === btn); });
      root.querySelectorAll('.brick-pd-panel').forEach(function(p){
        p.hidden = p.dataset.panel !== btn.dataset.tab;
      });
    });
  });

  /* ── 후기 ── */
  function renderDist(data){
    var box = get(root, '[data-dist]');
    var max = 0;
    for (var i = 1; i <= 5; i++) max = Math.max(max, Number((data.distribution||{})[i] || 0));
    var html = '';
    for (var r = 5; r >= 1; r--) {
      var n = Number((data.distribution||{})[r] || 0);
      var pct = max ? Math.round(n / max * 100) : 0;
      html += '<div class="brick-dist-row"><span>' + r + '점</span>' +
        '<span class="brick-dist-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span>' + n + '</span></div>';
    }
    box.innerHTML = html;
  }

  function renderReviews(data){
    renderDist(data);
    var list = get(root, '[data-review-list]');
    if (!data.items.length) {
      list.innerHTML = '<p class="brick-shop-empty">첫 후기를 남겨주세요.</p>';
      return;
    }
    list.innerHTML = data.items.map(function(r){
      return '<article class="brick-review-item" data-id="' + esc(r.id) + '">' +
        '<div class="brick-review-head">' +
          '<span class="brick-stars">' + stars(r.rating) + '</span>' +
          '<strong>' + esc(r.author_name) + '</strong>' +
          (r.verified ? '<span class="brick-verified">구매확인</span>' : '') +
          (r.is_visible === false ? '<span class="brick-hidden-flag">숨김</span>' : '') +
          '<time>' + day(r.created_at) + '</time>' +
        '</div>' +
        '<p class="brick-review-body">' + esc(r.content) + '</p>' +
        photos(r.images) + reply(r.admin_reply) +
        (r.mine ? '<div class="brick-row-actions"><button data-del-review>삭제</button></div>' : '') +
      '</article>';
    }).join('') + more(data, 'reviews');

    list.querySelectorAll('[data-del-review]').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (!confirm('후기를 삭제할까요?')) return;
        var id = btn.closest('[data-id]').dataset.id;
        json(API + '/reviews/' + id, { method: 'DELETE' }).then(function(){ loadReviews(1); loadForm(); });
      });
    });
    bindMore(list, 'reviews', loadReviews);
  }

  function more(data, kind){
    var shown = data.page * data.pageSize;
    if (shown >= data.total) return '';
    return '<button class="brick-pd-more" data-more="' + kind + '">더 보기 (' + (data.total - shown) + '개 남음)</button>';
  }
  function bindMore(list, kind, loader){
    var btn = list.querySelector('[data-more]');
    if (btn) btn.addEventListener('click', function(){ loader(state[kind] + 1, true); });
  }

  function loadReviews(page, append){
    state.reviews = page || 1;
    json(API + '/products/' + pid + '/reviews?page=' + state.reviews).then(function(res){
      if (!res.ok) { get(root, '[data-review-list]').innerHTML = '<p class="brick-shop-empty">후기를 불러올 수 없습니다.</p>'; return; }
      if (append) {
        // 더 보기: 기존 목록 뒤에 이어 붙인다
        var holder = document.createElement('div');
        var prev = get(root, '[data-review-list]');
        var oldItems = prev.querySelectorAll('.brick-review-item');
        renderReviews(res.d);
        var nowList = get(root, '[data-review-list]');
        oldItems.forEach(function(el){ nowList.insertBefore(el, nowList.firstChild); });
        holder = null;
      } else {
        renderReviews(res.d);
      }
    });
  }

  /* 후기 작성 폼은 자격이 있을 때만 보여준다 */
  function loadForm(){
    var box = get(root, '[data-review-form]');
    json(API + '/products/' + pid + '/reviews/eligibility').then(function(res){
      var d = res.d || {};
      if (d.canWrite) { box.innerHTML = writeForm(); bindWrite(box); return; }
      var note = d.reason === 'login' ? '로그인하고 구매하신 상품에 후기를 남길 수 있습니다.'
        : d.reason === 'already_written' ? '이미 이 상품에 후기를 작성하셨습니다.'
        : '구매하신 고객만 후기를 작성할 수 있습니다.';
      box.innerHTML = '<p class="brick-write-note">' + note + '</p>';
    });
  }

  function writeForm(){
    var picks = '';
    for (var i = 1; i <= 5; i++) picks += '<b data-star="' + i + '">★</b>';
    return '<div class="brick-write-box"><h3>후기 작성</h3>' +
      '<div class="brick-rating-pick" data-rating>' + picks + '</div>' +
      '<textarea data-content placeholder="상품은 어떠셨나요? (5자 이상)"></textarea>' +
      '<div class="brick-write-actions"><button data-submit>등록</button>' +
      '<span class="brick-write-msg" data-msg></span></div></div>';
  }

  function bindWrite(box){
    var pick = get(box, '[data-rating]');
    function paint(){
      pick.querySelectorAll('b').forEach(function(b){
        b.classList.toggle('is-on', Number(b.dataset.star) <= state.myRating);
      });
    }
    pick.querySelectorAll('b').forEach(function(b){
      b.addEventListener('click', function(){ state.myRating = Number(b.dataset.star); paint(); });
    });
    paint();

    get(box, '[data-submit]').addEventListener('click', function(){
      var msg = get(box, '[data-msg]');
      msg.textContent = '';
      json(API + '/products/' + pid + '/reviews', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ rating: state.myRating, content: get(box, '[data-content]').value })
      }).then(function(res){
        if (!res.ok) { msg.textContent = res.d.message || '등록에 실패했습니다.'; return; }
        loadReviews(1); loadForm();
      });
    });
  }

  /* ── 문의 ── */
  function renderInquiries(data){
    var list = get(root, '[data-inquiry-list]');
    if (!data.items.length) {
      list.innerHTML = '<p class="brick-shop-empty">등록된 문의가 없습니다.</p>';
      return;
    }
    list.innerHTML = data.items.map(function(q){
      var locked = q.content === null;
      return '<article class="brick-inquiry-item" data-id="' + esc(q.id) + '">' +
        '<div class="brick-review-head">' +
          (q.is_secret ? '<span class="brick-verified">비밀</span>' : '') +
          '<strong>' + esc(q.title) + '</strong>' +
          '<span>' + esc(q.author_name) + '</span>' +
          '<time>' + day(q.created_at) + '</time>' +
          '<span class="brick-stars" style="font-size:12px;letter-spacing:0">' +
            (q.status === 'answered' ? '답변완료' : '답변대기') + '</span>' +
        '</div>' +
        (locked ? '' : '<p class="brick-review-body">' + esc(q.content) + '</p>') +
        (locked ? '' : reply(q.admin_reply)) +
        (q.mine ? '<div class="brick-row-actions"><button data-del-inq>삭제</button></div>' : '') +
      '</article>';
    }).join('') + more(data, 'inquiries');

    list.querySelectorAll('[data-del-inq]').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (!confirm('문의를 삭제할까요?')) return;
        var id = btn.closest('[data-id]').dataset.id;
        json(API + '/inquiries/' + id, { method: 'DELETE' }).then(function(){ loadInquiries(1); });
      });
    });
    bindMore(list, 'inquiries', loadInquiries);
  }

  function loadInquiries(page, append){
    state.inquiries = page || 1;
    json(API + '/products/' + pid + '/inquiries?page=' + state.inquiries).then(function(res){
      if (!res.ok) { get(root, '[data-inquiry-list]').innerHTML = '<p class="brick-shop-empty">문의를 불러올 수 없습니다.</p>'; return; }
      if (append) {
        var prev = get(root, '[data-inquiry-list]');
        var oldItems = prev.querySelectorAll('.brick-inquiry-item');
        renderInquiries(res.d);
        var nowList = get(root, '[data-inquiry-list]');
        oldItems.forEach(function(el){ nowList.insertBefore(el, nowList.firstChild); });
      } else {
        renderInquiries(res.d);
      }
    });
  }

  function inquiryForm(){
    var box = get(root, '[data-inquiry-form]');
    // 로그인 여부는 자격 확인 응답을 재사용한다 (요청 하나를 아낀다)
    json(API + '/products/' + pid + '/reviews/eligibility').then(function(res){
      if ((res.d || {}).reason === 'login') {
        box.innerHTML = '<p class="brick-write-note">문의를 남기려면 로그인해주세요.</p>';
        return;
      }
      box.innerHTML = '<div class="brick-write-box"><h3>상품 문의</h3>' +
        '<input type="text" data-title placeholder="제목" />' +
        '<textarea data-content placeholder="궁금하신 점을 남겨주세요."></textarea>' +
        '<label class="brick-secret-label"><input type="checkbox" data-secret />' +
        '비밀글로 문의 (작성자와 판매자만 볼 수 있습니다)</label>' +
        '<div class="brick-write-actions"><button data-submit>등록</button>' +
        '<span class="brick-write-msg" data-msg></span></div></div>';

      get(box, '[data-submit]').addEventListener('click', function(){
        var msg = get(box, '[data-msg]');
        msg.textContent = '';
        json(API + '/products/' + pid + '/inquiries', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({
            title: get(box, '[data-title]').value,
            content: get(box, '[data-content]').value,
            isSecret: get(box, '[data-secret]').checked
          })
        }).then(function(res){
          if (!res.ok) { msg.textContent = res.d.message || '등록에 실패했습니다.'; return; }
          get(box, '[data-title]').value = '';
          get(box, '[data-content]').value = '';
          loadInquiries(1);
        });
      });
    });
  }

  loadReviews(1);
  loadForm();
  loadInquiries(1);
  inquiryForm();
})();
</script>`;
