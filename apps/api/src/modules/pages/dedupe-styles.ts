/**
 * 한 페이지에 똑같은 `<style>` 이 여러 번 실리지 않게 — 첫 것만 남긴다.
 *
 * 확장 블록은 자기 CSS 를 `<style>` 로 함께 내놓는다(어느 테마에서든 깨지지 않게 — 테마가 Tailwind 로
 * 빌드됐는지, 그 확장을 아는지에 기대지 않는다). 대가는 같은 블록을 여러 번 놓으면 같은 CSS 가 여러 번
 * 나간다는 것이다: 쇼핑몰 홈의 상품 진열 셋이 같은 21.8KB 를 세 번 실어 HTML 의 35% 가 반복이었다.
 * 블록마다 "이미 냈는지" 를 기억하게 하면 확장 작성자 모두가 같은 장치를 다시 만들어야 하므로, 페이지를
 * 조립하는 이 한 곳에서 내용이 **완전히 같은** 것만 걸러 낸다(확장은 아무것도 몰라도 된다).
 *
 * - 같은 CSS 의 두 번째는 아무것도 바꾸지 않는다. 문서 안 `<style>` 은 위치와 상관없이 문서 전체에 걸리고,
 *   순서는 같은 특이도끼리의 승패에만 쓰인다 — 그 사이에 같은 선택자를 같은 특이도로 덮는 다른 CSS 가
 *   끼어 있을 때만 결과가 달라진다(블록 CSS 는 자기 클래스만 쓰므로 실제로는 없다).
 * - `<script>` 와 주석 안은 건드리지 않는다 — 스크립트가 문자열로 만드는 `<style>` 은 HTML 이 아니다.
 * - 속성까지 같아야 같은 것이다(`media` 가 다르면 다른 CSS 다).
 */
const SEGMENT = /<script\b[\s\S]*?<\/script\s*>|<!--[\s\S]*?-->|<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

export function dedupeStyles(html: string): string {
  const seen = new Set<string>();
  return html.replace(SEGMENT, (whole: string, attrs: string | undefined, css: string | undefined) => {
    if (css === undefined) return whole; // 스크립트·주석
    const key = `${attrs ?? ""}\u0000${css.trim()}`;
    if (seen.has(key)) return "";
    seen.add(key);
    return whole;
  });
}
