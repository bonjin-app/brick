import { ForbiddenException, Injectable } from "@nestjs/common";
import { AuthService, SESSION_COOKIE } from "./auth.service.js";

/**
 * 위험 작업 재인증 (sudo 모드).
 *
 * 회원 개인정보 열람, 대량 발송처럼 **훔친 세션만으로 큰 피해가 나는**
 * 작업은 비밀번호를 한 번 더 확인한 뒤 짧은 시간(10분)만 허용한다.
 * 세션 토큰이 탈취돼도 비밀번호까지는 없는 공격자를 여기서 막는다.
 *
 * 승격은 **세션(토큰 해시) 단위**다 — 사용자 단위로 하면 한 기기에서
 * 재인증한 것이 탈취된 다른 세션까지 열어 준다.
 *
 * 메모리에만 둔다: 재시작하면 사라지지만, 사라져서 생기는 일은 "비밀번호를
 * 한 번 더 묻는 것"뿐이다. 유출 걱정이 있는 것을 DB 에 늘리지 않는다.
 */
@Injectable()
export class ReauthService {
  private static readonly TTL_MS = 10 * 60_000;
  private readonly elevated = new Map<string, number>();

  constructor(private readonly auth: AuthService) {}

  /** 요청의 세션 토큰 해시 — 위험 작업 가드가 쓴다 */
  tokenHashOf(req: {
    cookies?: Record<string, string>;
    headers: { authorization?: string };
  }): string {
    const token = req.cookies?.[SESSION_COOKIE];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    return this.auth.tokenHash(token ?? bearer ?? "");
  }

  /** 위험 작업 앞에서 부르는 요청 단위 헬퍼 */
  assertRequest(req: {
    cookies?: Record<string, string>;
    headers: { authorization?: string };
  }): void {
    this.assertElevated(this.tokenHashOf(req));
  }

  grant(tokenHash: string): { expiresAt: string } {
    const until = Date.now() + ReauthService.TTL_MS;
    this.elevated.set(tokenHash, until);
    // 만료 항목이 쌓이지 않게 지나가며 청소한다 (관리자 수는 적다)
    for (const [k, v] of this.elevated) {
      if (v < Date.now()) this.elevated.delete(k);
    }
    return { expiresAt: new Date(until).toISOString() };
  }

  isElevated(tokenHash: string): boolean {
    const until = this.elevated.get(tokenHash);
    if (!until) return false;
    if (until < Date.now()) {
      this.elevated.delete(tokenHash);
      return false;
    }
    return true;
  }

  /** 위험 작업 앞에서 부른다. 화면은 code 를 보고 재인증 창을 띄운다 */
  assertElevated(tokenHash: string): void {
    if (!this.isElevated(tokenHash)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: "Forbidden",
        code: "reauth_required",
        message: "민감한 작업입니다. 비밀번호를 다시 확인해주세요.",
      });
    }
  }

  revoke(tokenHash: string): void {
    this.elevated.delete(tokenHash);
  }
}
