import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 비회원 글의 수정/삭제 비밀번호.
 *
 * 회원 비밀번호는 코어가 argon2로 처리하지만, 플러그인에 argon2 의존성을 추가하면
 * 배포본이 무거워지고 네이티브 빌드가 필요해진다(FTP 배포와 충돌).
 * 그래서 Node 내장 scrypt를 쓴다 — argon2보다 약하지만 게시글 비밀번호에는 충분하고,
 * 무엇보다 **평문으로 저장하지 않는다**(그누보드의 오래된 관행).
 */
const KEYLEN = 32;
const SCRYPT_COST = 16384; // N — 기본값. 게시글 비밀번호 용도로 적절한 수준

export function hashGuestPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyGuestPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024) return false;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    const actual = scryptSync(password, salt, expected.length, { N: cost });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
