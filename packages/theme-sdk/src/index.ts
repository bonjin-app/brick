/**
 * @brick/theme-sdk — 테마 템플릿 렌더러.
 *
 * 테마는 빌드가 필요 없는 런타임 템플릿이다 (ZIP 업로드 = 즉시 적용).
 * 템플릿 문법은 의도적으로 최소화한다:
 *
 *   {{ site.name }}            변수 치환 (HTML escape)
 *   {{{ content }}}            raw HTML 삽입 (블록 렌더 결과)
 *   {{#if user}} ... {{/if}}   조건
 *   {{#each posts}} ... {{/each}}  반복
 *
 * 로직이 필요하면 테마가 아니라 Block(React/서버 렌더)으로 만든다.
 */
export type { ThemeManifest } from "@brick/shared";

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPE[c]);

function lookup(scope: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, scope);
}

/** 최소 템플릿 엔진. 중첩 if/each를 재귀 처리한다 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  let out = renderSections(template, scope);
  out = out.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, p) => String(lookup(scope, p) ?? ""));
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => esc(String(lookup(scope, p) ?? "")));
  return out;
}

function renderSections(tpl: string, scope: Record<string, unknown>): string {
  const re = /\{\{#(if|each)\s+([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  return tpl.replace(re, (_, kind: string, path: string, body: string) => {
    const val = lookup(scope, path);
    if (kind === "if") return val ? renderSections(body, scope) : "";
    if (Array.isArray(val)) {
      return val
        .map((item) =>
          renderTemplate(body, { ...scope, this: item, ...(typeof item === "object" && item ? item : {}) }),
        )
        .join("");
    }
    return "";
  });
}
