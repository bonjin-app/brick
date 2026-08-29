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
    "color-primary": "#e2574c",
    "font-body": "'Pretendard', sans-serif"
  },
  "assets": "assets"
}
```

`tokens`는 CSS 변수(`--color-primary` 등)로 layout에 주입됩니다 — `{{{ themeTokens }}}`.

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
| `locale` | 사이트 언어 (`site.locale` — `<html lang="{{ locale }}">` 에 쓰세요) |
| `t.*` | 번역된 라벨 — 예: `{{ t.footer.company }}`(상호/Company). 값이 아니라 **라벨**만 번역됩니다 |
| `site.business.*` | 사업자정보 (값 — 번역되지 않습니다) |

page.html 슬롯은 추가로 `title`(페이지 제목), `{{{ blocksHtml }}}`(블록 트리 렌더 결과)를 받습니다.

## 최소 layout.html

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{ pageTitle }}</title>
  {{#if seo.description}}<meta name="description" content="{{ seo.description }}" />{{/if}}
  <style>{{{ themeTokens }}}</style>
  <link rel="stylesheet" href="{{ themeAssets }}/style.css" />
</head>
<body>
  <header><a href="/">{{ site.name }}</a></header>
  <main>{{{ content }}}</main>
</body>
</html>
```

테마가 `<html>`부터 문서 전체를 소유합니다. React를 몰라도 테마를 만들 수 있습니다.

## 배포

```bash
zip -r my-theme.zip brick.theme.json templates assets
```

관리자 → 테마 → 업로드 → 적용. 빌드 과정이 없으므로 **즉시** 반영됩니다.

레퍼런스 구현: [themes/default](../themes/default)
