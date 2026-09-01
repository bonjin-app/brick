/**
 * 다국어 (i18n) — 메시지 카탈로그와 번역기.
 *
 * 원칙 (로드맵 M23):
 *  - **빠진 키는 ko 로 폴백하고 로그에 남는다.** 조용한 영어 섞임(또는 키
 *    노출)이 없어야 한다 — 번역이 반쪽이면 반쪽인 것이 보여야 고쳐진다.
 *  - 카탈로그는 평평한 키("footer.company")로 쓴다. 템플릿에는 중첩 객체로
 *    바꿔 넘긴다({{ t.footer.company }}) — 테마 템플릿 문법이 점 경로를
 *    지원하기 때문이다.
 *  - locale 은 사이트 설정(site.locale)이다. 손님별 언어 전환(Accept-Language)
 *    은 나중 문제다 — 사이트 운영자가 자기 사이트의 언어를 정하는 것이 먼저다.
 */

export const AVAILABLE_LOCALES = ["ko", "en"] as const;
export type Locale = (typeof AVAILABLE_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export type MessageCatalog = Record<string, string>;

export function normalizeLocale(value: unknown): Locale {
  const v = String(value ?? "").trim().toLowerCase();
  return (AVAILABLE_LOCALES as readonly string[]).includes(v) ? (v as Locale) : DEFAULT_LOCALE;
}

/** "{name}" 자리를 채운다. 없는 파라미터는 그대로 둔다 — 조용히 지우면 디버깅이 안 된다 */
function interpolate(message: string, params?: Record<string, string | number>): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    params[key] === undefined ? whole : String(params[key]),
  );
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

/**
 * 번역기를 만든다.
 *
 * 찾는 순서: 요청 locale → ko(기본) → 키 자체.
 * ko 에도 없으면 키를 그대로 돌려주고 onMissing 을 부른다 — 화면에 키가
 * 보이는 것이 빈 문자열보다 낫다(무엇이 빠졌는지 화면이 말해 준다).
 */
export function makeTranslator(opts: {
  locale: Locale;
  catalogs: Partial<Record<Locale, MessageCatalog>>;
  onMissing?: (key: string, locale: Locale) => void;
}): Translator {
  const primary = opts.catalogs[opts.locale] ?? {};
  const fallback = opts.catalogs[DEFAULT_LOCALE] ?? {};
  return (key, params) => {
    const message = primary[key] ?? fallback[key];
    if (message === undefined) {
      opts.onMissing?.(key, opts.locale);
      return key;
    }
    if (primary[key] === undefined) {
      // 요청 언어에 없어서 ko 로 폴백했다 — 번역이 빠진 것이므로 알린다
      opts.onMissing?.(key, opts.locale);
    }
    return interpolate(message, params);
  };
}

/**
 * 평평한 카탈로그를 중첩 객체로 — 테마 템플릿({{ t.footer.company }})용.
 * 전부 번역을 통과시켜 만든다(폴백·로그 규칙이 동일하게 적용되게).
 */
export function catalogToTree(t: Translator, keys: string[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const key of keys) {
    const parts = key.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = t(key);
  }
  return tree;
}

// ── 코어 카탈로그: 코어가 직접 그리는 공개 화면 문자열 ──
//
// 관리 화면·API 오류 메시지는 여기 없다 — 손님이 보는 것이 먼저다(로드맵 2단계).
// 플러그인 문자열은 플러그인이 자기 locales/ 로 가진다(3단계).

const CORE_KO: MessageCatalog = {
  "page.notFoundTitle": "페이지를 찾을 수 없습니다",
  "page.notFoundBody": "요청하신 주소(/{path})에 해당하는 페이지가 없습니다.",
  "footer.company": "상호",
  "footer.representative": "대표",
  "footer.businessNo": "사업자등록번호",
  "footer.mailOrderNo": "통신판매업신고",
  "footer.phone": "전화",
  "footer.email": "이메일",
  "footer.privacyOfficer": "개인정보 보호책임자",
  "footer.hosting": "호스팅",
  "header.skip": "본문으로 바로가기",
  "header.menu": "메뉴",
  "header.theme": "화면 모드 전환",
  "header.login": "로그인",
  "header.register": "회원가입",
  "header.logout": "로그아웃",
  "header.admin": "관리자",
  "search.placeholder": "검색어를 입력하세요",
  "search.button": "검색",
  "search.title": "통합검색",
  "search.tooShort": "검색어는 2자 이상 입력해주세요.",
  "search.empty": "\"{query}\" 에 대한 결과가 없습니다.",
  "search.total": "\"{query}\" 검색 결과 {total}건",
  "search.groupTotal": "{total}건",
  "search.more": "더보기",
  "search.all": "전체",
  "search.replaced": "\"{from}\" 대신 \"{to}\" 로 검색했습니다.",
  "search.prev": "이전",
  "search.next": "다음",
  "footer.toTop": "맨 위로",
  // 홈 페이지가 아직 없을 때 테마가 그리는 폴백 화면 (설치 직후)
  "home.readyTitle": "설치가 끝났습니다",
  "home.readyBody": "이 화면은 홈 페이지를 아직 만들지 않았을 때만 보입니다. 관리자에서 페이지를 만들고 블록을 올리면 이 자리에 놓입니다.",
  "home.readyCta": "관리자에서 홈 만들기",
  "home.readyDocs": "문서 보기",
  "home.stepPages": "페이지와 블록",
  "home.stepPagesBody": "페이지를 만들고 게시판·상품·설문 같은 블록을 끼워 넣습니다.",
  "home.stepTheme": "테마",
  "home.stepThemeBody": "색과 글꼴은 테마 토큰에서 옵니다. 라이트·다크 두 벌이 함께 옵니다.",
  "home.stepPlugins": "플러그인",
  "home.stepPluginsBody": "게시판·쇼핑몰·회원·포인트를 켜고 끄면서 필요한 것만 씁니다.",
};

const CORE_EN: MessageCatalog = {
  "page.notFoundTitle": "Page not found",
  "page.notFoundBody": "There is no page at /{path}.",
  "footer.company": "Company",
  "footer.representative": "Representative",
  "footer.businessNo": "Business reg. no.",
  "footer.mailOrderNo": "Mail-order business no.",
  "footer.phone": "Tel",
  "footer.email": "Email",
  "footer.privacyOfficer": "Privacy officer",
  "footer.hosting": "Hosting",
  "header.skip": "Skip to content",
  "header.menu": "Menu",
  "header.theme": "Toggle color scheme",
  "header.login": "Log in",
  "header.register": "Sign up",
  "header.logout": "Log out",
  "header.admin": "Admin",
  "search.placeholder": "Search…",
  "search.button": "Search",
  "search.title": "Search",
  "search.tooShort": "Please enter at least 2 characters.",
  "search.empty": "No results for \"{query}\".",
  "search.total": "{total} results for \"{query}\"",
  "search.groupTotal": "{total} results",
  "search.more": "More",
  "search.all": "All",
  "search.replaced": "Searched for \"{to}\" instead of \"{from}\".",
  "search.prev": "Prev",
  "search.next": "Next",
  "footer.toTop": "Back to top",
  "home.readyTitle": "Installation complete",
  "home.readyBody": "This screen only appears while there is no home page yet. Create a page in the admin and it takes this place.",
  "home.readyCta": "Create a home page",
  "home.readyDocs": "Read the docs",
  "home.stepPages": "Pages and blocks",
  "home.stepPagesBody": "Create a page, then drop in blocks — boards, products, polls.",
  "home.stepTheme": "Theme",
  "home.stepThemeBody": "Colors and fonts come from theme tokens. Light and dark ship together.",
  "home.stepPlugins": "Plugins",
  "home.stepPluginsBody": "Turn boards, shop, members and points on or off as you need them.",
};

export const CORE_CATALOGS: Record<Locale, MessageCatalog> = { ko: CORE_KO, en: CORE_EN };
/** 테마 템플릿에 넘길 키 목록 — CORE 카탈로그의 모든 키 */
export const CORE_MESSAGE_KEYS = Object.keys(CORE_KO);
