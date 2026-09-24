"use client";

/**
 * 웹 공개 페이지(로그인·가입·비밀번호)의 다국어.
 *
 * 카탈로그는 번들에 정적으로 들어 있고(작다 — 몇 KB), 언어만
 * GET /api/i18n 에서 받는다. 이 페이지들은 전부 클라이언트 렌더이므로
 * 훅으로 충분하다. 기본이 ko 라 한국어 사이트에서는 깜빡임이 없고,
 * 영어 사이트에서는 첫 페인트 직후 한 번 바뀐다.
 *
 * 규칙은 코어와 같다: 요청 언어 → ko → 키 자체.
 */
import { useEffect, useState } from "react";
import { josa } from "@brick/core";

const KO = {
  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.busy": "로그인 중…",
  "login.fail": "로그인에 실패했습니다.",
  "login.twoFactor": "2단계 인증",
  "login.twoFactorDesc": "인증 앱의 6자리 코드를 입력해주세요. 휴대폰이 없다면 복구 코드를 입력해도 됩니다.",
  "login.twoFactorCode": "코드",
  "login.twoFactorSubmit": "확인",
  "login.twoFactorBack": "다른 계정으로 로그인",
  "login.noAccount": "계정이 없나요?",
  "login.register": "회원가입",
  "login.forgot": "비밀번호 찾기",

  "register.title": "회원가입",
  "register.name": "이름",
  "register.password8": "비밀번호 (8자 이상)",
  "register.captcha": "자동입력 방지",
  "verify.title": "이메일 인증",
  "verify.working": "확인하는 중…",
  "verify.done": "이메일이 인증되었습니다.",
  "verify.doneWith": "{email} 인증이 끝났습니다.",
  "verify.invalid": "링크가 만료되었거나 이미 사용되었습니다.",
  "verify.invalidHint": "인증 링크는 한 번만, 정해진 기간 안에만 쓸 수 있습니다. 내 정보에서 다시 받을 수 있습니다.",
  "verify.goAccount": "내 정보로",
  "register.captchaReload": "새 문자",
  "register.busy": "처리 중…",
  "register.submit": "가입하기",
  "register.fail": "가입에 실패했습니다.",
  "register.done": "가입 완료! 로그인 페이지로 이동합니다…",
  "register.haveAccount": "이미 계정이 있나요?",
  "register.required": "(필수)",
  "register.optional": "(선택)",
  "register.viewBody": "내용 보기",
  "register.age": "만 14세 이상입니다.",
  "register.needAge": "만 14세 이상만 가입할 수 있습니다.",


  "account.title": "내 정보",
  "account.myActivity": "내 활동",
  "account.backToSite": "사이트로 돌아가기",
  "account.profile": "기본 정보",
  "account.email": "이메일",
  "account.emailVerified": "인증됨",
  "account.emailUnverified": "미인증",
  "account.sendVerify": "인증 메일 보내기",
  "account.verifySent": "인증 메일을 보냈습니다. 받은편지함을 확인해주세요.",
  "account.changeEmail": "이메일 변경",
  "account.newEmail": "새 이메일 주소",
  "account.changeEmailHint": "새 주소로 인증 메일을 보냅니다. 링크를 열어야 주소가 바뀝니다.",
  "account.changeEmailSent": "새 주소로 인증 메일을 보냈습니다. 링크를 열면 주소가 바뀝니다.",
  "account.name": "이름",
  "account.avatar": "프로필 이미지",
  "account.avatarChange": "이미지 바꾸기",
  "account.avatarRemove": "지우기",
  "account.avatarHint": "png·jpg·gif·webp, 4MB 이하. 글과 댓글에 이름 옆에 보입니다.",
  "account.avatarSaved": "프로필 이미지를 바꿨습니다.",
  "account.nameHint": "이름은 글과 댓글에 그대로 보입니다. 사이트 설정에 따라 변경 주기가 있을 수 있습니다.",
  "account.birth": "생일 (월/일 · 선택)",
  "account.birthHint": "생일 쿠폰 등 혜택에만 쓰입니다. 비우면 저장하지 않습니다.",
  "account.marketing": "광고성 정보 수신 동의",
  "account.save": "저장",
  "account.saved": "저장되었습니다.",
  "account.password": "비밀번호 변경",
  "account.currentPassword": "현재 비밀번호",
  "account.newPassword": "새 비밀번호 (8자 이상)",
  "account.confirmPassword": "새 비밀번호 확인",
  "account.passwordChanged": "비밀번호가 변경되었습니다. 다른 기기의 로그인은 모두 해제되었습니다.",
  "account.change": "변경",
  "account.pendingTitle": "동의가 필요한 약관",
  "account.pendingDesc": "약관이 개정되었습니다. 계속 이용하시려면 아래 내용에 동의해주세요.",
  "account.pendingAgree": "위 내용에 동의합니다",
  "account.pendingSubmit": "동의하고 계속하기",
  "account.pendingDone": "동의가 기록되었습니다.",
  "account.pendingVersion": "{version}차 개정",
  "account.identities": "연결된 로그인 수단",
  "account.identitiesDesc": "여기 있는 계정으로도 로그인할 수 있습니다. 모르는 것이 있으면 바로 해제하세요.",
  "account.identitiesEmpty": "연결된 소셜 계정이 없습니다.",
  "account.identityLinked": "{date} 연결",
  "account.identityUnlink": "해제",
  "account.identityUnlinkConfirm": "{label} 연결을 해제할까요? 그 계정으로는 더 이상 로그인할 수 없습니다.",
  "account.identityUnlinked": "연결을 해제했습니다.",
  "account.identityAdd": "{label} 연결",
  "account.identityAddNote": "연결하려면 비밀번호를 다시 확인합니다 — 계정에 로그인 수단을 더하는 일이기 때문입니다.",
  "account.identityPassword": "비밀번호",
  "account.identityPasswordWrong": "비밀번호가 올바르지 않습니다.",
  "account.totp": "2단계 인증",
  "account.totpDesc": "비밀번호가 새어 나가도, 휴대폰의 인증 앱이 만드는 6자리 코드가 없으면 로그인할 수 없습니다.",
  "account.totpOff": "꺼져 있음",
  "account.totpOnSince": "{date}부터 켜져 있습니다.",
  "account.totpCodesLeft": "남은 복구 코드 {count}개",
  "account.totpCodesLow": "복구 코드가 얼마 남지 않았습니다. 지금 다시 발급받아 두세요.",
  "account.totpRequired": "이 사이트는 관리자·운영자에게 2단계 인증을 요구합니다. 등록하기 전에는 관리 화면을 쓸 수 없습니다.",
  "account.totpCannotDisable": "강제 설정이 켜져 있어 해제할 수 없습니다.",
  "account.totpNeedPassword": "비밀번호로 로그인하는 계정에서만 켤 수 있습니다. 먼저 비밀번호를 설정해주세요.",
  "account.totpStart": "2단계 인증 켜기",
  "account.totpStep1": "인증 앱(Google Authenticator, Authy, 1Password 등)을 엽니다.",
  "account.totpStep2": "계정을 추가하고 아래 키를 입력합니다. 휴대폰으로 보고 있다면 링크를 눌러 바로 넣을 수 있습니다.",
  "account.totpStep3": "앱에 뜬 6자리 코드를 입력하면 켜집니다. 코드를 확인하기 전에는 켜지지 않습니다.",
  "account.totpOpenApp": "인증 앱으로 바로 등록",
  "account.totpCode": "인증 앱의 6자리 코드",
  "account.totpTurnOn": "확인하고 켜기",
  "account.totpOn": "2단계 인증을 켰습니다.",
  "account.totpDisable": "해제",
  "account.totpDisabled": "2단계 인증을 해제했습니다.",
  "account.totpRegen": "복구 코드 다시 발급",
  "account.totpCodesTitle": "복구 코드 — 지금 한 번만 보입니다",
  "account.totpCodesWarn": "안전한 곳에 저장해주세요. 휴대폰을 잃으면 이 코드로만 로그인할 수 있습니다.",
  "account.totpCodesKept": "저장했습니다",
  "account.totpCopy": "복사",
  "account.totpCopied": "복사했습니다.",
  "account.totpCancel": "취소",
  "account.sessions": "접속 중인 기기",
  "account.sessionCurrent": "현재 기기",
  "account.sessionRevoke": "끊기",
  "account.sessionRevokeOthers": "다른 기기 모두 끊기",
  "account.sessionsRevoked": "다른 기기의 로그인을 모두 끊었습니다.",
  "account.lastSeen": "마지막 사용",
  "account.withdraw": "회원 탈퇴",
  "account.withdrawDesc": "탈퇴하면 개인정보는 즉시 파기됩니다. 법령상 보존해야 하는 거래 기록은 개인 식별을 끊고 보관됩니다.",
  "account.withdrawLosses": "탈퇴하면 사라지는 것",
  "account.deletePosts": "작성한 글도 함께 삭제",
  "account.deletePostsHint": "선택하지 않으면 글은 \"탈퇴한 회원\"으로 남습니다.",
  "account.withdrawPassword": "비밀번호로 본인 확인",
  "account.withdrawConfirmPhrase": "\"탈퇴합니다\"를 입력해 본인 확인",
  "account.withdrawButton": "탈퇴하기",
  "account.withdrawDone": "탈퇴가 완료되었습니다. 그동안 이용해주셔서 감사합니다.",
  "account.loginRequired": "로그인이 필요합니다.",
  "account.goLogin": "로그인하러 가기",
  "account.fail": "요청에 실패했습니다.",

  "social.or": "또는",
  "social.continue": "{label}로 계속하기",

  "forgot.title": "비밀번호 찾기",
  "forgot.sent": "로 재설정 링크를 보냈습니다.",
  "forgot.hint": "메일이 오지 않으면 스팸함을 확인해주세요. 링크는 30분간 유효하며 한 번만 사용할 수 있습니다.",
  "forgot.back": "로그인으로 돌아가기",
  "forgot.desc": "가입한 이메일 주소를 입력하면 재설정 링크를 보내드립니다.",
  "forgot.busy": "전송 중…",
  "forgot.submit": "재설정 링크 받기",

  "reset.title": "비밀번호 재설정",
  "reset.checking": "링크를 확인하는 중…",
  "reset.invalid": "이 링크는 만료되었거나 이미 사용되었습니다.",
  "reset.again": "재설정 링크를 다시 받기",
  "reset.changed": "비밀번호가 변경되었습니다.",
  "reset.sessionsCleared": "보안을 위해 기존 로그인 세션은 모두 해제되었습니다.",
  "reset.loginNew": "새 비밀번호로 로그인",
  "reset.newPassword": "새 비밀번호 (8자 이상)",
  "reset.confirm": "새 비밀번호 확인",
  "reset.mismatch": "비밀번호가 서로 다릅니다.",
  "reset.tooShort": "비밀번호는 8자 이상이어야 합니다.",
  "reset.busy": "변경 중…",
  "reset.submit": "비밀번호 변경",
  "reset.fail": "재설정에 실패했습니다.",
} as const;

const EN: Record<keyof typeof KO, string> = {
  "login.title": "Log in",
  "login.email": "Email",
  "login.password": "Password",
  "login.busy": "Signing in…",
  "login.fail": "Login failed.",
  "login.twoFactor": "Two-factor authentication",
  "login.twoFactorDesc": "Enter the 6-digit code from your authenticator app. Without your phone, a recovery code works too.",
  "login.twoFactorCode": "Code",
  "login.twoFactorSubmit": "Verify",
  "login.twoFactorBack": "Sign in as someone else",
  "login.noAccount": "No account yet?",
  "login.register": "Sign up",
  "login.forgot": "Forgot password",

  "register.title": "Sign up",
  "register.name": "Name",
  "register.password8": "Password (8+ characters)",
  "register.captcha": "Verification",
  "verify.title": "Email verification",
  "verify.working": "Checking…",
  "verify.done": "Your email is verified.",
  "verify.doneWith": "{email} is verified.",
  "verify.invalid": "This link has expired or was already used.",
  "verify.invalidHint": "Verification links work once, within a limited time. You can request a new one from your account.",
  "verify.goAccount": "Go to account",
  "register.captchaReload": "New image",
  "register.busy": "Working…",
  "register.submit": "Create account",
  "register.fail": "Sign-up failed.",
  "register.required": "(required)",
  "register.optional": "(optional)",
  "register.viewBody": "View details",
  "register.age": "I am 14 years of age or older.",
  "register.needAge": "You must be at least 14 years old to sign up.",
  "register.done": "Welcome! Taking you to the login page…",
  "register.haveAccount": "Already have an account?",


  "account.title": "My account",
  "account.myActivity": "My activity",
  "account.backToSite": "Back to site",
  "account.profile": "Profile",
  "account.email": "Email",
  "account.emailVerified": "Verified",
  "account.emailUnverified": "Not verified",
  "account.sendVerify": "Send verification email",
  "account.verifySent": "Verification email sent. Please check your inbox.",
  "account.changeEmail": "Change email",
  "account.newEmail": "New email address",
  "account.changeEmailHint": "We send a verification link to the new address; it changes once you open it.",
  "account.changeEmailSent": "Verification link sent to the new address. Open it to complete the change.",
  "account.name": "Name",
  "account.avatar": "Profile image",
  "account.avatarChange": "Change image",
  "account.avatarRemove": "Remove",
  "account.avatarHint": "png, jpg, gif or webp up to 4MB. Shown next to your name on posts and comments.",
  "account.avatarSaved": "Profile image updated.",
  "account.nameHint": "Your name appears on posts and comments. The site may limit how often it can change.",
  "account.birth": "Birthday (month/day, optional)",
  "account.birthHint": "Used only for perks like birthday coupons. Leave empty to not store it.",
  "account.marketing": "Marketing emails",
  "account.save": "Save",
  "account.saved": "Saved.",
  "account.password": "Change password",
  "account.currentPassword": "Current password",
  "account.newPassword": "New password (8+ characters)",
  "account.confirmPassword": "Confirm new password",
  "account.passwordChanged": "Password changed. All other sessions were signed out.",
  "account.change": "Change",
  "account.pendingTitle": "Terms that need your consent",
  "account.pendingDesc": "The terms have been revised. Please agree to continue using the site.",
  "account.pendingAgree": "I agree to the above",
  "account.pendingSubmit": "Agree and continue",
  "account.pendingDone": "Your consent has been recorded.",
  "account.pendingVersion": "revision {version}",
  "account.identities": "Linked sign-in methods",
  "account.identitiesDesc": "These accounts can also sign in here. Unlink anything you do not recognise.",
  "account.identitiesEmpty": "No social accounts are linked.",
  "account.identityLinked": "linked {date}",
  "account.identityUnlink": "Unlink",
  "account.identityUnlinkConfirm": "Unlink {label}? It will no longer be able to sign in.",
  "account.identityUnlinked": "Unlinked.",
  "account.identityAdd": "Link {label}",
  "account.identityAddNote": "Linking asks for your password again — it adds a way into your account.",
  "account.identityPassword": "Password",
  "account.identityPasswordWrong": "That password is not correct.",
  "account.totp": "Two-factor authentication",
  "account.totpDesc": "Even if your password leaks, no one can sign in without the 6-digit code from your authenticator app.",
  "account.totpOff": "Off",
  "account.totpOnSince": "On since {date}.",
  "account.totpCodesLeft": "{count} recovery codes left",
  "account.totpCodesLow": "You are running low on recovery codes. Generate a new set now.",
  "account.totpRequired": "This site requires two-factor authentication for admins and managers. You cannot use the admin screens until you set it up.",
  "account.totpCannotDisable": "It cannot be turned off while the site requires it.",
  "account.totpNeedPassword": "Only accounts with password sign-in can turn this on. Set a password first.",
  "account.totpStart": "Turn on two-factor authentication",
  "account.totpStep1": "Open an authenticator app (Google Authenticator, Authy, 1Password, …).",
  "account.totpStep2": "Add an account and enter the key below. On a phone, tap the link to add it directly.",
  "account.totpStep3": "Enter the 6-digit code the app shows. It is not turned on until the code checks out.",
  "account.totpOpenApp": "Add it in the authenticator app",
  "account.totpCode": "6-digit code from the app",
  "account.totpTurnOn": "Verify and turn on",
  "account.totpOn": "Two-factor authentication is on.",
  "account.totpDisable": "Turn off",
  "account.totpDisabled": "Two-factor authentication is off.",
  "account.totpRegen": "Generate new recovery codes",
  "account.totpCodesTitle": "Recovery codes — shown only once",
  "account.totpCodesWarn": "Keep them somewhere safe. If you lose your phone, these are the only way back in.",
  "account.totpCodesKept": "I saved them",
  "account.totpCopy": "Copy",
  "account.totpCopied": "Copied.",
  "account.totpCancel": "Cancel",
  "account.sessions": "Active sessions",
  "account.sessionCurrent": "This device",
  "account.sessionRevoke": "Sign out",
  "account.sessionRevokeOthers": "Sign out all other devices",
  "account.sessionsRevoked": "All other sessions were signed out.",
  "account.lastSeen": "Last seen",
  "account.withdraw": "Delete account",
  "account.withdrawDesc": "Your personal data is erased immediately. Transaction records required by law are kept with your identity removed.",
  "account.withdrawLosses": "What you will lose",
  "account.deletePosts": "Also delete my posts",
  "account.deletePostsHint": "If unchecked, posts remain under \"withdrawn member\".",
  "account.withdrawPassword": "Confirm with your password",
  "account.withdrawConfirmPhrase": "Type \"탈퇴합니다\" to confirm",
  "account.withdrawButton": "Delete my account",
  "account.withdrawDone": "Your account has been deleted. Thank you for being with us.",
  "account.loginRequired": "You need to log in.",
  "account.goLogin": "Go to login",
  "account.fail": "Request failed.",

  "social.or": "or",
  "social.continue": "Continue with {label}",

  "forgot.title": "Forgot password",
  "forgot.sent": " — we sent a reset link to this address.",
  "forgot.hint": "If it doesn't arrive, check your spam folder. The link is valid for 30 minutes and can be used once.",
  "forgot.back": "Back to login",
  "forgot.desc": "Enter your email and we'll send you a reset link.",
  "forgot.busy": "Sending…",
  "forgot.submit": "Send reset link",

  "reset.title": "Reset password",
  "reset.checking": "Checking the link…",
  "reset.invalid": "This link has expired or was already used.",
  "reset.again": "Request a new reset link",
  "reset.changed": "Your password has been changed.",
  "reset.sessionsCleared": "For your security, all existing sessions were signed out.",
  "reset.loginNew": "Log in with your new password",
  "reset.newPassword": "New password (8+ characters)",
  "reset.confirm": "Confirm new password",
  "reset.mismatch": "Passwords don't match.",
  "reset.tooShort": "Password must be at least 8 characters.",
  "reset.busy": "Changing…",
  "reset.submit": "Change password",
  "reset.fail": "Reset failed.",
};

export type WebMessageKey = keyof typeof KO;
const CATALOGS: Record<string, Record<string, string>> = { ko: KO, en: EN };

/** 페이지 이동 간 재요청을 막는 모듈 캐시 */
let cachedLocale: string | null = null;
let cachedSiteName: string | null = null;

/** 사이트 언어 훅 — 공개·관리 화면이 공유한다 */
/**
 * 숫자·날짜·금액 포맷용 BCP-47 태그.
 *
 * 화면의 숫자는 **사이트 언어**를 따라야 한다. 그동안 세 갈래였다:
 *   - `toLocaleString("ko-KR")` 로 못박은 곳 (영어 관리자도 "12,000원")
 *   - `toLocaleString()` 로 비워 둔 곳 (**브라우저** 언어를 따른다 — 한국어 사이트를
 *     미국 로케일 브라우저로 열면 날짜가 영어로 나온다)
 *   - 쇼핑몰 플러그인의 `localeTag()` (사이트 언어를 따른다 — 이것이 맞다)
 * 셋 중 맞는 하나로 모은다.
 *
 * **날짜는 브라우저에서만 이 태그로 포맷한다.** Node 는 `ko-KR` 의 오전/오후를
 * "PM" 으로 내는 경우가 있다 — full ICU 에서도 그렇다(확인: Node 22.23 / ICU 78,
 * `2026. 9. 11. PM 2:06:35`). 게시판 플러그인이 그것을 겪고 서버용 날짜 포맷터를
 * 직접 들고 있다(`plugins/brick-board/src/types.ts` 의 `fullDate`). 이 파일의
 * 태그를 쓰는 곳은 전부 `"use client"` 이므로 브라우저 ICU 를 쓴다 — 서버
 * 컴포넌트나 API 로 날짜 포맷을 옮길 때는 그 포맷터를 쓸 것.
 *
 * 숫자·금액의 자리 묶음은 그런 문제가 없다(서버·브라우저 모두 "12,000").
 */
export function localeTagFor(locale: string): string {
  return locale === "en" ? "en-US" : "ko-KR";
}

/** 화면에서 쓰는 포맷 태그 — 사이트 언어를 따라간다 (브라우저 전용: 위 주석 참고) */
export function useLocaleTag(): string {
  return localeTagFor(useLocale());
}

export function useLocale(): string {
  const [locale, setLocale] = useState(cachedLocale ?? "ko");

  useEffect(() => {
    if (cachedLocale) return;
    fetch("/api/i18n")
      .then((r) => r.json())
      .then((d) => {
        cachedLocale = d.locale === "en" ? "en" : "ko";
        cachedSiteName = String(d.siteName ?? "") || null;
        setLocale(cachedLocale);
      })
      .catch(() => {
        cachedLocale = "ko"; // 언어를 못 받아도 화면은 떠야 한다
      });
  }, []);

  return locale;
}

/** 사이트 이름 훅 — 로그인·가입 화면의 머리글. useLocale 과 같은 응답을 쓴다 */
export function useSiteName(): string {
  const [name, setName] = useState(cachedSiteName ?? "");

  useEffect(() => {
    if (cachedSiteName) { setName(cachedSiteName); return; }
    fetch("/api/i18n")
      .then((r) => r.json())
      .then((d) => {
        cachedLocale = d.locale === "en" ? "en" : "ko";
        cachedSiteName = String(d.siteName ?? "") || null;
        if (cachedSiteName) setName(cachedSiteName);
      })
      .catch(() => {}); // 이름을 못 받아도 화면은 떠야 한다
  }, []);

  return name;
}

/** 카탈로그 → 번역 함수. 규칙: 요청 언어 → ko → 키 자체 */
export function translatorFor<K extends string>(
  catalogs: Record<string, Record<string, string>>,
  koCatalog: Record<K, string>,
  locale: string,
): (key: K, params?: Record<string, string | number>) => string {
  return (key, params) => {
    let message = catalogs[locale]?.[key] ?? koCatalog[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) {
      const value = String(v);
      /*
       * `{label:을/를}` — 값의 받침을 보고 조사를 고른다.
       *
       * 이름이 값에서 오기 때문에(리소스마다 "주문"·"FAQ"·"기획전") 문구를 미리
       * 고정할 수 없어서 카탈로그에 "을(를)"이라고 적어 두고 있었다. 괄호 표기는
       * 서식이 아니라 **포기**다 — 화면에는 "FAQ을(를) 저장했습니다"가 그대로 뜬다.
       * 영어 카탈로그는 이 표기를 쓰지 않으므로 아무것도 달라지지 않는다.
       */
      message = message.replace(
        new RegExp(`\\{${k}:([^}]+)\\}`, "g"),
        (_m, pair: string) => josa(value, pair),
      );
      /*
       * split/join 으로 끼운다 — `replace(문자열, 값)` 이 아니다.
       *
       * replace 는 값 안의 `$&`·`$'`·`` $` ``·`$$` 를 **치환 패턴**으로 해석한다. 값은
       * 상품명·회원 이름·서버 오류 원문처럼 사람이 정한 글자라, "$$ 특가" 는 "$ 특가" 로,
       * "A$'B" 는 문장 뒷부분을 끼워 넣은 글자로 바뀌어 화면에 나갔다. 그리고 replace 는
       * **첫 자리만** 바꿔서, 같은 자리표시자가 두 번 나오는 문장은 뒤의 것이 그대로 남았다.
       * (서버 쪽 makeTranslator 는 처음부터 함수 치환이라 둘 다 없었다.)
       */
      message = message.split(`{${k}}`).join(value);
    }
    return message;
  };
}

export function useT(): (key: WebMessageKey, params?: Record<string, string>) => string {
  const locale = useLocale();
  return translatorFor(CATALOGS, KO, locale);
}
