import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { msg } from "../../common/localized-error.js";

/**
 * 로그인한 회원의 **현재 비밀번호를 다시 확인**한다 — 비밀번호 변경 · 탈퇴 · 계정 보안(재인증 · 2단계 인증
 * 켜기/끄기)이 모두 이것을 쓴다.
 *
 * 이 확인은 "세션을 훔친 사람이 비밀번호까지는 모른다" 는 가정 위에 선다. 그런데 시도 횟수를 세지 않으면
 * 훔친 세션으로 현재 비밀번호를 **무제한 대입**할 수 있다 — 전에는 계정 보안 화면만 세고, 비밀번호 변경과
 * 탈퇴는 세지 않았다. 비밀번호 변경은 맞히는 순간 새 비밀번호로 바꿔 계정을 가져가는 길이었다.
 *
 * 회원마다 15분에 10번이고 **모든 경로가 한 몫을 나눠 쓴다**(경로마다 따로 세면 경로 수만큼 곱해진다).
 * 맞히면 다시 센다. 한도를 넘으면 429 — 맞는 비밀번호도 시험하지 않는다.
 */
@Injectable()
export class PasswordConfirmService {
  static readonly LIMIT = 10;
  static readonly WINDOW_MS = 15 * 60_000;

  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async confirm(userId: string, password: string): Promise<boolean> {
    const key = `reauth:${userId}`;
    const { allowed, retryAfterSeconds } = await this.rateLimit.consume(
      key, PasswordConfirmService.LIMIT, PasswordConfirmService.WINDOW_MS,
    );
    if (!allowed) {
      throw new HttpException(msg("err.tooManyAttemptsSec", { seconds: retryAfterSeconds }), HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = await this.auth.verifyPassword(userId, password);
    if (ok) await this.rateLimit.reset(key);
    return ok;
  }

  /**
   * 맞아야 넘어간다 — 틀리면 호출하는 쪽이 정한 오류를 던진다(경로마다 상태 코드와 문구가 다르다: 재인증은 401,
   * 비밀번호 변경·탈퇴는 400). 횟수 제한(429)은 여기서 던진다.
   */
  async assertConfirmed(userId: string, password: string, wrongPassword: () => Error): Promise<void> {
    if (!(await this.confirm(userId, password))) throw wrongPassword();
  }
}
