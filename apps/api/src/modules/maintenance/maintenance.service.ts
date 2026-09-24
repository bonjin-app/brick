import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { lt } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { sessions, cacheEntries } from "@brick/database";
import type { QueueProvider } from "@brick/core";
import { DB, QUEUE } from "../../runtime.module.js";
import { AuditService } from "../audit/audit.service.js";
import { SearchService } from "../search/search.service.js";
import { EmailVerifyService } from "../members/email-verify.service.js";
import { PasswordResetService } from "../auth/password-reset.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

/**
 * 주기 정리 작업.
 *
 * 만료 세션·캐시·토큰·로그를 치우지 않으면 테이블이 무한히 커진다.
 * Redis가 없는 설계(ADR-3)의 대가이므로 코어가 책임진다 — 별도 cron이 필요 없다.
 *
 * **여기는 일정만 갖는다. 무엇을 얼마나 보관할지는 각 서비스가 안다.**
 * 예전에는 이 파일이 보관 정책을 직접 다시 구현했고, 그 탓에 둘이 갈라졌다:
 * audit_logs 는 여기와 AuditService 양쪽에 180일이 적혀 있었고(한쪽만 고치면
 * 조용히 어긋난다), 정작 **search_logs 와 email_verifications 는 아무도 지우지
 * 않았다**. 각 서비스에 정리 함수가 있었는데 — 주석에는 "유지보수 작업이
 * 부른다", "스케줄러가 부른다" 라고 적혀 있었는데 — 부르는 곳이 없었다.
 *
 * 400일 된 행을 심고 띄워 봤더니 검색어("희귀질환 치료")와 이메일 인증 토큰이
 * 그대로 남았다. 검색어는 스스로 "질병·법률 문의라 민감하다"고 적어 둔
 * 데이터이고, 보관 기간은 문서에만 있었다.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Maintenance");
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(QUEUE) private readonly queue: QueueProvider,
    private readonly audit: AuditService,
    private readonly search: SearchService,
    private readonly emailVerify: EmailVerifyService,
    private readonly passwordReset: PasswordResetService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // 부팅 직후 1회 + 이후 1시간 주기
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), 3600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    /*
     * 하나가 실패해도 나머지는 돈다.
     *
     * 전에는 전체가 try 하나였다 — 첫 삭제가 걸리면(잠금 경합, 마이그레이션
     * 중인 테이블) 그 뒤 전부가 조용히 건너뛰어졌고, 로그에는 줄 하나만 남았다.
     */
    const jobs: Array<[string, () => Promise<unknown>]> = [
      // 아래 둘은 주인이 되는 서비스가 없다 — 여기서 직접 지운다.
      ["sessions", () => this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()))],
      ["cache", () => this.db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, new Date()))],
      // 나머지는 주인에게 맡긴다 — 보관 기간은 그 데이터를 아는 쪽이 정한다.
      ["password-resets", () => this.passwordReset.prune()],
      ["audit-logs", () => this.audit.prune()],
      ["search-logs", () => this.search.prune()],
      ["email-verifications", () => this.emailVerify.purgeExpired()],
      // 알림은 댓글·주문·재입고마다 한 줄씩 쌓인다 — 치우지 않으면 본문보다 커진다
      ["notifications", () => this.notifications.prune()],
      // 끝난 큐 작업 — 정기 작업만으로 하루 수백 행이 쌓였는데 아무도 지우지 않았다
      ["queue-jobs", () => this.queue.prune()],
    ];
    for (const [name, run] of jobs) {
      try {
        await run();
      } catch (err) {
        this.logger.warn(`sweep(${name}) failed: ${String(err)}`);
      }
    }
  }
}
