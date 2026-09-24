/**
 * 본인인증(휴대폰·간편인증) 추상화.
 *
 * **왜 코어에 두는가.** 한국 사이트에서 본인인증은 결제만큼 기본이다 — 성인 상품(주류·
 * 성인용품)을 팔려면 청소년보호법상 나이를 확인해야 하고, 커뮤니티는 "한 사람 한 계정" 으로
 * 다중 계정 어뷰징을 막는다. 쇼핑몰도 게시판도 같은 확인 결과를 써야 하므로, 결과는 코어가
 * 한 곳에 둔다. 공급자(포트원·NICE·KCP 직접 연동…)는 플러그인이 등록한다 — 결제
 * 게이트웨이와 같은 판단이다.
 *
 * 흐름:
 *   1. 서버가 인증 ID 를 **발급하고 회원에게 묶는다** (브라우저가 정한 ID 는 받지 않는다 —
 *      남이 끝낸 인증의 ID 를 들고 와 내 계정에 붙이는 것을 막는다)
 *   2. 브라우저가 공급자 인증창을 연다 (`clientScript`)
 *   3. 돌아오면 서버가 공급자에게 **직접 조회**해 결과를 확인한다 (`verify`) —
 *      화면이 보낸 이름·생년월일은 믿지 않는다
 */

/** 공급자가 확인해 준 사람 */
export interface VerifiedPerson {
  /**
   * 연계정보(CI) — 사람마다 하나이고 공급자가 달라도 같다. 한 사람 한 계정의 기준이다.
   * 계약에 따라 없을 수 있다(그때는 di 를 쓴다).
   */
  ci?: string | null;
  /** 중복가입확인정보(DI) — 사이트마다 다르다. ci 가 없을 때의 기준 */
  di?: string | null;
  name: string;
  /** YYYY-MM-DD */
  birthDate: string;
  gender?: "male" | "female" | null;
  isForeigner?: boolean | null;
}

export type IdentityCheck =
  | { ok: true; person: VerifiedPerson }
  | {
      ok: false;
      /** 운영자·로그용 */
      reason: string;
      /** 손님에게 보여줄 말 (없으면 코어의 일반 문구) */
      customerReason?: string;
    };

export interface IdentityProvider {
  /** 식별자 (영문 소문자) — 예: "portone" */
  name: string;
  /** 인증 화면에 보여줄 이름 — 예: "휴대폰 본인인증" */
  displayName: string;
  /**
   * 인증 화면에 넣을 `<script>`.
   *
   * `window.brickIdentity[name] = function (req) {…}` 를 정의한다. `req` 는
   * `{ requestId, returnUrl }` 이고, 인증창을 열어 끝나면 `returnUrl` 로 돌아오게 한다.
   * `window.brickIdentity[name].readReturn = function (query) {…}` 는 돌아온 주소의
   * 쿼리(URLSearchParams)에서 인증 ID 를 꺼낸다 — 실패·취소면 null.
   *
   * 외부 SDK 를 불러온다면 플러그인 매니페스트의 `csp` 에 그 호스트를 선언해야 한다.
   */
  clientScript: string;
  /** 설정이 끝나 인증을 받을 수 있는가 */
  isReady(): Promise<boolean>;
  /**
   * 인증 결과 조회 — 공급자 서버에 **직접** 묻는다. 던지지 않는다.
   * 같은 ID 를 여러 번 물어도 같은 답이어야 한다.
   */
  verify(requestId: string): Promise<IdentityCheck>;
}

/** 회원의 본인인증 상태 — 플러그인이 `ctx.identity.status()` 로 읽는다 */
export interface IdentityStatus {
  verified: boolean;
  /** 청소년보호법상 성인인가 (인증하지 않았으면 false) */
  adult: boolean;
  verifiedAt: Date | null;
}

/**
 * 청소년보호법상 성인인가.
 *
 * 법은 "만 19세 미만. 다만 19세에 도달하는 해의 1월 1일을 맞이한 사람은 제외" 라고 정한다 —
 * 생일이 지났는지가 아니라 **연도로** 가른다. 올해 19세가 되는 사람은 1월 1일부터 성인이다.
 * 날짜는 한국 시간으로 본다(12월 31일 밤 11시 UTC 는 한국에서 이미 새해다).
 */
export function isAdultByBirthYear(birthYear: number, now: Date = new Date()): boolean {
  if (!Number.isInteger(birthYear) || birthYear < 1900) return false;
  const kstYear = new Date(now.getTime() + 9 * 3600_000).getUTCFullYear();
  return kstYear - birthYear >= 19;
}
