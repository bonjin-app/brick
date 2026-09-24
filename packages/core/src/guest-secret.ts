/**
 * 비회원 비밀번호(조회·수정용) 방어 — 대입과 과부하.
 *
 * 비회원 문의·비회원 글·비밀글은 **비밀번호 하나**로 열린다. 흔히 숫자 네 자리이고
 * 문의번호는 순번이다. 시도 횟수 제한이 없으면 두 가지로 뚫린다:
 *   - 한 대상에 1만 번 — 네 자리는 반드시 열린다
 *   - 대상마다 흔한 비밀번호 한 번씩("1234") — 대상별 제한만으로는 못 막는다
 * 그래서 **대상별**과 **IP별** 두 바구니로 센다. 실패만 센다 — 맞게 넣은 손님이 자기
 * 문의를 여러 번 여는 것까지 세면 정당한 손님이 잠긴다.
 *
 * 잠긴 동안은 맞는 비밀번호도 시험하지 않는다. 시험해 주면 잠금이 대입을 늦추기만 할 뿐
 * 막지 못한다(맞으면 200, 틀리면 429 — 응답이 답을 알려 준다).
 *
 * 한도는 DB 에 센다 — 서버가 여러 대여도, 재시작해도 하나다.
 */
/**
 * 요청 제한 — DB 에 센다. 서버가 여러 대여도, 재시작해도 한도는 하나다.
 */
export interface PluginRateLimit {
  /** 한 번 세고 허용 여부를 돌려준다 — **원자적**(동시 요청도 한도만큼만 허용). 막히면 세지 않는다 */
  consume(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** 막혔는가 (세지 않는다) */
  check(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** 한 번 센다 */
  hit(key: string, windowMs: number): Promise<void>;
  /** 가장 최근의 한 번을 되돌린다 */
  undo(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export const GUEST_SECRET_WINDOW_MS = 15 * 60_000;
/** 한 대상에 대한 실패 한도 — 네 자리 1만 가지 중 다섯 번 */
export const GUEST_SECRET_TARGET_LIMIT = 5;
/** 한 IP 의 실패 한도 — 여러 대상에 흔한 비밀번호를 뿌리는 것을 막는다 */
export const GUEST_SECRET_IP_LIMIT = 20;

/**
 * 비회원 비밀번호를 확인한다. 막혀 있으면 `tooMany(초)` 가 만든 오류를 던진다.
 * 오류는 호출한 플러그인이 만든다 — 그 플러그인의 오류 형식과 번역 카탈로그를 타야 한다.
 */
export async function checkGuestSecret(
  rateLimit: PluginRateLimit,
  opts: { target: string; ip: string | null | undefined },
  verify: () => Promise<boolean>,
  tooMany: (retryAfterSeconds: number) => Error,
): Promise<boolean> {
  const target = `guest-secret:target:${opts.target}`;
  const ip = `guest-secret:ip:${opts.ip || "-"}`;
  /*
   * 검증 **전에** 센다. 검증(scrypt)은 비동기라 수십 ms 걸리는데, 실패를 검증 뒤에 세면
   * 동시에 쏟아진 요청이 모두 검증을 기다리는 동안 아무것도 세어지지 않아 **전부** 통과한다
   * (처음 구현이 그랬다: 동시 20건이 한 건도 막히지 않았다). consume 은 세기와 한도 확인을
   * 키마다 잠금 안에서 한 번에 하므로, 서버가 여러 대여도 동시 요청은 한도만큼만 지나간다.
   * 맞으면 되돌린다 — 맞게 넣은 손님의 반복 조회까지 세면 정당한 손님이 잠긴다.
   */
  const t = await rateLimit.consume(target, GUEST_SECRET_TARGET_LIMIT, GUEST_SECRET_WINDOW_MS);
  if (!t.allowed) throw tooMany(t.retryAfterSeconds);
  const i = await rateLimit.consume(ip, GUEST_SECRET_IP_LIMIT, GUEST_SECRET_WINDOW_MS);
  if (!i.allowed) {
    await rateLimit.undo(target);
    throw tooMany(i.retryAfterSeconds);
  }
  const ok = await verify();
  if (ok) {
    await rateLimit.reset(target);
    await rateLimit.undo(ip);
  }
  return ok;
}
