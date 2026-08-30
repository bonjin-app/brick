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
 *
 * ── 안전 규칙 (렌더러가 보증한다) ─────────────────────
 *
 * 1. **삽입된 값은 다시 파싱하지 않는다.** 변수 치환을 렌더 결과 전체에
 *    재실행하면 사용자 데이터({{{ content }}} 로 들어온 게시글 본문 등)에
 *    적힌 "{{ site.name }}" 같은 텍스트가 실제 값으로 재치환된다 — 데이터
 *    주도 템플릿 주입이다. 그래서 치환은 **템플릿 소유의 텍스트 조각에만**,
 *    그것도 한 번의 replace 로 실행한다 (콜백 결과는 재스캔되지 않는다).
 *
 * 2. **짝 없는 여는 태그는 fail-closed.** 닫는 태그가 없는 {{#if}} 를
 *    만나면 그 태그를 화면에 남기고 **거기서 렌더를 멈춘다.** 계속 렌더하면
 *    조건으로 감싸려던 내용(관리자 전용 등)이 조건 평가 없이 노출된다 —
 *    잘린 화면과 남은 태그가 템플릿 오류를 즉시 드러낸다.
 */
export type { ThemeManifest } from "@brick/shared";

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPE[c]);

const COMMENT_RE = /\{\{!--[\s\S]*?--\}\}/g;
/** {{{ raw }}} 와 {{ escaped }} 를 한 패스로 — 두 패스면 raw 삽입 결과를 재스캔한다 */
const VAR_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g;
/**
 * 닫는 짝 탐색용 — kind 별로 미리 컴파일해 둔다 (렌더는 공개 페이지
 * 핫패스라 태그마다 new RegExp 를 만들면 태그 수에 비례해 낭비된다).
 * findMatchingClose 는 재귀하지 않는 순수 스캔이므로 lastIndex 재설정만으로
 * 공유해도 안전하다.
 */
const CLOSE_RE: Record<string, RegExp> = {
  if: /\{\{(#if\s+[\w.]+|\/if)\}\}/g,
  each: /\{\{(#each\s+[\w.]+|\/each)\}\}/g,
};

function lookup(scope: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, scope);
}

/** 템플릿 소유 텍스트 조각의 변수 치환. 한 번의 replace — 값은 재스캔되지 않는다 */
function substituteVars(text: string, scope: Record<string, unknown>): string {
  return text.replace(VAR_RE, (_, raw: string | undefined, escaped: string | undefined) =>
    raw !== undefined
      ? String(lookup(scope, raw) ?? "")
      : esc(String(lookup(scope, escaped as string) ?? "")),
  );
}

/** 최소 템플릿 엔진. 중첩 if/each 를 깊이를 세며 재귀 처리한다 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  // 주석은 진입에서 한 번만 벗긴다 — each 항목 재귀마다 재스캔하지 않는다
  return renderInner(template.replace(COMMENT_RE, ""), scope);
}

/**
 * 블록({{#if}}/{{#each}})과 변수 치환을 한 스캔으로 처리한다.
 *
 * non-greedy 정규식 한 방(`[\s\S]*?{{/if}}`)은 **같은 종류 블록의 중첩**에서
 * 바깥 블록의 닫는 태그를 첫 안쪽 `{{/if}}` 로 오인한다 — 바깥 `{{/if}}` 가
 * 화면에 그대로 새고, 안쪽 항목들이 바깥 조건 밖으로 빠진다. 사업자정보
 * 푸터(항목별 if 를 감싼 if)가 정확히 이 모양이라 실제로 노출됐다.
 */
function renderInner(tpl: string, scope: Record<string, unknown>): string {
  // exec 루프 중 renderInner 를 재귀 호출하므로 여는 태그 정규식은 호출마다
  // 새로 만든다 — 모듈 공유면 재귀가 lastIndex 를 오염시킨다.
  const open = /\{\{#(if|each)\s+([\w.]+)\}\}/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(tpl))) {
    const [tag, kind, path] = m;
    const close = findMatchingClose(tpl, m.index + tag.length, kind);
    if (!close) {
      // fail-closed — 태그를 남기고 렌더를 멈춘다 (파일 상단 안전 규칙 2)
      return out + substituteVars(tpl.slice(last, m.index), scope) + tag;
    }
    out += substituteVars(tpl.slice(last, m.index), scope);
    const body = tpl.slice(m.index + tag.length, close.start);
    const val = lookup(scope, path);
    if (kind === "if") {
      out += val ? renderInner(body, scope) : "";
    } else if (Array.isArray(val)) {
      out += val
        .map((item) =>
          renderInner(body, { ...scope, this: item, ...(typeof item === "object" && item ? item : {}) }),
        )
        .join("");
    }
    last = close.end;
    open.lastIndex = close.end;
  }
  return out + substituteVars(tpl.slice(last), scope);
}

/** from 부터 같은 종류(kind)의 open/close 를 세어 짝이 맞는 닫는 태그를 찾는다 */
function findMatchingClose(
  tpl: string,
  from: number,
  kind: string,
): { start: number; end: number } | null {
  const re = CLOSE_RE[kind];
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) {
    depth += m[1].startsWith("#") ? 1 : -1;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}
