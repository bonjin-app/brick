/**
 * 사이트 운영(팝업·방문 통계) 다국어 바인딩.
 *
 * 게시판·쇼핑몰·1:1 문의와 같은 방식이다 — 모듈 싱글턴으로 묶고 활성화 때
 * bindI18n(ctx). 이 t 를 쓰는 HTML·스크립트 상수는 **함수**여야 한다
 * (모듈 최상단의 템플릿 리터럴은 bindI18n 보다 먼저 굳는다).
 */
import type { PluginContext } from "@brick/plugin-sdk";

type TFn = PluginContext["t"];

let boundT: TFn = (key) => key;

export function bindI18n(ctx: Pick<PluginContext, "t">): void {
  boundT = (key, params) => ctx.t(key, params);
}

export const t: TFn = (key, params) => boundT(key, params);
