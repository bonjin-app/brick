import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { CaptchaProvider } from "@brick/core";
import { CAPTCHA } from "../../runtime.module.js";

/**
 * 캡차 발급.
 *
 * 이미지와 토큰을 함께 준다. 폼은 토큰을 hidden 필드로 담아 제출하고,
 * 서버가 (토큰, 입력값) 쌍을 검증한다.
 */
@Controller("api/captcha")
export class CaptchaController {
  constructor(@Inject(CAPTCHA) private readonly captcha: CaptchaProvider) {}

  /** 새 문제 — JSON (토큰 + SVG 문자열) */
  @Get()
  async issue(@Res({ passthrough: true }) reply: FastifyReply) {
    // 캡차는 절대 캐시되어서는 안 된다. 캐시되면 모든 사용자가 같은 문제를 받는다.
    reply.header("cache-control", "no-store, no-cache, must-revalidate");
    const challenge = await this.captcha.issue();
    return { ...challenge, enabled: this.captcha.enabled, provider: this.captcha.name };
  }

  /**
   * 이미지 직접 서빙 — `<img src="/api/captcha/image?token=...">` 로 쓸 수 있게.
   * 토큰은 발급 API에서 받은 것을 그대로 넘긴다.
   *
   * 주의: 이 경로는 이미지만 낸다. 토큰이 없으면 새로 발급하지 않는다 —
   * 그러면 이미지와 폼의 토큰이 어긋난다.
   */
  @Get("image")
  async image(@Res() reply: FastifyReply) {
    const challenge = await this.captcha.issue();
    reply
      .header("content-type", "image/svg+xml")
      .header("cache-control", "no-store, no-cache, must-revalidate")
      .header("x-captcha-token", challenge.token);
    return reply.send(challenge.svg);
  }
}
