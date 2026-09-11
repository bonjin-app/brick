/**
 * 포인트 다국어 바인딩 — 게시판(brick-board)과 같은 모듈 싱글턴 패턴.
 * 활성화 때 bindI18n(ctx) 한 번이면 뷰 함수들이 t 를 그대로 쓴다.
 */
import type { PluginContext } from "@brick/plugin-sdk";

type TFn = PluginContext["t"];

let boundT: TFn = (key) => key; // 바인딩 전(테스트 등)에는 키가 그대로 보인다
let boundLocale: () => string = () => "ko";

export function bindI18n(ctx: Pick<PluginContext, "t" | "locale">): void {
  boundT = (key, params) => ctx.t(key, params);
  boundLocale = () => ctx.locale;
}

export const t: TFn = (key, params) => boundT(key, params);

/**
 * 숫자 포맷용 BCP-47 태그 — 문자열 카탈로그와 같은 언어 설정을 따른다.
 *
 * 숫자를 `toLocaleString("ko-KR")` 로 못박으면 영어 사이트도 한국식으로 묶고,
 * 비워 두면 **브라우저** 언어를 따라가 같은 화면을 두 사람이 다르게 본다.
 *
 * 주의: 이 태그로 **서버에서 날짜를** 포맷하면 `ko-KR` 의 오전/오후가 "PM" 으로
 * 나올 수 있다(Node 의 ICU). 날짜는 브라우저에서 포맷하거나 직접 짜야 한다.
 */
export function localeTag(): string {
  return boundLocale() === "en" ? "en-US" : "ko-KR";
}
