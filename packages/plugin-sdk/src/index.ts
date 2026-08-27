/**
 * @brick/plugin-sdk — 플러그인 개발자가 사용하는 공개 표면.
 *
 * 플러그인 구조:
 *   my-plugin/
 *   ├── brick.plugin.json     (PluginManifest)
 *   ├── dist/index.js         (사전 빌드된 진입점 — 서버는 빌드하지 않는다)
 *   └── migrations/*.sql      (플러그인 소유 테이블)
 *
 * 진입점:
 *   import { definePlugin } from "@brick/plugin-sdk";
 *   export default definePlugin((ctx) => {
 *     ctx.registerRoute("GET", "/hello", async () => ({ hello: "brick" }));
 *     return {};
 *   });
 */
export type {
  PluginContext, PluginInstance, BlockDefinition, PluginRouteHandler,
  AdminResource, AdminField, PluginDb,
  StorageProvider, StoredFile, CacheProvider, QueueProvider, MailProvider, HookBus,
  PluginUploadedFile, PluginRawResponse, BlockRenderContext,
  CaptchaProvider, CaptchaChallenge,
} from "@brick/core";
// 값(함수)으로 재수출 — 플러그인이 원본 응답을 만들 때 쓴다
export { rawResponse } from "@brick/core";
export type { PluginManifest } from "@brick/shared";
import type { PluginContext, PluginInstance } from "@brick/core";

export function definePlugin(
  activate: (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>,
): (ctx: PluginContext) => PluginInstance | Promise<PluginInstance> {
  return activate;
}
