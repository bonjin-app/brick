/**
 * 텍스트 유틸.
 *
 * 코어에 두는 이유: 검색 발췌와 메일 텍스트 대안이 같은 HTML 제거 규칙을
 * 써야 하고, **플러그인도 써야 한다**(게시글·상품 본문은 HTML 이다).
 * 세 곳에 복제하면 반드시 갈라진다.
 */

/**
 * HTML 태그를 벗겨 읽을 수 있는 텍스트로.
 *
 * 줄바꿈이 되는 태그(`<br>`, `</p>`)는 줄바꿈으로 바꾼다 — 그냥 지우면
 * 문장이 붙어서 "가격은10000원입니다배송비별도" 처럼 읽을 수 없게 된다.
 */
export function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 검색어 주변을 잘라 발췌문을 만든다.
 *
 * 검색어가 본문 뒤쪽에 있으면 앞부분만 보여줘서는 **왜 이 결과가 나왔는지
 * 알 수 없다.** 검색어 위치를 찾아 그 주변을 자른다.
 *
 * HTML 이 섞여 있으면 먼저 벗긴다 — 태그가 발췌문에 들어가면 읽을 수 없고,
 * 그대로 화면에 넣으면 레이아웃이 깨진다.
 */
export function searchExcerpt(text: string, query: string, length = 150): string {
  const body = stripHtml(String(text ?? "")).replace(/\s+/g, " ").trim();
  if (!body) return "";
  const idx = body.toLowerCase().indexOf(String(query ?? "").toLowerCase());
  if (idx < 0) return body.slice(0, length);
  const start = Math.max(0, idx - Math.floor(length / 3));
  const slice = body.slice(start, start + length);
  return (start > 0 ? "…" : "") + slice + (start + length < body.length ? "…" : "");
}

/**
 * HTML 특수문자 이스케이프.
 *
 * `String(s ?? "")` 로 감싸는 것이 중요하다. 원래 구현은 `s.replace` 를 바로
 * 불러서 **undefined 가 들어오면 터졌다** — 잘못된 블록을 "unknown block"
 * 주석으로 넘기려던 코드가 그 자리에서 500 을 냈다. 이스케이프는 화면을
 * 안전하게 만드는 함수인데, 그것이 요청을 죽이면 안 된다.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * 이메일 가리기.
 *
 * 목록·응답·로그에 주소를 그대로 내보내면 개인정보가 새어 나간다. 본인이
 * 자기 것인지 알아볼 수 있을 만큼만 남긴다.
 *
 * 앞 2자만 남기는 이유: 한 글자만 남기면 `a***@x.com` 처럼 되어 본인도
 * 구분하지 못하고, 절반을 남기면 짧은 주소가 거의 그대로 노출된다.
 */
export function maskEmail(email: string): string {
  const [local, domain] = String(email ?? "").split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}
