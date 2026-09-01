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

const KO = {
  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.busy": "로그인 중…",
  "login.fail": "로그인에 실패했습니다.",
  "login.noAccount": "계정이 없나요?",
  "login.register": "회원가입",
  "login.forgot": "비밀번호 찾기",

  "register.title": "회원가입",
  "register.name": "이름",
  "register.password8": "비밀번호 (8자 이상)",
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
  "account.backToSite": "사이트로 돌아가기",
  "account.profile": "기본 정보",
  "account.email": "이메일",
  "account.emailVerified": "인증됨",
  "account.emailUnverified": "미인증",
  "account.sendVerify": "인증 메일 보내기",
  "account.verifySent": "인증 메일을 보냈습니다. 받은편지함을 확인해주세요.",
  "account.name": "이름",
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
  "login.noAccount": "No account yet?",
  "login.register": "Sign up",
  "login.forgot": "Forgot password",

  "register.title": "Sign up",
  "register.name": "Name",
  "register.password8": "Password (8+ characters)",
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
  "account.backToSite": "Back to site",
  "account.profile": "Profile",
  "account.email": "Email",
  "account.emailVerified": "Verified",
  "account.emailUnverified": "Not verified",
  "account.sendVerify": "Send verification email",
  "account.verifySent": "Verification email sent. Please check your inbox.",
  "account.name": "Name",
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
      message = message.replace(`{${k}}`, String(v));
    }
    return message;
  };
}

export function useT(): (key: WebMessageKey, params?: Record<string, string>) => string {
  const locale = useLocale();
  return translatorFor(CATALOGS, KO, locale);
}
