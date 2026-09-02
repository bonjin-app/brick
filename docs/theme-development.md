# 테마 개발 가이드

Brick 테마는 **빌드가 필요 없는 런타임 템플릿**입니다.
ZIP을 업로드하면 즉시 적용됩니다 — Node.js도, 빌드 도구도 필요 없습니다.

## 구조

```
my-theme/
├── brick.theme.json      # manifest (필수)
├── templates/
│   ├── layout.html       # 문서 전체 골격 (필수)
│   ├── home.html         # 홈 슬롯
│   └── page.html         # 일반 페이지 슬롯
└── assets/               # CSS/이미지/폰트 → /themes/<name>/assets/* 로 서빙
    └── style.css
```

## manifest — brick.theme.json

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "displayName": "내 테마",
  "brickVersion": ">=0.0.1",
  "templates": {
    "layout": "templates/layout.html",
    "home": "templates/home.html",
    "page": "templates/page.html"
  },
  "tokens": {
    "color-primary": "#cf4437",
    "color-bg": "#ffffff",
    "color-text": "#17171c",
    "font-body": "'Pretendard', sans-serif",

    "dark-color-primary": "#ff6f5f",
    "dark-color-bg": "#101116",
    "dark-color-text": "#ececf1"
  },
  "assets": "assets"
}
```

`tokens`는 CSS 변수(`--color-primary` 등)로 layout에 주입됩니다 — `{{{ themeTokens }}}`.

### 다크 모드는 토큰 한 벌을 더 두는 것으로 끝납니다

**`dark-` 로 시작하는 키는 다크 팔레트입니다.** `dark-color-bg` 는
`--color-bg` 의 어두운 값이고, 코어가 두 규칙을 만들어 줍니다:

```css
:root { --color-bg: #ffffff }                                   /* 라이트 */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --color-bg: #101116 }        /* OS 가 다크 */
}
:root[data-theme="dark"] { --color-bg: #101116 }                 /* 손님이 고름 */
```

그래서 **스타일시트에서는 `var(--color-bg)` 만 쓰면 됩니다** — 다크 대응이
따라옵니다. 하드코딩한 `#fff`·`#888` 은 다크에서 반드시 깨지므로 쓰지 마세요.
`dark-` 토큰을 주지 않으면 다크 규칙 자체가 나오지 않습니다(라이트 고정).

손님의 선택은 `localStorage` 의 `brick-theme`(`"dark"`/`"light"`)에 있고,
`<html data-theme>` 로 적용됩니다. 토글을 만들려면 그 두 곳만 바꾸면 됩니다
(레퍼런스 테마의 `layout.html` 참고). **적용 스크립트는 `<head>` 에서
스타일시트보다 먼저** 두세요 — 아니면 다크 손님에게 흰 화면이 한 프레임
번쩍입니다.

로그인·회원가입·마이페이지는 테마가 아니라 Next 가 그리지만, 같은 팔레트를
`/api/themes/tokens.css` 로 받아 씁니다. 테마 색을 바꾸면 그 화면들도 함께
바뀝니다.

### 토큰 값 제약

값은 그대로 CSS 에 들어가므로 위생 검사를 통과해야 합니다 — 키는 CSS
식별자만, 값에는 `;` `{` `}` `<` `>` `\` `/*` `@` `url(` 을 쓸 수 없습니다
(200자 이내). 통과하지 못한 토큰은 조용히 버려집니다.

## 템플릿 문법

의도적으로 최소화되어 있습니다. **로직이 필요하면 테마가 아니라 블록(플러그인)으로 만드세요.**

| 문법 | 의미 |
|---|---|
| `{{ site.name }}` | 변수 치환 (HTML 이스케이프됨) |
| `{{{ content }}}` | raw HTML 삽입 (렌더된 블록/본문) |
| `{{#if user}} ... {{/if}}` | 조건 (같은 종류 블록의 중첩 가능) |
| `{{#each posts}} {{ title }} {{/each}}` | 반복 |
| `{{!-- 주석 --}}` | 주석 — HTML 주석과 달리 **응답에도 남지 않습니다** |

## layout.html이 받는 스코프

| 변수 | 설명 |
|---|---|
| `site.name` | 사이트 이름 |
| `pageTitle` | `<title>`에 넣을 완성된 문자열 (SEO 제목 포함) |
| `seo.description` | 메타 설명 (있을 때만) |
| `{{{ content }}}` | 슬롯(home/page)이 렌더된 결과 |
| `{{{ themeTokens }}}` | tokens가 CSS 변수로 변환된 `<style>` 내용물 |
| `themeAssets` | `/themes/<name>/assets` 경로 |
| `themeVersion` | **테마 스탬프** — 자산 URL 의 캐시버스터로 쓰세요: `style.css?v={{ themeVersion }}`. 테마 버전 + 테마 파일들의 최종 수정 시각이라, **파일을 고치면 자동으로 바뀝니다**(버전을 올리는 것을 기억하지 않아도 됩니다). 서버 렌더 캐시 키에도 같은 값이 섞입니다 |
| `locale` | 사이트 언어 (`site.locale` — `<html lang="{{ locale }}">` 에 쓰세요) |
| `t.*` | 번역된 라벨 — 예: `{{ t.footer.company }}`(상호/Company), `{{ t.header.login }}`. 값이 아니라 **라벨**만 번역됩니다 |
| `site.business.*` | 사업자정보 (값 — 번역되지 않습니다) |
| `user` | 로그인한 사용자 (`user.displayName`, `user.isAdmin`) — 비로그인이면 없음. 로그인 렌더는 캐시되지 않으므로 사용자별 내용이 새지 않습니다 |
| `headerActions` | 플러그인이 등록한 헤더 링크 (장바구니·쪽지함 등). `{{#each headerActions}}<a href="{{ url }}">{{ label }}</a>{{/each}}` — 테마는 쇼핑몰을 알 수 없으므로 플러그인이 등록하고 테마가 그립니다. 로그인 전용 항목은 걸러진 채로 옵니다 |
| `guest` | 비로그인 여부 — 엔진에 else 가 없어 `{{#if guest}}로그인 링크{{/if}}` 형태로 씁니다 |

로그아웃은 상태를 바꾸므로 링크(GET)가 아니라 **폼(POST)** 으로 만드세요 —
`<form method="post" action="/api/auth/logout">` 는 JS 없이 제출돼도 홈으로
돌아옵니다 (서버가 `accept: text/html` 제출에 303 을 응답합니다).

page.html 슬롯은 추가로 `title`(페이지 제목), `{{{ blocksHtml }}}`(블록 트리 렌더 결과)를 받습니다.

**`title` 은 비어 있을 수 있습니다.** 블록이 자기 화면의 제목을 정한 경우
(게시판 글 상세, 히어로가 있는 홈) 그 블록이 h1 을 그리므로 페이지 제목은
내려오지 않습니다 — 같은 말이 두 번 크게 적히지 않게. 그래서 `{{#if title}}`
로 감싸세요. `pageTitle`(문서 `<title>`)에는 항상 알맞은 값이 들어옵니다.

## 컴포넌트 프리미티브 — 블록이 기대하는 클래스

블록(게시판·상품·랜딩)은 **자기 CSS 로 버튼을 다시 그리지 않고** 테마의
클래스를 씁니다. 테마를 새로 만들 때 이 클래스들에 스타일을 주면 모든 블록이
함께 어울립니다 (레퍼런스: `themes/default/assets/style.css`).

| 클래스 | 쓰임 |
|---|---|
| `.brick-btn` + `.brick-btn-primary` / `-ghost` / `-danger` / `-sm` / `-lg` | 버튼·링크 버튼 |
| `.brick-card`, `.brick-card-soft`, `.brick-grid` | 카드와 카드 격자 |
| `.brick-badge` + `-primary` / `-success` / `-danger` / `-warning` | 상태 표시 |
| `.brick-notice` + `-info` / `-success` / `-warning` / `-danger` | 알림 박스 |
| `.brick-empty` | 빈 목록 안내 |
| `.brick-pager` (`.is-current`, `.is-disabled`) | 페이지네이션 |
| `.brick-hero`, `.brick-eyebrow`, `.brick-hero-actions` | 히어로 |
| `.brick-features`, `.brick-cta`, `.brick-faq-item` | 랜딩 섹션 |
| `.brick-nav a.is-current` | 현재 위치인 메뉴 항목 (코어가 `aria-current="page"` 와 함께 붙여 줍니다) |
| `.brick-hero.has-image` (`--hero-image`) | 사진 위 히어로 — 어둡게 깔고 흰 글자 |
| `.brick-media-text` (`.is-reverse`, `.no-media`), `.brick-media`, `.brick-media-body` | 이미지 + 글 분할 |
| `.brick-stats`, `.brick-stat` | 숫자 강조 띠 |
| `.brick-testimonials`, `.brick-quote` | 고객 후기 카드 |
| `.brick-image-gallery`, `.brick-image-grid` (`--cols`) | 이미지 갤러리 |
| `.brick-footer-cols`, `.brick-footer-col`, `.brick-footer-about/-nav/-contact` | 3열 푸터 |
| `.brick-actions` | 플러그인이 등록한 헤더 링크(장바구니·쪽지함) |

게시판 블록은 목록 스킨(`brick-list-basic/-gallery/-webzine`)·이전/다음(`brick-post-nav`)·
공유 막대(`brick-share`)의 CSS 를 **자기 것으로 들고 있습니다**(토큰만 씁니다) — 테마가
덮어 쓸 수 있습니다.

## 최소 layout.html

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{ pageTitle }}</title>
  {{#if seo.description}}<meta name="description" content="{{ seo.description }}" />{{/if}}
  <meta name="color-scheme" content="light dark" />
  <script>
    /* 손님이 고른 화면 모드를 CSS 보다 먼저 적용 (흰 화면 번쩍임 방지) */
    (function(){try{var v=localStorage.getItem("brick-theme");
    if(v==="dark"||v==="light")document.documentElement.dataset.theme=v;}catch(e){}})();
  </script>
  <style>{{{ themeTokens }}}</style>
  <link rel="stylesheet" href="{{ themeAssets }}/style.css?v={{ themeVersion }}" />
</head>
<body>
  <header><a href="/">{{ site.name }}</a></header>
  <main>{{{ content }}}</main>
</body>
</html>
```

테마가 `<html>`부터 문서 전체를 소유합니다. React를 몰라도 테마를 만들 수 있습니다.

## 대비 점검 — 눈으로는 안 보이는 것

라이트·다크 두 벌을 만들면 **보기엔 괜찮은데 읽기 힘든** 조합이 생깁니다.
흐린 회색 글자를 선 색 위에 올리는 식입니다 — 기본 테마에서도 상품 상세의
"이미지 없음"과 문의 상태 배지가 그랬습니다. 화면을 봐도 티가 안 나는데
측정하면 4.5:1 을 못 넘깁니다.

[scripts/contrast-audit.js](../scripts/contrast-audit.js) 를 개발자도구 콘솔에
붙이고 실행하면 여러 화면을 라이트·다크로 순회하며 WCAG AA(작은 글자 4.5:1,
큰 글자 3:1)를 검사합니다.

```js
await brickContrastAudit(["/", "/board/free", "/shop", "/shop/cart"])
```

반투명 배경(스티키 헤더)과 `color-mix()` 값까지 합성해서 계산하므로, 실제로
사람 눈에 닿는 색을 봅니다. 새 테마를 만들었다면 CSS 를 눈으로 다시 보는
것보다 이걸 돌리는 편이 빠릅니다.

## 배포

```bash
zip -r my-theme.zip brick.theme.json templates assets
```

관리자 → 테마 → 업로드 → 적용. 빌드 과정이 없으므로 **즉시** 반영됩니다.

레퍼런스 구현: [themes/default](../themes/default)
