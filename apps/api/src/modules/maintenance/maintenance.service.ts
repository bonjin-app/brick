import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { lt } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { sessions, cacheEntries, passwordResets, auditLogs } from "@brick/database";
import { DB } from "../../runtime.module.js";

/** 감사 로그 보관 기간 */
const AUDIT_RETENTION_DAYS = 180;

/**
 * 주기 정리 작업.
 *
 * 만료 세션·캐시·재설정 토큰을 치우지 않으면 테이블이 무한히 커진다.
 * Redis가 없는 설계(ADR-3)의 대가이므로 코어가 책임진다 — 별도 cron이 필요 없다.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Maintenance");
  private timer?: NodeJS.Timeout;

  constructor(@Inject(DB) private readonly db: BrickDb) {}

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
    try {
      const now = new Date();
      await this.db.delete(sessions).where(lt(sessions.expiresAt, now));
      await this.db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, now));
      await this.db.delete(passwordResets).where(lt(passwordResets.expiresAt, now));
      await this.db.delete(auditLogs).where(
        lt(auditLogs.createdAt, new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000)),
      );
    } catch (err) {
      this.logger.warn(`sweep failed: ${String(err)}`);
    }
  }
}
