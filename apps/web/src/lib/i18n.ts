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
  "register.done": "Welcome! Taking you to the login page…",
  "register.haveAccount": "Already have an account?",

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

export function useT(): (key: WebMessageKey, params?: Record<string, string>) => string {
  const [locale, setLocale] = useState(cachedLocale ?? "ko");

  useEffect(() => {
    if (cachedLocale) return;
    fetch("/api/i18n")
      .then((r) => r.json())
      .then((d) => {
        cachedLocale = d.locale === "en" ? "en" : "ko";
        setLocale(cachedLocale);
      })
      .catch(() => {
        cachedLocale = "ko"; // 언어를 못 받아도 화면은 떠야 한다
      });
  }, []);

  return (key, params) => {
    let message = CATALOGS[locale]?.[key] ?? KO[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) {
      message = message.replace(`{${k}}`, v);
    }
    return message;
  };
}
