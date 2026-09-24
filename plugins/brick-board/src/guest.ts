import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * **비동기** scrypt 를 쓴다. 전에는 scryptSync 였는데, 한 번에 약 70ms 동안 Node 의 이벤트
 * 루프 전체가 멈췄다 — 틀린 비밀번호를 초당 열다섯 번만 보내면 게시판만이 아니라 사이트의
 * 모든 요청이 섰다(대입 20건이 들어오는 동안 상태 확인 요청이 1.6초 걸렸다). 비동기는
 * libuv 스레드풀에서 돌아 요청 처리를 막지 않는다. 쏟아지는 대입 자체는 호출하는 쪽의
 * checkGuestSecret 이 끊는다.
 */
function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/**
 * 비회원 글의 수정/삭제 비밀번호.
 *
 * 회원 비밀번호는 코어가 argon2로 처리하지만, 플러그인에 argon2 의존성을 추가하면
 * 배포본이 무거워지고 네이티브 빌드가 필요해진다(FTP 배포와 충돌).
 * 그래서 Node 내장 scrypt를 쓴다 — argon2보다 약하지만 게시글 비밀번호에는 충분하고,
 * 무엇보다 **평문으로 저장하지 않는다** — 오래된 PHP 게시판들의 관행이었다.
 */
const KEYLEN = 32;
const SCRYPT_COST = 16384; // N — 기본값. 게시글 비밀번호 용도로 적절한 수준

export async function hashGuestPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyGuestPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024) return false;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    const actual = await scryptAsync(password, salt, expected.length, { N: cost });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
