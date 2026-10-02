/**
 * 테마 토큰 계약 — 화면을 그리는 확장과 코어 블록이 기대해도 되는 CSS 변수.
 *
 * 테마는 `brick.theme.json` 의 `tokens` 로 이 값을 정한다. 그런데 토큰은 테마에서만 왔기 때문에,
 * 남이 만든 테마가 하나를 빠뜨리면 그 변수를 쓰는 화면이 **확장마다 다른 색으로** 무너졌다 —
 * 확장들은 각자 `var(--color-muted, #999)` 같은 폴백을 적어 두었고, 같은 토큰의 폴백이 다섯 가지였다
 * (그중 #999 는 흰 바탕에서 대비 기준을 넘지 못한다). 빠진 토큰은 이제 렌더가 이 값으로 채운다 —
 * 확장은 폴백 없이 써도 되고, 써 둔 폴백은 테마 CSS 가 아예 없는 경우의 마지막 방어선일 뿐이다.
 *
 * 값은 동봉 기본 테마(themes/default)와 같다. 동봉 테마는 전부 스스로 정의한다(check-theme-contract).
 * 다크 값은 테마가 다크 팔레트를 **조금이라도** 줄 때만 채운다 — 주지 않은 테마는 라이트 고정이다.
 */
export const THEME_TOKENS: Readonly<Record<string, string>> = {
  "color-primary": "#cf4437",
  "color-primary-hover": "#b63a2e",
  "color-primary-soft": "#fdeeec",
  "color-primary-text": "#b63a2e",
  "color-on-primary": "#ffffff",
  "color-bg": "#ffffff",
  "color-bg-soft": "#f6f6f9",
  "color-bg-sunken": "#eeeef3",
  "color-text": "#17171c",
  "color-text-soft": "#45454f",
  "color-muted": "#6a6a78",
  "color-line": "#e4e4ea",
  "color-line-strong": "#d0d0d9",
  "color-danger": "#c9342f",
  "color-success": "#11795a",
  "color-warning": "#96610a",
  "shadow-sm": "0 1px 2px rgba(18, 18, 28, .07), 0 1px 8px rgba(18, 18, 28, .04)",
  "shadow-md": "0 4px 12px rgba(18, 18, 28, .09), 0 12px 32px rgba(18, 18, 28, .07)",
  "font-body": "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, system-ui, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', Roboto, sans-serif",
  "font-mono": "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  "radius": "10px",
  "radius-lg": "16px",
  "content-width": "1080px",
};

/**
 * 다크 팔레트의 기본값 (`dark-` 를 뗀 이름) — **색만.** 다크에서 라이트 값이 그대로 남으면 무너지는 것은 색
 * (어두운 바탕 위 어두운 글자)이고, 그림자는 라이트 값으로 남아도 읽힌다. 동봉 테마 여섯 벌이 실제로
 * 다크 그림자를 주지 않는다 — 채우면 그 테마들의 다크 화면이 기본 테마의 그림자로 바뀐다.
 */
export const THEME_DARK_TOKENS: Readonly<Record<string, string>> = {
  "color-primary": "#ff6f5f",
  "color-primary-hover": "#ff8b7d",
  "color-primary-soft": "#2c1a18",
  "color-primary-text": "#ff8f82",
  "color-on-primary": "#26100c",
  "color-bg": "#101116",
  "color-bg-soft": "#17181f",
  "color-bg-sunken": "#1c1d25",
  "color-text": "#ececf1",
  "color-text-soft": "#c3c3cd",
  "color-muted": "#9797a6",
  "color-line": "#292a33",
  "color-line-strong": "#3b3c48",
  "color-danger": "#ff7a72",
  "color-success": "#3ec79d",
  "color-warning": "#e5a844",
};

