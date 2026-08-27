/**
 * 캡차 추상화.
 *
 * 왜 필요한가: 비회원 글쓰기·댓글·회원가입은 스팸의 주 표적이다.
 * 도배 방지(작성 간격)만으로는 분산된 봇을 막을 수 없다.
 *
 * 왜 외부 서비스를 기본으로 쓰지 않는가: reCAPTCHA/Turnstile은 API 키 발급이 필요하고,
 * 그러면 "설치가 쉬워야 한다"(ADR-1)가 깨진다. 기본 구현은 키 없이 동작하고,
 * 더 강한 방어가 필요하면 플러그인이 이 인터페이스를 구현해 교체한다.
 */
export interface CaptchaChallenge {
  /** 검증에 함께 보내야 하는 토큰 (정답이 서명되어 담겨 있다) */
  token: string;
  /** 화면에 표시할 SVG 이미지 */
  svg: string;
  /** 사용자에게 보여줄 안내 (스크린리더용 대체 텍스트로도 쓴다) */
  hint: string;
}

export interface CaptchaProvider {
  /** 사용 중인 구현 이름 (관리자 화면 표시용) */
  readonly name: string;
  /** 캡차가 실제로 검사를 수행하는가. false면 항상 통과한다(개발·비활성) */
  readonly enabled: boolean;
  /** 새 문제 발급 */
  issue(): Promise<CaptchaChallenge>;
  /**
   * 검증. 성공하면 true.
   *
   * **1회용이어야 한다** — 같은 토큰으로 두 번 통과하면 봇이 한 번 풀고 무한히 재사용한다.
   */
  verify(token: string, answer: string): Promise<boolean>;
}

/** 캡차를 끈 상태 — 항상 통과시킨다 */
export class DisabledCaptchaProvider implements CaptchaProvider {
  readonly name = "disabled";
  readonly enabled = false;

  async issue(): Promise<CaptchaChallenge> {
    return { token: "", svg: "", hint: "" };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
