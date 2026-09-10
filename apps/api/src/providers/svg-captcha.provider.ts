import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { CacheProvider, CaptchaChallenge, CaptchaProvider } from "@brick/core";

/** 혼동되는 문자는 뺀다 (0/O, 1/I/l, 2/Z, 5/S, 8/B) — 사용자가 틀리면 캡차가 아니라 장벽이 된다 */
const ALPHABET = "34679ACDEFGHJKLMNPQRTUVWXY";
const LENGTH = 5;
const TTL_MS = 5 * 60_000;

/**
 * 내장 선(stroke) 글꼴. 0~100 좌표계의 꺾은선이고, `|` 로 획을 나눈다.
 *
 * 왜 글꼴을 직접 들고 있는가: 정답이 문서에 **글자로 남아서는 안 되기** 때문이다.
 * `<text>` 로 그리면 그리는 순간 정답이 마크업에 평문으로 박힌다(그래서 고쳤다).
 * 그렇다고 외부 폰트를 받아 윤곽선을 뜨면 배포본이 커지고 FTP 설치가 무거워진다.
 * 26글자면 손으로 그려도 되는 양이다.
 */
const GLYPHS: Record<string, string> = {
  "3": "3,8 82,5 40,45 86,60 80,92 40,100 5,86",
  "4": "70,100 70,0|70,0 5,72 98,72",
  "6": "86,6 40,12 12,45 8,80 38,100 78,92 84,62 48,52 16,62",
  "7": "4,6 96,6 38,100",
  "9": "14,94 60,88 88,55 92,20 62,0 22,8 14,38 50,48 82,38",
  A: "4,100 50,0 96,100|22,66 78,66",
  C: "90,14 58,0 24,10 6,50 24,90 58,100 90,86",
  D: "10,2 10,100|10,2 58,6 90,40 90,62 58,96 10,100",
  E: "90,3 12,3 12,100 90,100|12,50 70,50",
  F: "90,3 12,3 12,100|12,50 68,50",
  G: "90,14 58,0 24,10 6,50 24,90 58,100 90,86 90,54 54,54",
  H: "12,0 12,100|88,0 88,100|12,50 88,50",
  J: "80,3 80,74 58,98 24,94 10,68",
  K: "12,0 12,100|90,3 16,55|36,42 92,100",
  L: "15,0 15,100 90,100",
  M: "6,100 6,0 50,62 94,0 94,100",
  N: "12,100 12,0 88,100 88,0",
  P: "12,100 12,3 64,6 88,28 64,52 12,54",
  Q: "50,0 18,20 8,50 18,80 50,100 82,80 92,50 82,20 50,0|58,70 96,100",
  R: "12,100 12,3 64,6 88,28 64,52 12,54|48,54 90,100",
  T: "4,4 96,4|50,4 50,100",
  U: "12,0 12,70 34,96 66,96 88,70 88,0",
  V: "5,0 50,100 95,0",
  W: "3,0 25,100 50,36 75,100 97,0",
  X: "6,0 94,100|94,0 6,100",
  Y: "6,0 50,52 94,0|50,52 50,100",
};

/**
 * 자체 SVG 캡차.
 *
 * 설계:
 *  - **상태 없음.** 정답을 아는 사람만 맞출 수 있게, 정답의 **HMAC 만** 토큰에 담는다.
 *    DB 테이블이 필요 없고, 여러 인스턴스에서도 동작한다.
 *  - **1회용.** 검증에 성공한 토큰을 캐시에 기록해 재사용을 막는다.
 *    이것이 없으면 봇이 한 번 풀고 그 토큰으로 무한히 글을 쓴다.
 *  - **짧은 만료.** 5분.
 *
 * 정답은 어디에도 평문으로 나가지 않는다. 이 문장이 이 파일의 전부다 —
 * 예전에는 두 군데로 새고 있었고, 그래서 캡차가 봇을 하나도 막지 못했다:
 *   1. SVG 를 `<text>` 로 그려서 마크업에 정답이 그대로 들어 있었다.
 *      OCR 이 필요 없었다. 정규식 한 줄이면 읽혔다.
 *   2. 토큰이 `{"a":"7APGD",...}` 를 base64 로 담고 있었다. 서명은 **위조**를 막을 뿐
 *      **열람**을 막지 않는다. base64 는 암호화가 아니다.
 * 지금은 글자를 선으로 그리고(GLYPHS), 토큰에는 HMAC(secret, nonce:정답) 만 넣는다.
 *
 * 한계(정직하게): 글자 모양을 알아보는 공격에는 약하다. 흔들기·방해선으로 자동 인식을
 * 어렵게 할 뿐이다. 표적 공격에는 Turnstile/reCAPTCHA 플러그인을 권한다.
 */
export class SvgCaptchaProvider implements CaptchaProvider {
  readonly name = "svg";
  readonly enabled = true;

  constructor(
    private readonly secret: string,
    private readonly cache: CacheProvider,
    /**
     * 테스트 전용 이음매. 스모크는 정답을 알아야 "제대로 풀면 통과한다"를 검증할 수 있는데,
     * 정답이 HTTP 로 나가지 않으므로 알 방법이 없다. 프로세스 안에서만 건네준다 —
     * RuntimeModule 은 이 인자를 넘기지 않으므로 운영 중에는 존재하지 않는 경로다.
     */
    private readonly onIssue?: (answer: string) => void,
  ) {}

  async issue(): Promise<CaptchaChallenge> {
    let answer = "";
    for (let i = 0; i < LENGTH; i++) {
      answer += ALPHABET[randomInt(ALPHABET.length)];
    }
    const nonce = randomBytes(8).toString("base64url");
    const expiresAt = Date.now() + TTL_MS;
    const token = this.sign({ h: this.digest(nonce, answer), e: expiresAt, n: nonce });
    this.onIssue?.(answer);

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

    // 정답 자체가 아니라 정답의 HMAC 을 비교한다. 길이가 항상 같으므로 상수시간 비교가 성립한다.
    const expected = Buffer.from(payload.h);
    const actual = Buffer.from(this.digest(payload.n, given));
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

  /** 정답의 지문. nonce 를 섞어 같은 정답이라도 문제마다 다른 값이 되게 한다 */
  private digest(nonce: string, answer: string): string {
    return createHmac("sha256", this.secret).update(`${nonce}:${answer}`).digest("base64url");
  }

  private sign(payload: { h: string; e: number; n: string }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  private open(token: string): { h: string; e: number; n: string } | null {
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
      if (typeof parsed?.h !== "string" || typeof parsed?.e !== "number" || typeof parsed?.n !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * SVG 렌더.
   * 글자마다 회전·크기·굵기·색을 흔들고 방해선과 점을 얹는다.
   * 글자는 `<path>` 다 — 문서 어디에도 정답 문자열이 없다.
   */
  private render(answer: string): string {
    const width = 160;
    const height = 56;
    const cellWidth = (width - 24) / answer.length;

    const glyphs = [...answer].map((ch, i) => {
      const size = randomInt(26, 34);
      const cx = 12 + i * cellWidth + cellWidth / 2 + randomInt(-3, 4);
      const cy = height / 2 + randomInt(-3, 4);
      const rotate = randomInt(-22, 23);
      const gray = randomInt(20, 80);
      const d = (GLYPHS[ch] ?? "")
        .split("|")
        .map((stroke) => {
          const pts = stroke.split(" ").map((p) => {
            const [gx, gy] = p.split(",").map(Number);
            // 0~100 격자를 글자 크기로 옮기고, 점마다 조금씩 흔든다 —
            // 획이 미세하게 떨려야 같은 글자가 매번 같은 모양으로 나오지 않는다.
            const x = cx + ((gx - 50) / 100) * size * 0.78 + randomInt(-1, 2);
            const y = cy + ((gy - 50) / 100) * size + randomInt(-1, 2);
            return `${x.toFixed(1)} ${y.toFixed(1)}`;
          });
          return `M${pts.join("L")}`;
        })
        .join("");
      return (
        `<path d="${d}" fill="none" stroke="rgb(${gray},${gray},${gray + randomInt(0, 30)})" ` +
        `stroke-width="${(randomInt(22, 32) / 10).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" ` +
        `transform="rotate(${rotate} ${cx.toFixed(1)} ${cy.toFixed(1)})" />`
      );
    });

    // 방해선 — 글자를 가로지르게 둔다
    const lines = Array.from({ length: 5 }, () => {
      const x1 = randomInt(0, width);
      const y1 = randomInt(0, height);
      const x2 = randomInt(0, width);
      const y2 = randomInt(0, height);
      const gray = randomInt(120, 195);
      return `<path d="M${x1} ${y1} Q ${randomInt(0, width)} ${randomInt(0, height)} ${x2} ${y2}" ` +
        `stroke="rgb(${gray},${gray},${gray})" stroke-width="${randomInt(1, 3)}" fill="none" />`;
    });

    const dots = Array.from({ length: 28 }, () => {
      const gray = randomInt(140, 210);
      return `<circle cx="${randomInt(0, width)}" cy="${randomInt(0, height)}" r="${randomInt(1, 3)}" ` +
        `fill="rgb(${gray},${gray},${gray})" />`;
    });

    // 글자와 방해선을 섞는다 — 순서로 글자만 골라낼 수 없게
    const marks = [...glyphs, ...lines];
    for (let i = marks.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [marks[i], marks[j]] = [marks[j], marks[i]];
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-label="자동입력 방지 문자">` +
      `<rect width="${width}" height="${height}" fill="#f6f6f9" rx="6" />` +
      `${dots.join("")}${marks.join("")}` +
      `</svg>`
    );
  }
}
