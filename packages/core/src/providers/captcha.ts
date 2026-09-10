/**
 * 캡차 추상화.
 *
 * 왜 필요한가: 비회원 글쓰기·댓글·회원가입은 스팸의 주 표적이다.
 * 도배 방지(작성 간격)만으로는 분산된 봇을 막을 수 없다.
 *
 * 왜 외부 서비스를 기본으로 쓰지 않는가: reCAPTCHA/Turnstile은 API 키 발급이 필요하고,
 * 그러면 "설치가 쉬워야 한다"(ADR-1)가 깨진다. 기본 구현은 키 없이 동작하고,
 * 더 강한 방어가 필요하면 플러그인이 이 인터페이스를 구현해 교체한다.
 */
export interface CaptchaChallenge {
  /** 검증에 함께 보내야 하는 토큰 (정답이 서명되어 담겨 있다) */
  token: string;
  /** 화면에 표시할 SVG 이미지 */
  svg: string;
  /** 사용자에게 보여줄 안내 (스크린리더용 대체 텍스트로도 쓴다) */
  hint: string;
}

export interface CaptchaProvider {
  /** 사용 중인 구현 이름 (관리자 화면 표시용) */
  readonly name: string;
  /** 캡차가 실제로 검사를 수행하는가. false면 항상 통과한다(개발·비활성) */
  readonly enabled: boolean;
  /** 새 문제 발급 */
  issue(): Promise<CaptchaChallenge>;
  /**
   * 검증. 성공하면 true.
   *
   * **1회용이어야 한다** — 같은 토큰으로 두 번 통과하면 봇이 한 번 풀고 무한히 재사용한다.
   */
  verify(token: string, answer: string): Promise<boolean>;
}

/** 캡차를 끈 상태 — 항상 통과시킨다 */
export class DisabledCaptchaProvider implements CaptchaProvider {
  readonly name = "disabled";
  readonly enabled = false;

  async issue(): Promise<CaptchaChallenge> {
    return { token: "", svg: "", hint: "" };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

/* ══════════════════════════════════════════════════════════════
   비회원 폼에 붙이는 캡차 위젯 — HTML · CSS · 브라우저 스크립트

   왜 코어에 두는가: 캡차를 요구하는 화면이 게시판·문의·재입고 알림으로
   늘어났다. 같은 위젯을 플러그인마다 베껴 두면 한 곳만 고쳐진다 — 그런
   어긋남 때문에 회원가입 화면은 서버가 캡차를 요구하는데 입력 칸이 없는
   상태로 오래 있었다. 붙이는 쪽은 필드를 넣고, 보낼 때 값만 꺼내 쓴다.
   ══════════════════════════════════════════════════════════════ */

/** 위젯 문구 — 플러그인이 자기 i18n 으로 번역해 넘긴다 */
export interface CaptchaWidgetLabels {
  label: string;
  reload: string;
  placeholder: string;
}

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 비회원용 자동입력 방지 필드.
 *
 * 이미지는 클라이언트가 `/api/captcha` 로 받아 채운다 — 서버 렌더에 넣으면
 * 캐시된 페이지에 같은 문제가 박혀 무의미해진다.
 */
export function captchaFieldHtml(labels: CaptchaWidgetLabels): string {
  return `<div class="brick-field brick-captcha" data-captcha>
      <span class="brick-label">${esc(labels.label)}</span>
      <div class="brick-captcha-row">
        <span class="brick-captcha-image" aria-live="polite"></span>
        <button type="button" data-captcha-reload title="${esc(labels.reload)}">&#8635;</button>
        <input name="captchaAnswer" autocomplete="off" maxlength="10" placeholder="${esc(labels.placeholder)}" required />
      </div>
      <input type="hidden" name="captchaToken" value="" />
    </div>`;
}

/**
 * 위젯 스크립트. `[data-captcha]` 를 찾아 그림을 채우고,
 * `window.brickCaptcha.of(form)` 로 값을 꺼내 쓰게 한다.
 *
 * 캡차가 꺼져 있으면(`enabled:false`) 칸을 숨기고 `required` 를 푼다 —
 * 그러지 않으면 캡차를 끈 사이트에서 폼을 아예 낼 수 없다.
 */
export const CAPTCHA_WIDGET_JS = `
(function () {
  if (window.brickCaptcha) return;
  var loading = ${JSON.stringify("불러오는 중…")};
  var failed = ${JSON.stringify("불러올 수 없습니다")};

  function attach(box) {
    if (box.brickCaptchaReady) return;
    box.brickCaptchaReady = true;
    var img = box.querySelector('.brick-captcha-image');
    var tokenField = box.querySelector('input[name=captchaToken]');
    var answerField = box.querySelector('input[name=captchaAnswer]');

    function load() {
      img.innerHTML = '<span class="brick-captcha-loading">' + loading + '</span>';
      fetch('/api/captcha', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.enabled) {
            box.hidden = true;
            if (answerField) answerField.required = false;
            return;
          }
          img.innerHTML = d.svg;
          tokenField.value = d.token;
        })
        .catch(function () {
          img.innerHTML = '<span class="brick-captcha-loading">' + failed + '</span>';
        });
    }
    load();
    // 폼 제출이 실패해 다시 시도할 때는 새 문제를 받아야 한다 (토큰은 1회용)
    box.captchaReload = load;
    var reload = box.querySelector('[data-captcha-reload]');
    if (reload) reload.addEventListener('click', function () { answerField.value = ''; load(); });
  }

  function attachAll(root) {
    (root || document).querySelectorAll('[data-captcha]').forEach(attach);
  }
  attachAll(document);

  window.brickCaptcha = {
    attach: attachAll,
    /** 폼 안의 캡차 값과, 실패 후 새 문제를 받는 함수 */
    of: function (form) {
      var box = form && form.querySelector('[data-captcha]');
      if (!box || box.hidden) return { fields: {}, reload: function () {} };
      return {
        fields: {
          captchaToken: box.querySelector('input[name=captchaToken]').value,
          captchaAnswer: box.querySelector('input[name=captchaAnswer]').value
        },
        reload: function () { if (box.captchaReload) box.captchaReload(); }
      };
    }
  };
})();`;

/**
 * 위젯 CSS. 테마 변수를 쓰므로 어느 테마에서도 어울린다.
 *
 * 글자색·배경색을 **둘 다 명시한다.** 상속에 맡기면 붙이는 폼의 규칙을 물려받는다 —
 * 재입고 알림 폼은 자기 버튼을 강조색으로 칠하느라 `color:var(--color-on-primary)` 를
 * 걸어 두었고, 다크 테마에서 그 값이 배경색과 같아 새로고침 글리프가 보이지 않았다.
 */
export const CAPTCHA_WIDGET_CSS = `
.brick-captcha-row{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.brick-captcha-image{display:inline-flex;align-items:center;min-width:160px;min-height:56px;background:var(--color-bg-soft, #f6f6f9);border-radius:6px}
.brick-captcha-image svg{display:block;border-radius:6px}
.brick-captcha-loading{color:var(--color-muted, #6c6c7a);font-size:12.5px;padding:0 10px}
.brick-captcha-row button{width:34px;height:34px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);color:var(--color-text, #17171c);cursor:pointer;font-size:16px}
.brick-captcha-row input{width:150px;padding:9px;border:1px solid var(--color-line, #e4e4ea);border-radius:6px;background:var(--color-bg, #ffffff);color:var(--color-text, #17171c);font-size:15px;letter-spacing:2px;text-transform:uppercase}`;
