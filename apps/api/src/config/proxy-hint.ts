/*
 * "프록시 뒤에 있는데 BRICK_TRUST_PROXY 를 켜지 않았다" 를 알아채는 곳.
 *
 * 이 설정은 부팅 시점에는 검증할 수 없다 — 프록시가 있는지는 **요청이 와야**
 * 알 수 있기 때문이다. 그래서 지금까지 아무도 묻지 않았고, 틀렸을 때의 대가는
 * 조용하다:
 *
 *   trustProxy 가 꺼져 있으면 `req.ip` 는 손님이 아니라 **프록시의 주소**다.
 *   Nginx/Caddy 를 앞에 둔 보통의 배포에서는 그 값이 모든 요청에 대해 똑같다
 *   (127.0.0.1). IP 기준 제한 — 로그인 시도, 회원가입, 재입고 알림, 비회원
 *   주문 — 이 전부 **한 바구니**로 합쳐진다. 손님 한 명이 한도를 채우면 나머지
 *   전부가 막히고, 공격자는 한 대로 모두를 잠글 수 있다. 반대로 차단 목록은
 *   프록시 주소만 보므로 개별 IP 차단이 아무 효과가 없다.
 *
 * 판정: trustProxy 가 꺼진 상태에서 X-Forwarded-For(또는 Forwarded) 헤더가
 * 달린 요청이 오면 앞에 무언가 있다는 뜻이다. 헤더는 위조될 수 있지만 — 그래서
 * 이것으로 동작을 바꾸지는 않는다 — 운영자에게 "확인해 보라"고 말하기에는 충분하다.
 * 실제로 헤더를 **믿는** 것은 여전히 trustProxy 를 켠 경우뿐이다.
 */
let seen = false;

/** 신뢰하지 않는 상태에서 프록시 헤더를 본 적이 있는가 */
export function sawProxyHeaders(): boolean {
  return seen;
}

/** 요청 헤더를 보고 기록한다 (trustProxy 가 꺼져 있을 때만 호출된다) */
export function noteProxyHeaders(headers: Record<string, unknown>): void {
  if (seen) return;
  if (headers["x-forwarded-for"] || headers["forwarded"] || headers["x-real-ip"]) seen = true;
}

/** 테스트용 초기화 */
export function resetProxyHint(): void {
  seen = false;
}
