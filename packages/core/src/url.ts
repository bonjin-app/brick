/**
 * 공개 주소 검사 — 사용자·운영자가 넣은 주소를 `<img src>` · `<meta content>` · 사이트맵 · 링크에 실어도 되는가.
 *
 * 이 규칙이 여섯 곳에 넷으로 갈라져 적혀 있었다. 어긋난 결과가 이미 보였다: 후기·문의 첨부·반품 사진·글 썸네일은
 * `/^(\/|https?:\/\/)/` 라 `//남의도메인/x.png`(프로토콜 상대 주소 — 보는 사람의 브라우저가 남의 서버를 부른다)를
 * 통과시켰고, 공유 이미지·사이트맵은 막았다. `HTTPS://` 는 한쪽이 대소문자를 가려 깨진 주소를 만들었다.
 *
 * 규칙 하나:
 *   - `http://`·`https://` 절대 주소(대소문자 무관, 호스트 필수) 또는 `/` 로 시작하는 **사이트 안 경로**
 *   - `//` 로 시작하는 것, `\` 가 든 것(브라우저가 `/` 로 읽는다), 공백·제어문자가 든 것은 거절
 *   - `javascript:`·`data:` 등 그 밖의 스킴은 거절
 * 거르는 것은 "실어도 되는가" 까지다 — 이스케이프는 싣는 자리(escapeHtml·escapeXml)의 몫이다.
 */

/** 기본 길이 상한 — DB 컬럼과 사이트맵 한 줄이 감당하는 선 */
export const MAX_PUBLIC_URL_LENGTH = 2000;

const FORBIDDEN = /[\u0000- \u007f\\]/;

/** 실어도 되는 주소면 다듬은 값을, 아니면 null */
export function publicUrl(value: unknown, opts: { maxLen?: number } = {}): string | null {
  const v = String(value ?? "").trim();
  if (!v || v.length > (opts.maxLen ?? MAX_PUBLIC_URL_LENGTH)) return null;
  if (FORBIDDEN.test(v)) return null;
  if (/^https?:\/\/[^/]/i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  return null;
}

/**
 * 주소 목록 — 실어도 되는 것만, 같은 것은 한 번, `max` 개까지. 배열이 아니면 빈 목록.
 * (후기 사진 5장·문의 첨부 5개·사이트맵 이미지 10장처럼 상한이 있는 자리가 쓴다)
 */
export function publicUrls(list: unknown, opts: { max?: number; maxLen?: number } = {}): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const u = publicUrl(raw, { maxLen: opts.maxLen });
    if (u && !out.includes(u)) out.push(u);
    if (opts.max !== undefined && out.length >= opts.max) break;
  }
  return out;
}

/**
 * 절대 주소로 — og:image 나 사이트맵처럼 사이트 밖에서 읽히는 자리는 절대 주소여야 한다.
 * `publicUrl` 을 통과한 값에 쓴다(경로는 `siteUrl` 을 앞에 붙이고, 절대 주소는 그대로).
 */
export function toAbsoluteUrl(url: string, siteUrl: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${siteUrl.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}
