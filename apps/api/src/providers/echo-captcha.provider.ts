import type { CacheProvider, CaptchaChallenge, CaptchaProvider } from "@brick/core";
import { SvgCaptchaProvider } from "./svg-captcha.provider.js";

/**
 * 테스트 전용 캡차 — 진짜 캡차에 정답을 하나 얹어서 낸다.
 *
 * 왜 필요한가: 정답은 이제 응답 어디에도 없다(그것이 핵심이다). 그래서 E2E 스모크가
 * "캡차를 제대로 풀면 가입이 된다"를 밟을 방법이 없다. 캡차를 끄면(`BRICK_CAPTCHA=off`)
 * 그 경로 자체가 사라진다 — 그렇게 전부 끄고 돌린 탓에 **가입 화면에 캡차 칸이 없는
 * 것을 아무도 못 봤다**. 그래서 끄는 대신, 켜 둔 채 정답을 알려준다.
 *
 * 암호·렌더링은 전부 진짜다. 다르게 동작하는 것은 응답에 `answer` 가 붙는 것뿐이다.
 * `BRICK_CAPTCHA=test` 를 명시해야 만들어지고, NODE_ENV=production 에서는 거부한다.
 */
export class EchoCaptchaProvider implements CaptchaProvider {
  readonly name = "svg-test";
  readonly enabled = true;
  private last = "";
  private readonly inner: SvgCaptchaProvider;

  constructor(secret: string, cache: CacheProvider) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BRICK_CAPTCHA=test 는 운영 환경에서 쓸 수 없습니다 (정답을 응답에 내보냅니다).");
    }
    console.warn(
      "[brick:captcha] ⚠ BRICK_CAPTCHA=test — 캡차 정답을 응답에 함께 내보냅니다. 테스트 전용 설정입니다.",
    );
    this.inner = new SvgCaptchaProvider(secret, cache, (answer) => {
      this.last = answer;
    });
  }

  async issue(): Promise<CaptchaChallenge> {
    const challenge = await this.inner.issue();
    return { ...challenge, answer: this.last } as CaptchaChallenge;
  }

  verify(token: string, answer: string): Promise<boolean> {
    return this.inner.verify(token, answer);
  }
}
