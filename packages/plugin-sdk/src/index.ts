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
  PluginContext, PluginInstance, BlockDefinition, PluginRouteHandler, PluginRouteDocs,
  AdminResource, AdminField, PluginDb,
  StorageProvider, StoredFile, CacheProvider, QueueProvider, MailProvider, HookBus,
  PluginUploadedFile, PluginRawResponse, BlockRenderContext,
  CaptchaProvider, CaptchaChallenge,
  PersonalDataEraser, SitemapSource, SitemapUrl, DashboardCard,
} from "@brick/core";
// 값(함수)으로 재수출 — 플러그인이 원본 응답을 만들 때 쓴다
export { rawResponse } from "@brick/core";
// 한국 전용 검증 — 코어와 플러그인이 같은 규칙을 쓴다 (체크섬을 복제하면 갈라진다)
export { isValidBusinessNo, formatBusinessNo } from "@brick/core";
// 검색 발췌·HTML 제거 — 여러 플러그인이 같은 규칙을 써야 한다
export { stripHtml, searchExcerpt, escapeHtml, maskEmail, SITE_TZ } from "@brick/core";
// DB 오류 판별 — 중복 등록을 409로 돌려줄 때 쓴다.
// 오류 문자열로 검사하면 드라이버가 메시지 형태를 바꿀 때 조용히 깨진다.
export {
  PG_ERROR, isUniqueViolation, isForeignKeyViolation, isCheckViolation,
  isRetryable, pgErrorCode, violatedConstraint,
} from "@brick/core";
export type { PluginManifest } from "@brick/shared";
import type { PluginContext, PluginInstance } from "@brick/core";

export function definePlugin(
  activate: (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>,
): (ctx: PluginContext) => PluginInstance | Promise<PluginInstance> {
  return activate;
}
