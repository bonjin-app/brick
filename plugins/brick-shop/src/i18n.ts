/**
 * 쇼핑몰 다국어 바인딩.
 *
 * 렌더 함수(views.ts)에 ctx 를 실어 나르지 않고 모듈 싱글턴으로 묶는다 —
 * 플러그인은 프로세스당 활성 인스턴스가 하나이므로 안전하고, 수십 개의
 * 함수 시그니처에 t 를 꿰는 기계적 소음을 없앤다. 활성화 때 bindI18n(ctx).
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

/** 날짜 포맷용 BCP-47 태그 — 문자열 카탈로그와 같은 언어 설정을 따른다 */
export function localeTag(): string {
  return boundLocale() === "en" ? "en-US" : "ko-KR";
}
