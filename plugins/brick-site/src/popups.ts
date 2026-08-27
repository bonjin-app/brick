import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { SiteError, escapeHtml, type Db } from "./types.js";

/**
 * 팝업 · 배너.
 *
 * 그누보드의 팝업은 관리자가 HTML을 넣고 위치·크기를 정하는 방식이다.
 * 같은 모양을 유지하되 두 가지를 다르게 한다:
 *
 *  - **노출 경로를 접두어로 지정한다.** `/shop` 이면 상품 페이지 전체에 뜬다.
 *    "전체 공지"와 "쇼핑몰 이벤트"를 나눌 수 있어야 실제로 쓸 수 있다.
 *  - **본문 HTML을 새니타이즈한다.** 팝업은 관리자만 쓰지만, 운영자 계정이
 *    털렸을 때 전 방문자에게 스크립트가 배포되는 통로가 되면 안 된다.
 */

export interface PopupInput {
  title?: unknown;
  kind?: unknown;
  content?: unknown;
  image_url?: unknown;
  link_url?: unknown;
  link_target?: unknown;
  path_prefix?: unknown;
  pos_top?: unknown;
  pos_left?: unknown;
  width?: unknown;
  hide_days?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  sort_order?: unknown;
  is_active?: unknown;
}

/**
 * 팝업 본문 새니타이즈.
 *
 * 게시판의 새니타이저(brick-board)를 그대로 쓸 수 없다 — 플러그인끼리 코드를
 * 공유하지 않는 것이 배포 단위의 독립성을 지키는 방법이다. 팝업은 게시글보다
 * 훨씬 좁은 태그만 필요하므로 더 엄격한 허용 목록을 따로 둔다.
 */
const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "span", "div",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "small", "hr",
  "a", "img", "table", "thead", "tbody", "tr", "th", "td",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "title"]),
  img: new Set(["src", "alt", "width", "height"]),
  "*": new Set(["style", "class"]),
};
// style에서 허용할 선언 — expression()·url() 같은 통로를 막는다
const STYLE_SAFE = /^[a-z-]+\s*:\s*[#0-9a-z%.,\s()-]+$/i;

export function sanitizePopupHtml(raw: string): string {
  let html = String(raw ?? "");

  // 주석 안에 태그를 숨기는 조건부 주석 우회를 먼저 제거한다
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  // 위험 요소는 내용까지 함께 지운다 (여는 태그만 지우면 본문이 새어 나온다)
  html = html.replace(
    /<(script|style|iframe|object|embed|form|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  html = html.replace(/<(script|style|iframe|object|embed|form|noscript|svg|math)\b[^>]*>/gi, "");

  return html.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (m, rawTag, rawAttrs) => {
      const tag = String(rawTag).toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (m.startsWith("</")) return `</${tag}>`;

      const attrs: string[] = [];
      const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let a: RegExpExecArray | null;
      while ((a = re.exec(String(rawAttrs))) !== null) {
        const name = a[1].toLowerCase();
        const value = a[2] ?? a[3] ?? a[4] ?? "";
        const allowed = ALLOWED_ATTRS[tag]?.has(name) || ALLOWED_ATTRS["*"].has(name);
        if (!allowed) continue;
        // on* 은 허용 목록에 없지만 방어적으로 한 번 더 막는다
        if (name.startsWith("on")) continue;

        if ((name === "href" || name === "src") && !safeUrl(value)) continue;
        if (
          name === "style" &&
          !value.split(";").every((d) => !d.trim() || STYLE_SAFE.test(d.trim()))
        ) {
          continue;
        }
        attrs.push(`${name}="${escapeHtml(value)}"`);
      }
      // 외부 링크가 새 창에서 열려도 원본 창을 조작하지 못하게 한다
      if (tag === "a") attrs.push('rel="noopener noreferrer"');
      return `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
    },
  );
}

/**
 * 허용 스킴 검사.
 *
 * 비교 전에 공백류와 제어문자를 지운다 — `java\tscript:` 나 개행을 끼운
 * `java\nscript:` 는 브라우저가 스킴으로 인식하지만 문자열 비교는 통과시킨다.
 */
function safeUrl(value: string): boolean {
  const v = String(value)
    .replace(/[\s\u0000-\u0020\u007f]/g, "")
    .toLowerCase();
  if (v.startsWith("/") || v.startsWith("#")) return true;
  return v.startsWith("http://") || v.startsWith("https://") || v.startsWith("mailto:");
}

function safeLink(value: unknown): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (!safeUrl(v)) throw new SiteError(400, "주소는 / 또는 http(s):// 로 시작해야 합니다.");
  return v.slice(0, 1000);
}

export function validatePopup(b: PopupInput) {
  const title = String(b.title ?? "").trim();
  if (!title) throw new SiteError(400, "제목을 입력해주세요.");
  if (title.length > 200) throw new SiteError(400, "제목이 너무 깁니다.");

  const kind = String(b.kind ?? "popup");
  if (!["popup", "banner"].includes(kind)) throw new SiteError(400, "종류가 올바르지 않습니다.");

  const target = String(b.link_target ?? "_self");
  if (!["_self", "_blank"].includes(target)) {
    throw new SiteError(400, "링크 열기 방식이 올바르지 않습니다.");
  }

  let prefix = String(b.path_prefix ?? "*").trim() || "*";
  if (prefix !== "*") {
    if (!prefix.startsWith("/")) throw new SiteError(400, "노출 경로는 / 로 시작하거나 * 여야 합니다.");
    // 뒤 슬래시는 접두어 비교를 어긋나게 하므로 지운다 (/shop/ 과 /shop 이 달라지면 안 된다)
    prefix = prefix.replace(/\/+$/, "") || "/";
  }

  const int = (v: unknown, dflt: number, min: number, max: number) => {
    if (v === null || v === undefined || v === "") return dflt;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) throw new SiteError(400, "숫자 값이 올바르지 않습니다.");
    return Math.min(max, Math.max(min, n));
  };

  const when = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (Number.isNaN(Date.parse(s))) throw new SiteError(400, "날짜 형식이 올바르지 않습니다.");
    return s;
  };

  const startsAt = when(b.starts_at);
  const endsAt = when(b.ends_at);
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new SiteError(400, "종료 시각이 시작 시각보다 빠릅니다.");
  }

  return {
    title,
    kind,
    content: sanitizePopupHtml(String(b.content ?? "")).slice(0, 20000),
    imageUrl: safeLink(b.image_url),
    linkUrl: safeLink(b.link_url),
    linkTarget: target,
    pathPrefix: prefix.slice(0, 300),
    posTop: int(b.pos_top, 40, 0, 5000),
    posLeft: int(b.pos_left, 40, 0, 5000),
    width: int(b.width, 400, 100, 2000),
    hideDays: int(b.hide_days, 1, 0, 365),
    startsAt,
    endsAt,
    sortOrder: int(b.sort_order, 0, -9999, 9999),
    isActive: b.is_active !== false,
  };
}

export async function createPopup(db: Db, b: PopupInput): Promise<{ id: string }> {
  const p = validatePopup(b);
  const id = uuidv7();
  await db.execute(sql`
    INSERT INTO site_popups
      (id, title, kind, content, image_url, link_url, link_target, path_prefix,
       pos_top, pos_left, width, hide_days, starts_at, ends_at, sort_order, is_active)
    VALUES
      (${id}, ${p.title}, ${p.kind}, ${p.content}, ${p.imageUrl}, ${p.linkUrl},
       ${p.linkTarget}, ${p.pathPrefix}, ${p.posTop}, ${p.posLeft}, ${p.width},
       ${p.hideDays}, ${p.startsAt}::timestamptz, ${p.endsAt}::timestamptz,
       ${p.sortOrder}, ${p.isActive})
  `);
  return { id };
}

export async function updatePopup(db: Db, id: string, b: PopupInput): Promise<void> {
  const p = validatePopup(b);
  const { rows } = await db.execute(sql`
    UPDATE site_popups SET
      title = ${p.title}, kind = ${p.kind}, content = ${p.content},
      image_url = ${p.imageUrl}, link_url = ${p.linkUrl}, link_target = ${p.linkTarget},
      path_prefix = ${p.pathPrefix}, pos_top = ${p.posTop}, pos_left = ${p.posLeft},
      width = ${p.width}, hide_days = ${p.hideDays},
      starts_at = ${p.startsAt}::timestamptz, ends_at = ${p.endsAt}::timestamptz,
      sort_order = ${p.sortOrder}, is_active = ${p.isActive}, updated_at = now()
    WHERE id = ${id}::uuid RETURNING id
  `);
  if (!rows.length) throw new SiteError(404, "팝업을 찾을 수 없습니다.");
}

/**
 * 지금 이 경로에 띄울 것들.
 *
 * 기간과 활성 여부를 **SQL에서** 걸러낸다. 노출 여부를 클라이언트가 판단하면
 * 아직 시작하지 않은 이벤트 내용이 응답에 실려 나간다.
 */
export async function livePopups(db: Db, params: { path: string; kind: string }) {
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const { rows } = await db.execute(sql`
    SELECT id, title, kind, content, image_url, link_url, link_target,
           pos_top, pos_left, width, hide_days
    FROM site_popups
    WHERE is_active = true
      AND kind = ${params.kind}
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at   IS NULL OR ends_at   >  now())
      AND (
        path_prefix = '*'
        OR ${path} = path_prefix
        -- 접두어 매칭: /shop 은 /shop/item 에도 뜨지만 /shopping 에는 뜨지 않는다
        OR ${path} LIKE path_prefix || '/%'
      )
    ORDER BY sort_order, created_at
    LIMIT 20
  `);
  return rows;
}

/**
 * 노출 카운트 — 팝업이 실제로 얼마나 보였는지.
 *
 * `= ANY($1::uuid[])` 를 쓰지 않는다 — 드라이버가 JS 배열을 배열 파라미터가
 * 아니라 레코드로 넘기기 때문에 "cannot cast type record to uuid[]" 로 실패한다.
 * 각 id를 개별 파라미터로 펼친다 (여전히 바인딩이므로 주입 위험은 없다).
 */
export async function countView(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  await db.execute(sql`
    UPDATE site_popups SET view_count = view_count + 1 WHERE id IN (${list})
  `);
}

export async function countClick(db: Db, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE site_popups SET click_count = click_count + 1 WHERE id = ${id}::uuid
  `);
}
