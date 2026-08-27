import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { CacheProvider, CaptchaChallenge, CaptchaProvider } from "@brick/core";

/** 혼동되는 문자는 뺀다 (0/O, 1/I/l, 2/Z, 5/S, 8/B) — 사용자가 틀리면 캡차가 아니라 장벽이 된다 */
const ALPHABET = "34679ACDEFGHJKLMNPQRTUVWXY";
const LENGTH = 5;
const TTL_MS = 5 * 60_000;

/**
 * 자체 SVG 캡차.
 *
 * 설계:
 *  - **상태 없음.** 정답을 HMAC 서명된 토큰에 담아 클라이언트에 넘긴다.
 *    DB 테이블이 필요 없고, 여러 인스턴스에서도 동작한다.
 *  - **1회용.** 검증에 성공한 토큰을 캐시에 기록해 재사용을 막는다.
 *    이것이 없으면 봇이 한 번 풀고 그 토큰으로 무한히 글을 쓴다.
 *  - **짧은 만료.** 5분.
 *
 * 한계(정직하게): SVG `<text>` 기반이므로 OCR에 완전히 강하지 않다.
 * 대량 스팸봇 대부분을 막지만, 표적 공격에는 Turnstile/reCAPTCHA 플러그인을 권한다.
 */
export class SvgCaptchaProvider implements CaptchaProvider {
  readonly name = "svg";
  readonly enabled = true;

  constructor(
    private readonly secret: string,
    private readonly cache: CacheProvider,
  ) {}

  async issue(): Promise<CaptchaChallenge> {
    let answer = "";
    for (let i = 0; i < LENGTH; i++) {
      answer += ALPHABET[randomInt(ALPHABET.length)];
    }
    const nonce = randomBytes(8).toString("base64url");
    const expiresAt = Date.now() + TTL_MS;
    const token = this.sign({ a: answer, e: expiresAt, n: nonce });

    return {
      token,
      svg: this.render(answer),
      hint: "이미지에 보이는 문자를 입력하세요 (대소문자 구분 없음)",
    };
  }

  async verify(token: string, answer: string): Promise<boolean> {
    const payload = this.open(token);
    if (!payload) return false;
    if (payload.e < Date.now()) return false;

    const given = String(answer ?? "").trim().toUpperCase();
    if (given.length !== LENGTH) return false;

    // 정답 비교는 상수시간으로 — 타이밍으로 한 글자씩 맞춰가는 것을 막는다
    const expected = Buffer.from(payload.a);
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

    /**
     * 1회용 보장.
     * nonce를 캐시에 기록한다. 이미 있으면 재사용이므로 거부한다.
     * 캐시가 비어도(재시작 등) 만료가 5분이므로 위험 노출은 제한된다.
     */
    const key = `captcha:used:${payload.n}`;
    if (await this.cache.get<boolean>(key)) return false;
    await this.cache.set(key, true, Math.ceil(TTL_MS / 1000));
    return true;
  }

  private sign(payload: { a: string; e: number; n: string }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  private open(token: string): { a: string; e: number; n: string } | null {
    if (typeof token !== "string" || token.length > 500) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    // 서명 검증도 상수시간으로
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (typeof parsed?.a !== "string" || typeof parsed?.e !== "number" || typeof parsed?.n !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * SVG 렌더.
   * 글자마다 회전·크기·색을 흔들고 방해선과 점을 얹는다.
   * 외부 폰트를 쓰지 않으므로(배포본 크기·FTP 배포) 브라우저 기본 폰트로 그린다.
   */
  private render(answer: string): string {
    const width = 160;
    const height = 56;
    const cellWidth = (width - 20) / answer.length;

    const glyphs = [...answer]
      .map((ch, i) => {
        const x = 12 + i * cellWidth + randomInt(-3, 4);
        const y = height / 2 + randomInt(6, 12);
        const rotate = randomInt(-24, 25);
        const size = randomInt(24, 31);
        const gray = randomInt(20, 90);
        return (
          `<text x="${x}" y="${y}" font-size="${size}" fill="rgb(${gray},${gray},${gray + randomInt(0, 30)})" ` +
          `font-family="Georgia, 'Times New Roman', serif" font-weight="bold" ` +
          `transform="rotate(${rotate} ${x} ${y})">${ch}</text>`
        );
      })
      .join("");

    // 방해선 — 글자를 가로지르게 둔다
    const lines = Array.from({ length: 4 }, () => {
      const x1 = randomInt(0, width);
      const y1 = randomInt(0, height);
      const x2 = randomInt(0, width);
      const y2 = randomInt(0, height);
      const gray = randomInt(120, 200);
      return `<path d="M${x1} ${y1} Q ${randomInt(0, width)} ${randomInt(0, height)} ${x2} ${y2}" ` +
        `stroke="rgb(${gray},${gray},${gray})" stroke-width="${randomInt(1, 3)}" fill="none" />`;
    }).join("");

    const dots = Array.from({ length: 28 }, () => {
      const gray = randomInt(140, 210);
      return `<circle cx="${randomInt(0, width)}" cy="${randomInt(0, height)}" r="${randomInt(1, 3)}" ` +
        `fill="rgb(${gray},${gray},${gray})" />`;
    }).join("");

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-label="자동입력 방지 문자">` +
      `<rect width="${width}" height="${height}" fill="#f6f6f9" rx="6" />` +
      `${dots}${lines}${glyphs}` +
      `</svg>`
    );
  }
}
