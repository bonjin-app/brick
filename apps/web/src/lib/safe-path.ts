/**
 * 되돌아갈 주소(`?next=` 등)가 **같은 사이트의 경로**인지 — 브라우저의 해석으로 판단한다.
 *
 * 전에는 "첫 글자가 `/` 이고 둘째가 `/` 가 아니면 통과" 라는 문자열 규칙이었다. 그런데
 * 브라우저의 URL 해석(WHATWG)은 http(s) 주소에서 **역슬래시를 슬래시로** 읽고 탭·줄바꿈을
 * 지운다. 그래서 `/\evil.example` 이나 `/<탭>/evil.example` 은 규칙을 통과한 뒤 실제로는
 * `https://evil.example/` 로 갔다. 로그인 링크에 실어 보내면 손님이 **진짜 사이트에서**
 * 로그인한 직후 공격자 사이트로 넘어간다 — "세션이 만료됐으니 다시 로그인" 같은 가짜
 * 화면으로 비밀번호를 받아 가는 전형적인 경로다.
 *
 * 문자열로 흉내 내지 않고 해석기에 맡긴다: 풀어 본 결과의 출처가 지금 사이트와 같을 때만
 * 받는다. 해석기가 무엇을 어떻게 읽든 그 결과를 그대로 판단하게 된다.
 */
export function sameOriginPath(raw: string | null | undefined, origin: string): string | null {
  const v = String(raw ?? "");
  // 경로로 시작해야 한다 — "javascript:…"·"https://…" 는 여기서 걸러진다
  if (!v.startsWith("/")) return null;
  try {
    const u = new URL(v, origin);
    if (u.origin !== new URL(origin).origin) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}
