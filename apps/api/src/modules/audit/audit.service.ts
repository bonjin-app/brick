import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { auditLogs } from "@brick/database";
import type { SessionUser } from "@brick/shared";
import { DB } from "../../runtime.module.js";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: string;
  actor?: SessionUser | null;
  ip?: string;
}

/** 보관 기간 — 이보다 오래된 기록은 정리 작업이 지운다 */
const RETENTION_DAYS = 180;

/**
 * 감사 로그.
 *
 * 원칙:
 *  - **기록 실패가 주 동작을 막지 않는다.** 로그를 못 남겨도 페이지 저장은 성공해야 한다.
 *  - 본문 같은 큰 데이터는 담지 않는다. "무엇에 대한 어떤 동작"과 짧은 요약만.
 *  - 비밀번호·토큰은 절대 담지 않는다.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger("Audit");

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        id: uuidv7(),
        actorId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        action: entry.action.slice(0, 80),
        targetType: entry.targetType?.slice(0, 40) ?? null,
        targetId: entry.targetId?.slice(0, 100) ?? null,
        summary: entry.summary?.slice(0, 500) ?? null,
        ip: entry.ip?.slice(0, 64) ?? null,
      });
    } catch (err) {
      // 감사 로그 실패가 실제 작업을 되돌리게 하지 않는다
      this.logger.warn(`감사 로그 기록 실패 (${entry.action}): ${String(err)}`);
    }
  }

  /** 요청에서 행위자와 IP를 뽑아 기록하는 편의 메서드 */
  async fromRequest(
    req: FastifyRequest & { user?: SessionUser },
    entry: Omit<AuditEntry, "actor" | "ip">,
  ): Promise<void> {
    await this.record({ ...entry, actor: req.user ?? null, ip: req.ip });
  }

  async list(opts: { page?: number; action?: string; targetType?: string } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const size = 50;
    const filters = [
      ...(opts.action ? [eq(auditLogs.action, opts.action)] : []),
      ...(opts.targetType ? [eq(auditLogs.targetType, opts.targetType)] : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(size)
        .offset((page - 1) * size),
      this.db.select({ value: sql<number>`count(*)` }).from(auditLogs).where(where),
    ]);
    return { items, total: Number(total?.value ?? 0), page, pageSize: size };
  }

  /** 보관 기간이 지난 기록 정리 (MaintenanceService가 호출) */
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
    await this.db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff));
  }
}
