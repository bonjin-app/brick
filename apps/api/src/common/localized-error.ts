import { DEFAULT_LOCALE, renderCoreMessage } from "@brick/core";

/**
 * 값이 들어가는 오류 문장 — **키와 값으로 던지고 응답 경계에서 조립한다.**
 *
 * 플러그인은 활성화 때 바인딩된 `ctx.t` 를 던지는 자리에서 부를 수 있지만
 * 코어는 그럴 수 없다: 사이트 언어는 DB 에 있고, 던지는 곳은 컨트롤러 깊은
 * 곳의 동기 함수다. 그래서 문장을 **만들지 않고** 재료만 실어 보낸다 —
 * 언어를 아는 곳(전역 예외 필터)이 그때 조립한다.
 *
 * 본문에는 한국어 문장도 함께 담는다. 필터를 거치지 않는 경로(로그·테스트·
 * 다른 프레임워크 계층)에서도 사람이 읽을 수 있어야 하기 때문이다 —
 * 번역이 안 되는 것보다 **문장이 통째로 사라지는 것**이 훨씬 나쁘다.
 *
 *   throw new BadRequestException(msg("err.slugTaken", { slug }));
 */
export function msg(
  key: string,
  params?: Record<string, string | number>,
): { message: string; messageKey: string; messageParams?: Record<string, string | number> } {
  return {
    message: renderCoreMessage(DEFAULT_LOCALE, key, params),
    messageKey: key,
    messageParams: params,
  };
}

/** 어느 칸이 문제인지 함께 알려주는 형태 — 화면이 그 칸으로 데려간다 */
export function fieldMsg(
  field: string,
  key: string,
  params?: Record<string, string | number>,
): ReturnType<typeof msg> & { field: string } {
  return { ...msg(key, params), field };
}
