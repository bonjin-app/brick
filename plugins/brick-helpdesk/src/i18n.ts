/**
 * 1:1 문의·FAQ 다국어 바인딩.
 *
 * 게시판·쇼핑몰과 같은 방식이다 — 렌더 함수에 ctx 를 꿰지 않고 모듈 싱글턴으로
 * 묶는다(플러그인은 프로세스당 활성 인스턴스가 하나다). 활성화 때 bindI18n(ctx).
 *
 * 주의: 이 t 를 쓰는 HTML·스크립트 상수는 **함수**여야 한다. 모듈 최상단의
 * 템플릿 리터럴은 import 시점에 한 번 평가되므로 bindI18n 보다 먼저 굳는다.
 */
import type { PluginContext } from "@brick/plugin-sdk";

type TFn = PluginContext["t"];

let boundT: TFn = (key) => key; // 바인딩 전(테스트 등)에는 키가 그대로 보인다

export function bindI18n(ctx: Pick<PluginContext, "t">): void {
  boundT = (key, params) => ctx.t(key, params);
}

export const t: TFn = (key, params) => boundT(key, params);
