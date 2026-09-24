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
  "noti.title": "알림",
  "noti.header": "알림",
  "noti.headerN": "알림 {n}",
  "editor.emptyContainer": "빈 칸 — 편집기에서 이 안에 블록을 넣으세요",
  "editor.unknownBlock": "알 수 없는 블록 ({name}) — 확장이 꺼졌거나 지워졌습니다. 지우거나 확장을 켜세요.",
  "editor.blockFailed": "이 블록을 그리지 못했습니다 ({name}) — 속성을 확인하세요.",
  "editor.expired": "미리보기가 만료되었습니다. 편집기가 곧 다시 보냅니다.",
  "noti.empty": "아직 받은 알림이 없습니다.",
  "noti.new": "새 알림",
  "noti.readAll": "모두 읽었습니다.",
  "noti.loginRequired": "알림함은 로그인한 뒤에 볼 수 있습니다.",
  "noti.older": "이전 알림 보기",
  "maintenance.title": "잠시 점검 중입니다",
  "maintenance.body": "더 나은 서비스를 위해 잠시 손보고 있습니다. 조금 뒤에 다시 찾아와 주세요.",
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
  "identity.title": "본인인증",
  "identity.loginRequired": "본인인증은 로그인한 뒤 할 수 있습니다.",
  "identity.login": "로그인",
  "identity.intro": "휴대폰으로 본인임을 확인합니다. 이름·생년월일·전화번호는 이 사이트에 저장되지 않고, 성인 여부를 가리는 데 필요한 출생 연도만 남습니다.",
  "identity.verified": "본인인증을 마쳤습니다.",
  "identity.verifiedAt": "인증일 {date}",
  "identity.adult": "청소년보호법상 성인으로 확인되었습니다.",
  "identity.notAdult": "청소년보호법상 19세 미만으로 확인되어 성인 상품은 이용할 수 없습니다.",
  "identity.none": "이 사이트에는 아직 본인인증 수단이 설정되지 않았습니다. 운영자에게 문의해주세요.",
  "identity.opening": "인증창을 여는 중입니다…",
  "identity.working": "인증 결과를 확인하는 중입니다…",
  "identity.done": "본인인증이 완료되었습니다.",
  "identity.cancelled": "본인인증이 취소되었습니다.",
  "identity.failed": "본인인증을 진행하지 못했습니다. 잠시 후 다시 시도해주세요.",
  "identity.continue": "계속하기",
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
  "noti.title": "Notifications",
  "noti.header": "Alerts",
  "noti.headerN": "Alerts {n}",
  "editor.emptyContainer": "Empty — add blocks inside this from the editor",
  "editor.unknownBlock": "Unknown block ({name}) — its extension is off or removed. Delete it or turn the extension on.",
  "editor.blockFailed": "This block could not be drawn ({name}) — check its settings.",
  "editor.expired": "This preview has expired. The editor will send it again shortly.",
  "noti.empty": "No notifications yet.",
  "noti.new": "New",
  "noti.readAll": "All caught up.",
  "noti.loginRequired": "Sign in to see your notifications.",
  "noti.older": "Older notifications",
  "maintenance.title": "Down for maintenance",
  "maintenance.body": "We are making a few changes and will be back shortly. Please try again in a little while.",
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
  "withdraw.privacyDetail": "Your email, name and password are destroyed immediately and you cannot sign in again with this account.",  "identity.title": "Identity verification",
  "identity.loginRequired": "Please sign in to verify your identity.",
  "identity.login": "Sign in",
  "identity.intro": "Verify that it is you with your mobile phone. Your name, date of birth and phone number are not stored on this site — only your birth year, which is needed to check your age.",
  "identity.verified": "Your identity is verified.",
  "identity.verifiedAt": "Verified on {date}",
  "identity.adult": "You are confirmed as an adult under Korea's Juvenile Protection Act.",
  "identity.notAdult": "You are confirmed as under 19 under Korea's Juvenile Protection Act, so adults-only products are not available.",
  "identity.none": "No identity verification method is set up on this site yet. Please contact the site operator.",
  "identity.opening": "Opening the verification window…",
  "identity.working": "Checking the verification result…",
  "identity.done": "Your identity has been verified.",
  "identity.cancelled": "Identity verification was cancelled.",
  "identity.failed": "Identity verification could not be started. Please try again shortly.",
  "identity.continue": "Continue",
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
  "이 사이트는 본인인증한 회원만 이용할 수 있습니다. 본인인증을 먼저 해주세요.": "This site is only for members who have verified their identity. Please verify your identity first.",
  "이 관리 화면을 다룰 권한이 없습니다.": "You do not have permission for this admin screen.",
  "관리 화면 권한의 형식이 올바르지 않습니다.": "The admin screen permissions are not in a valid format.",
  "알림 종류를 찾을 수 없습니다.": "Notification type not found.",
  "이 알림은 문구를 고칠 수 없습니다.": "The text of this notification cannot be edited.",
  "제목은 한 줄로 써주세요.": "Please write the subject on one line.",
  "제목은 200자까지 쓸 수 있습니다.": "The subject can be up to 200 characters.",
  "본문은 5,000자까지 쓸 수 있습니다.": "The body can be up to 5,000 characters.",
  "문자 문구는 2,000자까지 쓸 수 있습니다.": "The SMS text can be up to 2,000 characters.",
  "인증 요청을 찾을 수 없습니다.": "The verification request was not found.",
  "이미 끝난 인증 요청입니다. 처음부터 다시 인증해주세요.": "This verification request has already finished. Please start the verification again.",
  "인증 시간이 지났습니다. 처음부터 다시 인증해주세요.": "The verification timed out. Please start the verification again.",
  "사용할 수 없는 본인인증 수단입니다.": "That identity verification method is not available.",
  "본인인증이 완료되지 않았습니다.": "Identity verification was not completed.",
  "인증 결과를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.": "The verification result could not be confirmed. Please try again shortly.",
  "이미 다른 명의로 본인인증한 계정입니다.": "This account is already verified under another person's name.",
  "이미 다른 계정에서 본인인증을 했습니다. 이 사이트는 한 사람이 한 계정만 쓸 수 있습니다.":
    "You have already verified your identity on another account. This site allows one account per person.",
  "본인인증을 너무 많이 시도했습니다. 잠시 후 다시 시도해주세요.": "Too many identity verification attempts. Please try again later.",
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

/**
 * 코어 블록의 **선언 라벨** — 페이지 빌더가 읽는 이름과 속성 제목.
 *
 * 빌더는 서버가 준 `displayName`·속성 `title` 을 그대로 그린다. 그래서 영어
 * 사이트의 운영자에게도 블록 서랍이 "제목 · 문단 · 히어로 (큰 제목 영역)" 로
 * 보였다 — 관리 화면의 나머지는 다 영어인데 **페이지를 만드는 바로 그 화면만**
 * 한국어였다. 플러그인 블록은 각자의 locales/en.json 이 받고(같은 gettext
 * 규칙), 코어 블록은 코드 안에 사는 선언이라 여기서 받는다.
 */
const CORE_LABEL_EN: MessageCatalog = {
  "알림함": "Notifications",
  "본인인증": "Identity verification",
  "표시 개수": "How many to show",
  "제목": "Heading",
  "내용": "Text",
  "크기 (1-3)": "Size (1–3)",
  "문단": "Paragraph",
  "이미지": "Image",
  "이미지 URL": "Image URL",
  "대체 텍스트": "Alt text",
  "다단 레이아웃": "Columns",
  "간격(px)": "Gap (px)",
  "히어로 (큰 제목 영역)": "Hero (large headline area)",
  "작은 위 라벨": "Small label above",
  "설명": "Description",
  "버튼 1 문구": "Button 1 label",
  "버튼 1 링크": "Button 1 link",
  "버튼 2 문구": "Button 2 label",
  "버튼 2 링크": "Button 2 link",
  "배경 없이 (글자만)": "No background (text only)",
  "배경 이미지 URL (있으면 그 위에 글자를 얹는다)": "Background image URL (text is laid over it)",
  "특징 카드": "Feature cards",
  "묶음 제목 (비우면 표시 안 함)": "Group heading (hidden when empty)",
  "카드 — 한 줄에 하나: 제목 | 설명 | 링크(선택) | 아이콘(선택: truck, shield, chat, clock, star, check, heart, pin, mail, phone, image, cart, user, bell)":
    "Cards — one per line: title | description | link (optional) | icon (optional: truck, shield, chat, clock, star, check, heart, pin, mail, phone, image, cart, user, bell)",
  "행동 유도 배너": "Call-to-action banner",
  "버튼 문구": "Button label",
  "버튼 링크": "Button link",
  "자주 묻는 질문": "FAQ",
  "한 줄에 하나: 질문 | 답변": "One per line: question | answer",
  "알림 박스": "Callout box",
  "색 (info/success/warning/danger)": "Color (info/success/warning/danger)",
  "이미지 + 글": "Image with text",
  "이미지 설명(대체 텍스트)": "Image description (alt text)",
  "본문": "Body",
  "이미지를 오른쪽에": "Image on the right",
  "숫자 강조": "Highlighted numbers",
  "한 줄에 하나: 숫자 | 라벨": "One per line: number | label",
  "고객 후기": "Testimonials",
  "한 줄에 하나: 인용문 | 이름 | 소속(선택)": "One per line: quote | name | affiliation (optional)",
  "이미지 갤러리": "Image gallery",
  "한 줄에 하나: 이미지 URL | 캡션 | 링크(선택)": "One per line: image URL | caption | link (optional)",
  "열 수 (2~5)": "Columns (2–5)",
  "배너 슬라이드": "Banner slides",
  "한 줄에 하나: 이미지 URL | 제목(선택) | 설명(선택) | 링크(선택)":
    "One per line: image URL | title (optional) | description (optional) | link (optional)",
  "높이 px (기본 420, 0 이면 이미지 비율)": "Height in px (420 by default; 0 keeps the image ratio)",
  "자동 넘김 초 (0 이면 자동 넘김 없음)": "Auto-advance seconds (0 turns it off)",
  "화면 폭 꽉 채우기": "Full-bleed width",
  "구분선": "Divider",
  "여백": "Spacer",
  "높이(px)": "Height (px)",
  "통합검색": "Site search",
};

const CORE_LABELS: Partial<Record<Locale, MessageCatalog>> = { en: CORE_LABEL_EN };

/** 코어가 선언한 라벨을 사이트 언어로 — 없으면 원문 그대로(자연 폴백) */
export function translateCoreLabel(locale: Locale, text: string): string {
  if (locale === DEFAULT_LOCALE) return text;
  return CORE_LABELS[locale]?.[text] ?? text;
}

/** 검사 스크립트가 읽는 원문 목록 */
export const CORE_LABEL_SOURCES = Object.keys(CORE_LABEL_EN);

/**
 * 값이 들어가는 오류 문장 — **키 + 파라미터**로 던지고 응답 경계에서 조립한다.
 *
 * 완성된 문장은 원문을 키로 치환할 수 있지만(`translateCoreError`), 값이 박힌
 * 문장은 실행 시점 문자열이 코드의 리터럴과 달라 걸리지 않는다:
 *
 *   throw new BadRequestException(`${seconds}초 후 다시 시도해주세요.`)
 *
 * 플러그인은 활성화 때 바인딩된 `ctx.t` 를 던지는 자리에서 부를 수 있지만,
 * 코어는 그럴 수 없다 — 사이트 언어는 DB 에 있고 던지는 곳은 동기 함수 깊은
 * 곳이다. 그래서 **키와 값만 실어 던지고**, 언어를 아는 곳(전역 예외 필터)에서
 * 문장을 만든다. 던져진 예외 자체에는 한국어 문장도 함께 담아 둔다 — 필터를
 * 거치지 않는 경로(로그·테스트)에서도 읽을 수 있어야 한다.
 */
const CORE_TEMPLATE_KO: MessageCatalog = {
  "err.tooManyAttemptsSec": "너무 많이 시도했습니다. {seconds}초 후 다시 시도해주세요.",
  "err.unknownTemplateVars": "이 알림이 채울 수 없는 변수가 있습니다: {unknown}. 쓸 수 있는 변수: {known}",
  "err.tooManyLogins": "로그인 시도가 너무 많습니다. {minutes}분 후 다시 시도하세요.",
  "err.tooManySignups": "{label} 가입 시도가 너무 많습니다. {minutes}분 후 다시 시도하세요.",
  "err.mustStartWithHttp": "{label}은 http(s):// 로 시작해야 합니다.",
  "err.oauthNotConfigured": "{label} 로그인이 설정되지 않았습니다.",
  "err.notBase32": "base32 가 아닌 문자: {char}",
  "err.zipEntryMissing": "zip 안에 진입 파일 \"{entry}\" 가 없습니다.",
  "err.zipManifestCount": "zip 최상위에 {file} 이 정확히 하나 있어야 합니다 (발견 {found}개).",
  "err.zipManifestUnreadable": "{file} 을 읽을 수 없습니다 — JSON 형식이 아닙니다.",
  "err.badExtensionName": "확장 이름 \"{name}\" 을 쓸 수 없습니다 — 영문 소문자·숫자·하이픈만 가능합니다.",
  "err.zipBadPath": "zip 안에 허용되지 않는 경로가 있습니다: {path}",
  "err.badPath": "허용되지 않는 경로입니다: {path}",
  "err.badUrl": "잘못된 주소입니다: {url}",
  "err.notInstalled": "설치되어 있지 않습니다: {name}",
  "err.notNewerVersion": "새 버전이 아닙니다 (현재 {current}, 제시된 {offered}).",
  "err.zipNameMismatch": "ZIP 안의 확장 이름({found})이 요청한 이름({name})과 다릅니다. 확인이 필요합니다.",
  "err.notInRegistry": "레지스트리에 없는 확장입니다: {name}",
  "err.manifestNameMismatch": "업데이트 매니페스트의 이름({found})이 확장({expected})과 다릅니다.",
  "err.downloadFailed": "받기 실패 (HTTP {status}): {path}",
  "err.fileTooLargeMb": "파일이 너무 큽니다 ({mb}MB 상한).",
  "err.unknownStarter": "알 수 없는 사이트 유형입니다: {code}",
  "err.badFileType": "허용되지 않는 파일 형식입니다: {ext} — 허용: {allowed}",
  "err.noExt": "(확장자 없음)",
  "err.mimeMismatch": "파일 내용과 확장자가 일치하지 않습니다 ({type}).",
  "err.agreementRequiredSignup": "{title}에 동의해야 가입할 수 있습니다.",
  "err.agreementRequiredUse": "{title}에 동의해야 계속 이용할 수 있습니다.",
  "err.verifyMailCooldown": "인증 메일을 방금 보냈습니다. {seconds}초 후에 다시 시도해주세요.",
  "err.slugTaken": "주소 \"{slug}\" 는 이미 쓰이고 있습니다.",
  "err.treeNotArray": "블록 목록의 모양이 올바르지 않습니다.",
  "err.treeTooDeep": "블록을 {max}단보다 깊게 넣을 수 없습니다.",
  "err.treeTooMany": "한 페이지에 블록을 {max}개보다 많이 둘 수 없습니다.",
  "err.treeBadNode": "블록 하나의 모양이 올바르지 않습니다.",
  "err.treeBadProps": "블록({block})의 속성 모양이 올바르지 않습니다.",
  "err.treeBadChildren": "블록({block})의 안쪽 블록 목록 모양이 올바르지 않습니다.",
  "err.draftSession": "미리보기 세션이 올바르지 않습니다. 편집기를 새로 열어 주세요.",
  "err.pageStatus": "알 수 없는 상태입니다: {status}",
  "err.scheduleTime": "예약 발행은 공개할 시각을 정해야 합니다.",
  "err.schedulePast": "공개 시각이 이미 지났습니다. 앞으로의 시각을 골라주세요.",
  "err.revisionNotFound": "{no}번째 판을 찾을 수 없습니다.",
  "err.maintenance": "사이트를 점검하고 있습니다. 잠시 뒤에 다시 시도해주세요.",
  "err.pluginMigrationLock": "플러그인 마이그레이션 락을 60초 안에 얻지 못했습니다 ({plugin}).",
  "err.unknownAdminScreen": "알 수 없는 관리 화면입니다: {screen}",
  "err.unknownBlock": "알 수 없는 블록입니다: {name}",
  "err.settingNotEditable": "수정할 수 없는 설정입니다: {key}",
  "err.settingMustBeString": "{key}: 문자열이어야 합니다.",
  "err.settingMustBeBool": "{key}: true/false여야 합니다.",
  "err.unsupportedLocale": "지원하지 않는 언어입니다: {value} (지원: {available})",
  "err.badIpList": "IP 형식이 올바르지 않습니다: {list}",
  "err.badIpListHint":
    "IP 형식이 올바르지 않습니다: {list} (IPv4, IPv4 CIDR, IPv6 단일 주소만 받습니다)",
  "err.wouldLockSelfIp":
    "지금 접속한 IP({ip})가 목록에 없습니다 — 저장하면 스스로 잠깁니다. 현재 IP 를 목록에 추가해주세요.",
  "err.wouldBlockSelfIp": "지금 접속한 IP({ip})가 차단 목록에 있습니다 — 저장하면 스스로 차단됩니다.",
  "err.urlNotAllowed": "허용되지 않는 주소입니다: {url}",
  "err.themeNotFound": "테마 \"{name}\" 을 찾을 수 없습니다.",
  "err.nameChangeCooldown": "이름은 {days}일마다 바꿀 수 있습니다. {left}일 후에 다시 시도해주세요.",
  "err.configUnwritable":
    "설정 파일을 쓸 수 없습니다: {path} 디렉터리 쓰기 권한을 확인하세요. ({reason})",
};
const CORE_TEMPLATE_EN: MessageCatalog = {
  "err.tooManyAttemptsSec": "Too many attempts. Please try again in {seconds} seconds.",
  "err.unknownTemplateVars": "The text uses variables this notification cannot fill: {unknown}. Available variables: {known}",
  "err.tooManyLogins": "Too many sign-in attempts. Please try again in {minutes} minutes.",
  "err.tooManySignups": "Too many {label} sign-up attempts. Please try again in {minutes} minutes.",
  "err.mustStartWithHttp": "{label} must start with http(s)://.",
  "err.oauthNotConfigured": "{label} sign-in is not configured.",
  "err.notBase32": "Not a base32 character: {char}",
  "err.zipEntryMissing": "The zip has no entry file \"{entry}\".",
  "err.zipManifestCount": "The zip must contain exactly one {file} at its top level (found {found}).",
  "err.zipManifestUnreadable": "{file} could not be read — it is not valid JSON.",
  "err.badExtensionName":
    "The extension name \"{name}\" cannot be used — only lowercase letters, digits and hyphens.",
  "err.zipBadPath": "The zip contains a path that is not allowed: {path}",
  "err.badPath": "That path is not allowed: {path}",
  "err.badUrl": "That URL is not valid: {url}",
  "err.notInstalled": "Not installed: {name}",
  "err.notNewerVersion": "That is not a newer version (current {current}, offered {offered}).",
  "err.zipNameMismatch":
    "The extension name in the ZIP ({found}) differs from the requested name ({name}). Please check.",
  "err.notInRegistry": "That extension is not in the registry: {name}",
  "err.manifestNameMismatch":
    "The name in the update manifest ({found}) differs from the extension ({expected}).",
  "err.downloadFailed": "Download failed (HTTP {status}): {path}",
  "err.fileTooLargeMb": "The file is too large ({mb}MB limit).",
  "err.unknownStarter": "Unknown site type: {code}",
  "err.badFileType": "That file type is not allowed: {ext} — allowed: {allowed}",
  "err.noExt": "(no extension)",
  "err.mimeMismatch": "The file contents do not match the extension ({type}).",
  "err.agreementRequiredSignup": "You must accept {title} to sign up.",
  "err.agreementRequiredUse": "You must accept {title} to continue.",
  "err.verifyMailCooldown": "A verification email was just sent. Please try again in {seconds} seconds.",
  "err.slugTaken": "The slug \"{slug}\" is already in use.",
  "err.treeNotArray": "The block list is malformed.",
  "err.treeTooDeep": "Blocks cannot be nested more than {max} levels deep.",
  "err.treeTooMany": "A page cannot hold more than {max} blocks.",
  "err.treeBadNode": "One of the blocks is malformed.",
  "err.treeBadProps": "The settings of a block ({block}) are malformed.",
  "err.treeBadChildren": "The inner block list of a block ({block}) is malformed.",
  "err.draftSession": "The preview session is invalid. Please reopen the editor.",
  "err.pageStatus": "Unknown status: {status}",
  "err.scheduleTime": "Scheduled publishing needs a publish time.",
  "err.schedulePast": "That publish time has already passed. Please pick a future time.",
  "err.revisionNotFound": "Revision {no} was not found.",
  "err.maintenance": "The site is under maintenance. Please try again shortly.",
  "err.pluginMigrationLock": "Could not acquire the plugin migration lock within 60 seconds ({plugin}).",
  "err.unknownAdminScreen": "Unknown admin screen: {screen}",
  "err.unknownBlock": "Unknown block: {name}",
  "err.settingNotEditable": "That setting cannot be changed: {key}",
  "err.settingMustBeString": "{key}: must be a string.",
  "err.settingMustBeBool": "{key}: must be true or false.",
  "err.unsupportedLocale": "Unsupported language: {value} (supported: {available})",
  "err.badIpList": "Those IP addresses are not valid: {list}",
  "err.badIpListHint":
    "Those IP addresses are not valid: {list} (only IPv4, IPv4 CIDR and single IPv6 addresses are accepted)",
  "err.wouldLockSelfIp":
    "The IP you are connecting from ({ip}) is not on the list — saving would lock you out. Please add your current IP.",
  "err.wouldBlockSelfIp":
    "The IP you are connecting from ({ip}) is on the block list — saving would block you.",
  "err.urlNotAllowed": "That URL is not allowed: {url}",
  "err.themeNotFound": "The theme \"{name}\" was not found.",
  "err.nameChangeCooldown": "You can change your name every {days} days. Please try again in {left} days.",
  "err.configUnwritable":
    "The configuration file cannot be written: {path} Check the directory write permission. ({reason})",
};

const CORE_TEMPLATES: Record<Locale, MessageCatalog> = { ko: CORE_TEMPLATE_KO, en: CORE_TEMPLATE_EN };

/** 키와 값으로 문장을 만든다 — 그 언어에 템플릿이 없으면 ko 로, 그것도 없으면 키 그대로 */
export function renderCoreMessage(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = CORE_TEMPLATES[locale]?.[key] ?? CORE_TEMPLATE_KO[key];
  return template === undefined ? key : interpolate(template, params);
}

/** 검사 스크립트가 읽는 키 목록 */
export const CORE_TEMPLATE_KEYS = Object.keys(CORE_TEMPLATE_KO);
