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
  "page.notFoundHome": "홈으로",
  "page.notFoundSearch": "검색해 보기",
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
  "header.quick": "빠른 메뉴",
  "common.close": "닫기",
  "footer.cs": "고객센터",
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
  /*
   * 코어가 보내는 메일.
   *
   * 주문 안내 메일은 이미 카탈로그를 타는데 **비밀번호 재설정과 이메일 인증은
   * 한국어가 박혀 있었다** — 영어 사이트 회원이 비밀번호를 잃어버리면 한국어
   * 메일을 받는다. 메일은 사이트 밖에서 읽히므로 화면보다 더 혼자 있다.
   */
  "mail.greeting": "{name}님, 안녕하세요.",
  "mail.ignoreNote": "본인이 요청하지 않았다면 이 메일을 무시하세요.",
  "mail.resetSubject": "[{site}] 비밀번호 재설정 안내",
  "mail.resetBody": "비밀번호를 재설정하려면 아래 링크를 열어주세요. 유효 시간은 {minutes}분입니다.",
  "mail.resetBodyHtml": "비밀번호를 재설정하려면 아래 버튼을 눌러주세요. 유효 시간은 {minutes}분입니다.",
  "mail.resetButton": "비밀번호 재설정",
  "mail.resetNotChanged": "비밀번호는 변경되지 않습니다.",
  "mail.resetOnce": "링크는 한 번만 사용할 수 있습니다.",
  "mail.verifySubject": "이메일 주소를 인증해주세요",
  "mail.verifyBody": "아래 링크를 열면 이메일 인증이 완료됩니다.",
  "mail.verifyBodyHtml": "아래 버튼을 누르면 이메일 인증이 완료됩니다. 링크는 {hours}시간 동안 유효합니다.",
  "mail.verifyValid": "링크는 {hours}시간 동안 유효합니다.",
  "mail.verifyButton": "이메일 인증",
  // 주소가 바뀐 사실은 **옛 주소**에 알려야 한다 — 그 주소의 주인만이 "내가 안 했다"를 안다
  "mail.emailChangedSubject": "[{site}] 계정 이메일 주소가 변경되었습니다",
  "mail.emailChangedBody": "이 계정의 이메일 주소가 {newEmail} (으)로 변경되었습니다.",
  "mail.emailChangedNotYou": "본인이 한 것이 아니라면 계정이 도용된 것입니다. 지금 바로 비밀번호 찾기로 비밀번호를 바꾸고 사이트 운영자에게 알려주세요.",
  // 소셜 연결은 **계정 접근 수단이 하나 늘어나는 일**이다 — 조용히 일어나면 안 된다
  "mail.socialLinkedSubject": "[{site}] 계정에 소셜 로그인이 연결되었습니다",
  "mail.socialLinkedBody": "이 계정에 {provider} 로그인이 연결되었습니다. 이제 그 계정으로도 로그인할 수 있습니다.",
  "mail.socialLinkedNotYou": "본인이 한 것이 아니라면 계정이 도용된 것입니다. 비밀번호를 바꾸고 내 정보에서 연결을 해제한 뒤 사이트 운영자에게 알려주세요.",
  "withdraw.privacyLabel": "개인정보",
  "withdraw.privacyDetail": "이메일·이름·비밀번호는 즉시 파기되며 같은 계정으로 다시 로그인할 수 없습니다.",
};

const CORE_EN: MessageCatalog = {
  "page.notFoundTitle": "Page not found",
  "page.notFoundBody": "There is no page at /{path}.",
  "page.notFoundHome": "Go home",
  "page.notFoundSearch": "Search instead",
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
  "header.quick": "Quick menu",
  "common.close": "Close",
  "footer.cs": "Customer service",
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
  "mail.greeting": "Hello {name},",
  "mail.ignoreNote": "If you did not request this, please ignore this email.",
  "mail.resetSubject": "[{site}] Reset your password",
  "mail.resetBody": "Open the link below to reset your password. It is valid for {minutes} minutes.",
  "mail.resetBodyHtml": "Press the button below to reset your password. It is valid for {minutes} minutes.",
  "mail.resetButton": "Reset password",
  "mail.resetNotChanged": "Your password has not been changed.",
  "mail.resetOnce": "The link can be used only once.",
  "mail.verifySubject": "Please verify your email address",
  "mail.verifyBody": "Open the link below to finish verifying your email.",
  "mail.verifyBodyHtml": "Press the button below to finish verifying your email. The link is valid for {hours} hours.",
  "mail.verifyValid": "The link is valid for {hours} hours.",
  "mail.verifyButton": "Verify email",
  "mail.emailChangedSubject": "[{site}] The email address on your account was changed",
  "mail.emailChangedBody": "The email address on this account was changed to {newEmail}.",
  "mail.emailChangedNotYou": "If this was not you, your account has been taken over. Reset your password right now and tell the site operator.",
  "mail.socialLinkedSubject": "[{site}] A social login was linked to your account",
  "mail.socialLinkedBody": "{provider} login was linked to this account. It can now be used to sign in.",
  "mail.socialLinkedNotYou": "If this was not you, your account has been taken over. Change your password, unlink it in your account settings, and tell the site operator.",
  "withdraw.privacyLabel": "Personal information",
  "withdraw.privacyDetail": "Your email, name and password are destroyed immediately and you cannot sign in again with this account.",
};

export const CORE_CATALOGS: Record<Locale, MessageCatalog> = { ko: CORE_KO, en: CORE_EN };
/** 테마 템플릿에 넘길 키 목록 — CORE 카탈로그의 모든 키 */
export const CORE_MESSAGE_KEYS = Object.keys(CORE_KO);

/**
 * 서버 오류 문장 — **원문(한국어)이 곧 키**인 gettext 카탈로그.
 *
 * 화면·메일·관리 라벨은 전부 번역되는데 서버가 던지는 문장만 한국어였다.
 * 영어 사이트의 손님은 **가장 중요한 순간에만** 못 읽는 글자를 본다: 로그인이
 * 안 될 때, 주문이 막힐 때, 무엇을 고쳐야 하는지가 그 문장에 적혀 있다.
 *
 * 위의 점 표기 키(`page.notFoundTitle`)와 달리 여기는 원문을 키로 쓴다 —
 * 던지는 코드(`throw new BadRequestException("정지된 계정입니다.")`)를 한 줄도
 * 바꾸지 않고 응답 경계에서 치환하기 위해서다. 플러그인 오류 문장도 각자의
 * `locales/en.json` 에서 같은 규칙으로 치환된다.
 *
 * 값이 박힌 문장(`이름은 ${n}자까지`)은 원문과 키가 달라 걸리지 않는다 —
 * 그런 문장은 카탈로그에서 조각을 꺼내 맞춰야 한다.
 */
const CORE_ERROR_EN: MessageCatalog = {
  "2단계 인증이 켜져 있지 않습니다.": "Two-factor authentication is not enabled.",
  "BRICK_CAPTCHA=test 는 운영 환경에서 쓸 수 없습니다 (정답을 응답에 내보냅니다).":
    "BRICK_CAPTCHA=test cannot be used in production (it returns the answer in the response).",
  "DATABASE_URL 이 필요합니다.": "DATABASE_URL is required.",
  "SMTP가 설정되지 않아 메일을 보낼 수 없습니다. 환경변수를 확인해주세요.":
    "SMTP is not configured, so mail cannot be sent. Please check the environment variables.",
  "kind 는 plugin 또는 theme 이어야 합니다.": "kind must be either plugin or theme.",
  "manifest 에 version 이 없습니다.": "The manifest has no version.",
  "slug: 소문자/숫자/하이픈/슬래시만 허용": "slug: only lowercase letters, digits, hyphens and slashes",
  "zip 파일을 선택해주세요.": "Please choose a zip file.",
  "같은 검색어로 바꿀 수 없습니다.": "You cannot replace a term with itself.",
  "검색어를 입력해주세요.": "Please enter a search term.",
  "공급자에서 사용자 정보를 받지 못했습니다.": "No user information was returned by the provider.",
  "공유 이미지는 10MB 이하만 올릴 수 있습니다.": "The share image must be 10MB or smaller.",
  "공유 이미지는 https:// 로 시작하는 주소 또는 /uploads/… 경로여야 합니다.":
    "The share image must be an https:// URL or an /uploads/… path.",
  "공유 이미지는 png·jpg·webp·gif 만 올릴 수 있습니다.": "The share image must be a png, jpg, webp or gif.",
  "관리자 메모는 2,000자까지입니다.": "An admin note can be at most 2,000 characters.",
  "관리자만 할 수 있는 작업입니다.": "Only an administrator can do this.",
  "권한이 없습니다.": "You do not have permission.",
  "그누보드 회원 테이블(member)을 찾지 못했습니다. 그누보드5 덤프가 맞는지 확인해주세요.":
    "The Gnuboard member table was not found. Please check that this is a Gnuboard 5 dump.",
  "내려받은 파일이 매니페스트의 sha256 과 다릅니다.": "The downloaded file does not match the sha256 in the manifest.",
  "너무 많이 시도했습니다.": "Too many attempts.",
  "다시 로그인해주세요.": "Please sign in again.",
  "덤프 내용이 비어 있습니다.": "The dump is empty.",
  "덤프에서 CREATE TABLE 을 찾지 못했습니다. mysqldump 로 만든 SQL 파일인지 확인해주세요.":
    "No CREATE TABLE was found in the dump. Please check that this SQL file came from mysqldump.",
  "데이터베이스 이름을 입력해주세요.": "Please enter the database name.",
  "데이터베이스 주소를 입력해주세요.": "Please enter the database host.",
  "띠배너 링크는 https:// 로 시작하는 주소 또는 / 로 시작하는 경로여야 합니다.":
    "A banner link must be an https:// URL or a path starting with /.",
  "레지스트리 응답이 JSON 이 아닙니다.": "The registry response is not JSON.",
  "레지스트리에 items 배열이 없습니다.": "The registry has no items array.",
  "로그인 요청을 확인할 수 없습니다. 다시 시도해주세요.":
    "The sign-in request could not be verified. Please try again.",
  "로그인 요청이 만료되었습니다. 다시 시도해주세요.": "The sign-in request has expired. Please try again.",
  "로그인이 설정되지 않았습니다.": "Sign-in is not configured.",
  "로그인이 풀렸습니다. 다시 로그인한 뒤 시도해주세요.": "Your session ended. Please sign in again and retry.",
  "로그인이 필요합니다.": "Please sign in.",
  "링크가 만료되었거나 이미 사용되었습니다. 다시 요청해주세요. (비밀번호는 8자 이상)":
    "The link has expired or was already used. Please request a new one (passwords must be at least 8 characters).",
  "마지막 관리자는 탈퇴할 수 없습니다. 다른 관리자를 먼저 지정해주세요.":
    "The last administrator cannot leave. Please appoint another administrator first.",
  "마지막 로그인 수단은 해제할 수 없습니다. 비밀번호를 먼저 설정해주세요.":
    "You cannot disconnect your last sign-in method. Please set a password first.",
  "만 14세 미만은 법정대리인 동의가 필요합니다. 사이트 운영자에게 문의해주세요.":
    "Members under 14 need a legal guardian's consent. Please contact the site operator.",
  "먼저 2단계 인증 등록을 시작해주세요.": "Please start the two-factor setup first.",
  "메뉴 이름은 필수입니다.": "A menu name is required.",
  "메뉴 항목이 너무 많습니다.": "There are too many menu items.",
  "메뉴는 3단계까지만 지원합니다.": "Menus support up to three levels.",
  "미리보기할 테마 이름이 올바르지 않습니다.": "That theme name is not valid for preview.",
  "바꿀 검색어를 입력해주세요.": "Please enter the replacement term.",
  "발송 종류가 올바르지 않습니다.": "That send type is not valid.",
  "배포자 공개키가 없어 원격 업데이트를 할 수 없습니다. ZIP 을 직접 업로드해주세요.":
    "There is no publisher public key, so remote updates are unavailable. Please upload the ZIP yourself.",
  "본문을 입력해주세요.": "Please enter the body.",
  "본문이 너무 깁니다.": "The body is too long.",
  "비밀번호가 맞지 않습니다.": "The password is incorrect.",
  "비밀번호가 올바르지 않습니다.": "The password is incorrect.",
  "빈 파일입니다.": "The file is empty.",
  "사내 SSO는 인증·토큰·사용자 정보 주소가 모두 필요합니다.":
    "Enterprise SSO needs the authorization, token and userinfo URLs.",
  "사용자 이름을 입력해주세요.": "Please enter the user name.",
  "사용자 정보를 가져오지 못했습니다.": "The user information could not be fetched.",
  "사용하려면 Client ID와 Client Secret이 모두 필요합니다.":
    "Both a Client ID and a Client Secret are required to use this.",
  "사이트 이름 · 관리자 이메일 · 비밀번호(8자 이상)를 모두 입력해주세요.":
    "Please enter the site name, the administrator email and a password of at least 8 characters.",
  "사이트를 먼저 설치해주세요. 이전은 설치가 끝난 Brick 에 데이터를 넣는 작업입니다.":
    "Please install the site first — migration imports data into an installed Brick.",
  "새 비밀번호는 8자 이상이어야 합니다.": "The new password must be at least 8 characters.",
  "생일 날짜가 올바르지 않습니다.": "That birthday is not valid.",
  "서명 검증에 실패했습니다. 레지스트리 항목이 잘못됐거나 변조된 파일입니다.":
    "Signature verification failed — the registry entry is wrong or the file was tampered with.",
  "서명 검증에 실패했습니다. 배포자 키가 바뀌었다면 새 ZIP 을 직접 업로드해야 합니다.":
    "Signature verification failed. If the publisher key changed, upload the new ZIP yourself.",
  "세션을 찾을 수 없습니다.": "Session not found.",
  "소셜 로그인 인증에 실패했습니다. 다시 시도해주세요.": "Social sign-in failed. Please try again.",
  "수신거부 주소가 올바르지 않습니다.": "That unsubscribe link is not valid.",
  "시도 횟수를 초과했습니다. 다시 로그인해주세요.": "Too many attempts. Please sign in again.",
  "알 수 없는 권한입니다.": "Unknown role.",
  "약관 본문을 입력해주세요.": "Please enter the agreement text.",
  "약관 제목을 입력해주세요.": "Please enter the agreement title.",
  "약관 종류가 올바르지 않습니다.": "That agreement type is not valid.",
  "약관을 찾을 수 없습니다.": "Agreement not found.",
  "업데이트 매니페스트가 JSON 이 아닙니다.": "The update manifest is not JSON.",
  "업데이트 매니페스트에 version/url/sha256/signature 가 필요합니다.":
    "The update manifest needs version, url, sha256 and signature.",
  "업데이트 주소는 https 여야 합니다.": "The update URL must use https.",
  "연결된 계정이 아닙니다.": "That account is not connected.",
  "요청이 너무 많습니다. 잠시 후 다시 시도하세요.": "Too many requests. Please try again shortly.",
  "요청이 올바르지 않습니다.": "The request is not valid.",
  "요청이 위조되었습니다.": "The request was forged.",
  "응답 본문이 없습니다.": "The response has no body.",
  "이 IP 에서는 관리자 기능을 쓸 수 없습니다.": "Administration is not available from this IP address.",
  "이 사이트는 관리자·운영자에게 2단계 인증을 요구합니다. 계정 보안 설정에서 먼저 등록해주세요.":
    "This site requires two-factor authentication for administrators and managers. Please set it up in account security first.",
  "이 사이트는 관리자·운영자에게 2단계 인증을 요구합니다. 해제할 수 없습니다.":
    "This site requires two-factor authentication for administrators and managers, so it cannot be turned off.",
  "이 서버에서는 이미지 변환을 쓸 수 없습니다 — 1200×630 으로 만든 이미지를 미디어에 올리고 주소를 붙여 넣으세요.":
    "Image conversion is unavailable on this server — upload a 1200×630 image to Media and paste its URL.",
  "이 소셜 계정은 다른 회원에게 연결되어 있습니다.": "This social account is connected to another member.",
  "이 확장은 원격 업데이트를 제공하지 않습니다.": "This extension does not offer remote updates.",
  "이름은 2~30자로 입력하세요.": "Please enter a name of 2–30 characters.",
  "이메일 주소 형식이 올바르지 않습니다.": "The email address format is not valid.",
  "이메일 또는 비밀번호가 올바르지 않습니다.": "The email or password is incorrect.",
  "이미 2단계 인증이 켜져 있습니다. 먼저 해제해주세요.":
    "Two-factor authentication is already on. Please turn it off first.",
  "이미 같은 공급자를 연결하셨습니다.": "You have already connected this provider.",
  "이미 같은 이메일의 계정이 있습니다. 로그인한 뒤 내 정보에서 연결해주세요.":
    "An account with this email already exists. Sign in and connect it from your profile.",
  "이미 발송 중입니다.": "Sending is already in progress.",
  "이미 발송이 완료되었습니다.": "Sending is already complete.",
  "이미 사용 중인 이메일 주소입니다.": "That email address is already in use.",
  "이미 설치되어 있습니다. 새 버전은 원클릭 업데이트로 받으세요 — 처음 설치 때 고정된 키로 검증됩니다.":
    "It is already installed. Use the one-click update for new versions — they are verified with the key pinned at first install.",
  "이미 설치된 사이트입니다.": "This site is already installed.",
  "이미 인증된 주소입니다.": "This address is already verified.",
  "이미 켜져 있습니다.": "It is already on.",
  "이미 탈퇴 처리된 계정입니다.": "This account has already been closed.",
  "이미지 파일이 없습니다.": "There is no image file.",
  "이미지를 읽을 수 없습니다.": "The image could not be read.",
  "인증 링크가 만료되었거나 이미 사용되었습니다.": "The verification link has expired or was already used.",
  "인증 시간이 지났습니다. 다시 로그인해주세요.": "The verification window has passed. Please sign in again.",
  "인증 코드가 없습니다.": "There is no verification code.",
  "자신의 권한이나 활성 상태는 변경할 수 없습니다.": "You cannot change your own role or active state.",
  "잘못된 요청입니다.": "Bad request.",
  "접속이 차단된 주소입니다.": "This address is blocked.",
  "정지된 계정입니다.": "This account is suspended.",
  "정지된 계정입니다. 관리자에게 문의하세요.": "This account is suspended. Please contact an administrator.",
  "제목을 입력해주세요.": "Please enter a title.",
  "제목이 너무 깁니다. (250자 이내)": "The title is too long (250 characters maximum).",
  "종류는 replace 또는 block 이어야 합니다.": "The type must be either replace or block.",
  "주소는 영문 소문자·숫자·하이픈만 쓸 수 있습니다.":
    "The slug may contain only lowercase letters, digits and hyphens.",
  "중단할 수 없는 상태입니다.": "It cannot be stopped in this state.",
  "지원하지 않는 공급자입니다.": "That provider is not supported.",
  "캠페인을 찾을 수 없습니다.": "Campaign not found.",
  "코드가 맞지 않습니다.": "The code is incorrect.",
  "콘텐츠 보안 정책은 on · report-only · off 중 하나여야 합니다.":
    "The content security policy must be one of on, report-only or off.",
  '탈퇴를 확인하려면 "탈퇴합니다"를 입력해주세요.': 'To confirm, please type "탈퇴합니다".',
  "탈퇴한 계정입니다.": "This account has been closed.",
  "테마 zip 파일을 선택해주세요.": "Please choose a theme zip file.",
  "테마에는 templates/layout.html 이 있어야 합니다.": "A theme must contain templates/layout.html.",
  "파일이 없습니다.": "There is no file.",
  "포트 번호가 올바르지 않습니다.": "That port number is not valid.",
  "프로필 이미지는 4MB 이하만 올릴 수 있습니다.": "A profile image must be 4MB or smaller.",
  "프로필 이미지는 png·jpg·gif·webp 만 올릴 수 있습니다.": "A profile image must be a png, jpg, gif or webp.",
  "현재 비밀번호가 올바르지 않습니다.": "The current password is incorrect.",
  "회원 테이블을 찾지 못했습니다.": "The member table was not found.",
  "회원가입이 닫혀 있습니다.": "Registration is closed.",
  "회원을 찾을 수 없습니다.": "Member not found.",
};

const CORE_ERRORS: Partial<Record<Locale, MessageCatalog>> = { en: CORE_ERROR_EN };

/**
 * 코어가 던진 오류 문장을 사이트 언어로 — 없으면 원문 그대로(자연 폴백).
 * 응답 경계(전역 예외 필터)에서 한 번만 부른다.
 */
export function translateCoreError(locale: Locale, message: string): string {
  if (locale === DEFAULT_LOCALE) return message;
  return CORE_ERRORS[locale]?.[message] ?? message;
}

/** 검사 스크립트가 읽는 원문 목록 — 번역이 빠진 오류 문장을 CI 가 잡는다 */
export const CORE_ERROR_SOURCES = Object.keys(CORE_ERROR_EN);
