/**
 * 소셜 로그인 공급자 정의.
 *
 * 공급자마다 다른 것은 (1) 주소 세 개 (2) 프로필 응답의 모양 뿐이다.
 * 그래서 흐름 코드는 하나만 두고 여기서 차이만 선언한다.
 * 새 공급자를 붙이는 일이 표 한 줄 추가가 되어야 한다.
 */

export interface OAuthProfile {
  /** 공급자가 발급한 고유 id — 이메일이 아니다 */
  uid: string;
  email: string | null;
  /** 공급자가 이메일 소유를 확인했는가. 확인되지 않은 이메일로는 기존 계정에 붙이지 않는다 */
  emailVerified: boolean;
  displayName: string | null;
}

export interface OAuthProviderDef {
  name: string;
  label: string;
  /** 빈 문자열이면 주소를 관리자 설정에서 받는다 (사내 SSO) */
  authUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
  /** 인증 요청에 붙일 추가 파라미터 */
  extraAuthParams?: Record<string, string>;
  /** 프로필 응답 → 정규화 */
  parseProfile(raw: Record<string, unknown>): OAuthProfile;
  /** 색상 (로그인 버튼) */
  color: string;
}

const str = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s || null;
};

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google: {
    name: "google",
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    // prompt=select_account: 이미 로그인된 계정으로 조용히 통과하지 않게 한다.
    // 공용 PC에서 앞사람 계정으로 로그인되는 사고를 막는다.
    extraAuthParams: { access_type: "online", prompt: "select_account" },
    color: "#4285f4",
    parseProfile: (raw) => ({
      uid: String(raw.sub ?? ""),
      email: str(raw.email),
      emailVerified: raw.email_verified === true || raw.email_verified === "true",
      displayName: str(raw.name) ?? str(raw.given_name),
    }),
  },

  kakao: {
    name: "kakao",
    label: "카카오",
    authUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    // 카카오는 이메일이 선택 동의다 — 동의하지 않으면 이메일이 없는 채로 온다.
    // 그 경우에도 로그인은 되어야 하므로 이메일 없음을 정상 경로로 다룬다.
    scope: "account_email profile_nickname",
    color: "#fee500",
    parseProfile: (raw) => {
      const account = (raw.kakao_account ?? {}) as Record<string, unknown>;
      const profile = (account.profile ?? {}) as Record<string, unknown>;
      return {
        uid: String(raw.id ?? ""),
        email: str(account.email),
        // is_email_verified 와 is_email_valid 가 모두 참일 때만 신뢰한다
        emailVerified: account.is_email_verified === true && account.is_email_valid === true,
        displayName: str(profile.nickname),
      };
    },
  },

  naver: {
    name: "naver",
    label: "네이버",
    authUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    color: "#03c75a",
    parseProfile: (raw) => {
      const r = (raw.response ?? {}) as Record<string, unknown>;
      return {
        uid: String(r.id ?? ""),
        email: str(r.email),
        // 네이버는 검증 여부를 따로 주지 않는다. 네이버 계정의 이메일은
        // 가입 시 인증을 거치므로 검증된 것으로 다룬다.
        emailVerified: Boolean(str(r.email)),
        displayName: str(r.nickname) ?? str(r.name),
      };
    },
  },

  github: {
    name: "github",
    label: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    scope: "read:user user:email",
    color: "#24292f",
    parseProfile: (raw) => ({
      uid: String(raw.id ?? ""),
      email: str(raw.email),
      // /user 응답의 email 은 공개 설정된 것이고 검증 여부를 알 수 없다.
      // 검증된 이메일은 /user/emails 를 따로 봐야 하므로 여기서는 신뢰하지 않는다.
      emailVerified: false,
      displayName: str(raw.name) ?? str(raw.login),
    }),
  },

  /**
   * 일반 OpenID Connect — 사내 SSO.
   *
   * Keycloak · Authentik · Azure AD · Okta 처럼 표준 OIDC를 말하는 서버는
   * 주소만 다르고 흐름과 클레임이 같다. 그래서 공급자마다 코드를 늘리는 대신
   * 주소를 설정으로 받는 항목 하나를 둔다. 조직 계정으로만 들어오게 하려는
   * 사내 사이트에서 실제로 가장 많이 필요한 항목이다.
   */
  oidc: {
    name: "oidc",
    label: "SSO",
    authUrl: "",
    tokenUrl: "",
    profileUrl: "",
    scope: "openid email profile",
    color: "#4b5563",
    parseProfile: (raw) => ({
      uid: String(raw.sub ?? raw.id ?? ""),
      email: str(raw.email),
      // OIDC 표준 클레임. 문자열 "true" 로 보내는 구현이 있어 둘 다 받는다
      emailVerified: raw.email_verified === true || raw.email_verified === "true",
      displayName: str(raw.name) ?? str(raw.preferred_username),
    }),
  },
};

export function providerDef(name: string): OAuthProviderDef | null {
  return OAUTH_PROVIDERS[String(name).toLowerCase()] ?? null;
}
