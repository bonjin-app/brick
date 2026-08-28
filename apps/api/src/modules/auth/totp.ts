/**
 * TOTP (RFC 6238) — 2단계 인증 코드 생성·검증.
 *
 * 외부 패키지를 쓰지 않는다. 필요한 것은 HMAC-SHA1 뿐이고 `node:crypto` 에
 * 있다. 자체 호스팅 CMS 에서 **의존성 하나는 공급망 위험 하나**다 —
 * 인증 경로에 들어가는 패키지라면 더 그렇다.
 *
 * 표준값을 그대로 쓴다: SHA1 · 30초 스텝 · 6자리. 인증 앱(Google
 * Authenticator, Authy, 1Password 등)이 기본으로 기대하는 값이고, 바꾸면
 * 일부 앱에서 동작하지 않는다.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * 허용 오차 — 앞뒤 1스텝(±30초).
 *
 * 휴대폰 시계가 조금 틀어져 있거나 코드를 입력하는 사이에 스텝이 넘어가는
 * 것을 흡수한다. **더 넓히지 않는다** — 창을 넓히는 만큼 가로챈 코드의
 * 유효 시간이 늘어난다.
 */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** base32 인코딩 (RFC 4648, 패딩 없음) — 인증 앱이 읽는 형식이다 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  // 공백과 패딩을 무시한다 — 사용자가 손으로 옮겨 적는 경우가 있다
  const clean = String(input ?? "").toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`base32 가 아닌 문자: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * 새 비밀 생성.
 *
 * 20바이트(160비트) — SHA1 의 블록에 맞고 RFC 4226 의 권고값이다.
 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 지금의 타임스텝 */
export function currentStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** 주어진 스텝의 코드 */
export function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  // 8바이트 빅엔디언 카운터
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", key).update(counter).digest();
  // 동적 절단 (RFC 4226 §5.4)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * 코드 검증.
 *
 * 맞으면 사용된 스텝을 돌려준다 — 호출자가 그것을 저장해 **같은 코드의
 * 재사용을 막아야 한다.** 30초 안에 코드를 본 사람이 그것을 다시 쓰는 것을
 * 검증만으로는 막을 수 없다.
 *
 * `lastStep` 을 주면 그보다 작거나 같은 스텝은 거절한다.
 */
export function verifyCode(params: {
  secret: string;
  code: string;
  lastStep?: number | null;
  atMs?: number;
}): { ok: boolean; step?: number; reason?: "format" | "mismatch" | "reused" } {
  const code = String(params.code ?? "").replace(/\D/g, "");
  if (code.length !== TOTP_DIGITS) return { ok: false, reason: "format" };

  const now = currentStep(params.atMs ?? Date.now());
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = now + offset;
    let expected: string;
    try {
      expected = codeForStep(params.secret, step);
    } catch {
      return { ok: false, reason: "format" };
    }
    // 시간 일정 비교 — 자릿수별 일치로 코드를 좁혀 나가는 것을 막는다
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(code, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (params.lastStep !== null && params.lastStep !== undefined && step <= params.lastStep) {
        return { ok: false, reason: "reused" };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: "mismatch" };
}

/**
 * 인증 앱이 읽는 otpauth URI.
 *
 * 라벨에 사이트 이름과 계정을 넣는다 — 앱에 항목이 여러 개일 때 어느
 * 사이트인지 구분되어야 한다.
 */
export function otpauthUri(params: { secret: string; account: string; issuer: string }): string {
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.account);
  const q = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${issuer}:${account}?${q.toString()}`;
}

/**
 * 복구 코드 생성.
 *
 * 10자리 base32(50비트) × 10개. 손으로 옮겨 적을 수 있게 짧게 하되,
 * 추측이 불가능한 엔트로피를 남긴다. 보기 좋게 5자리씩 나눈다.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** 저장·비교용 정규화 — 하이픈과 대소문자를 무시한다 */
export function normalizeRecoveryCode(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}
