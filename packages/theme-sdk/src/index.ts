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
 *   {{!-- 주석 --}}            출력되지 않는다 (HTML 주석과 달리 응답에도 없다)
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
  let out = renderSections(template.replace(/\{\{!--[\s\S]*?--\}\}/g, ""), scope);
  out = out.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, p) => String(lookup(scope, p) ?? ""));
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => esc(String(lookup(scope, p) ?? "")));
  return out;
}

/**
 * 블록({{#if}}/{{#each}})을 깊이를 세며 처리한다.
 *
 * non-greedy 정규식 한 방(`[\s\S]*?{{/if}}`)은 **같은 종류 블록의 중첩**에서
 * 바깥 블록의 닫는 태그를 첫 안쪽 `{{/if}}` 로 오인한다 — 바깥 `{{/if}}` 가
 * 화면에 그대로 새고, 안쪽 항목들이 바깥 조건 밖으로 빠진다. 사업자정보
 * 푸터(항목별 if 를 감싼 if)가 정확히 이 모양이라 실제로 노출됐다.
 */
function renderSections(tpl: string, scope: Record<string, unknown>): string {
  const open = /\{\{#(if|each)\s+([\w.]+)\}\}/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(tpl))) {
    const [tag, kind, path] = m;
    const close = findMatchingClose(tpl, m.index + tag.length, kind);
    if (!close) continue; // 짝 없는 여는 태그 — 텍스트로 남겨 템플릿의 오류가 보이게 한다
    out += tpl.slice(last, m.index);
    const body = tpl.slice(m.index + tag.length, close.start);
    const val = lookup(scope, path);
    if (kind === "if") {
      out += val ? renderSections(body, scope) : "";
    } else if (Array.isArray(val)) {
      out += val
        .map((item) =>
          renderTemplate(body, { ...scope, this: item, ...(typeof item === "object" && item ? item : {}) }),
        )
        .join("");
    }
    last = close.end;
    open.lastIndex = close.end;
  }
  return out + tpl.slice(last);
}

/** from 부터 같은 종류(kind)의 open/close 를 세어 짝이 맞는 닫는 태그를 찾는다 */
function findMatchingClose(
  tpl: string,
  from: number,
  kind: string,
): { start: number; end: number } | null {
  const re = new RegExp(`\\{\\{(#${kind}\\s+[\\w.]+|\\/${kind})\\}\\}`, "g");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) {
    depth += m[1].startsWith("#") ? 1 : -1;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}
