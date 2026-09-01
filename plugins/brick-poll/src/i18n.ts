/**
 * 설문 다국어 바인딩 — 게시판(brick-board)과 같은 모듈 싱글턴 패턴.
 * 활성화 때 bindI18n(ctx) 한 번이면 뷰 함수들이 t 를 그대로 쓴다.
 */
import type { PluginContext } from "@brick/plugin-sdk";

type TFn = PluginContext["t"];

let boundT: TFn = (key) => key; // 바인딩 전(테스트 등)에는 키가 그대로 보인다

export function bindI18n(ctx: Pick<PluginContext, "t">): void {
  boundT = (key, params) => ctx.t(key, params);
}

export const t: TFn = (key, params) => boundT(key, params);
