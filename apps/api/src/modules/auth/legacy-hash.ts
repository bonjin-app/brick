import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 다른 CMS에서 옮겨온 비밀번호 해시 검증.
 *
 * **왜 필요한가.** 그누보드에서 옮겨온 뒤 회원 전원이 비밀번호를 다시 만들어야
 * 하면 상당수가 돌아오지 않는다. 이전 도구의 성패가 여기 걸려 있다.
 * 그래서 원본 해시를 그대로 보존하고, 첫 로그인에 성공하면 argon2 로 다시
 * 해시한다(자동 승급). 회원은 아무것도 하지 않는다.
 *
 * **저장 형식.** `legacy:<종류>:<원본 해시>`
 * 접두어를 붙이는 이유: argon2.verify 는 형식이 다른 값에 예외를 던지므로,
 * 저장된 값만 보고 어떤 방식으로 검증할지 알아야 한다.
 *
 * **왜 승급하는가.** 그누보드의 MD5 는 지금 기준으로 안전하지 않다. 유출되면
 * 사실상 평문이다. 그대로 두면 이전한 사이트는 영구히 약한 해시를 갖는다.
 * 로그인 시점에는 평문 비밀번호가 손에 있으므로 그때가 유일한 승급 기회다.
 */

export type LegacyKind = "bcrypt" | "gnu-md5" | "sha256";

const PREFIX = "legacy:";

export function isLegacyHash(stored: string): boolean {
  return String(stored ?? "").startsWith(PREFIX);
}

/** `legacy:bcrypt:$2y$...` 를 분해한다 */
export function parseLegacyHash(stored: string): { kind: LegacyKind; hash: string } | null {
  const s = String(stored ?? "");
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const i = rest.indexOf(":");
  if (i < 0) return null;
  const kind = rest.slice(0, i);
  const hash = rest.slice(i + 1);
  if (kind !== "bcrypt" && kind !== "gnu-md5" && kind !== "sha256") return null;
  if (!hash) return null;
  return { kind, hash };
}

/**
 * 레거시 해시로 비밀번호를 검증한다.
 *
 * 실패는 조용히 false 다. 형식이 깨진 값에 예외를 던지면 로그인 경로가
 * 500 을 내고, 그건 공격자에게 "이 계정은 특별하다"를 알려준다.
 */
export async function verifyLegacyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parseLegacyHash(stored);
  if (!parsed || !password) return false;

  try {
    switch (parsed.kind) {
      case "bcrypt":
        // PHP 의 $2y$ 는 $2b$ 와 알고리즘이 같다. bcryptjs 는 둘 다 받는다.
        return await bcrypt.compare(password, parsed.hash);

      case "gnu-md5":
        // 그누보드 구형: md5(비밀번호). 소금이 없다 — 그래서 승급이 중요하다.
        return safeEqualHex(createHash("md5").update(password).digest("hex"), parsed.hash);

      case "sha256":
        return safeEqualHex(createHash("sha256").update(password).digest("hex"), parsed.hash);
    }
  } catch {
    return false;
  }
}

/**
 * 16진 문자열을 상수 시간으로 비교한다.
 *
 * `===` 로 비교하면 앞자리부터 다른 위치에 따라 시간이 달라진다.
 * 해시 비교에서 타이밍 차이는 실용적인 공격이 되기 어렵지만,
 * 비교 하나를 안전하게 쓰는 비용이 없으므로 쓴다.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
