import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { auditLogs } from "@brick/database";
import type { SessionUser } from "@brick/shared";
import { SITE_TZ } from "@brick/core";
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
 * 날짜 경계를 자르는 시간대.
 *
 * 판매 리포트와 같은 값을 쓴다(ADR-51) — UTC 로 자르면 한국에서 오전 9시
 * 이전 기록이 전날로 밀려서, 관리자가 "어제 무슨 일이 있었나"를 볼 때
 * 엉뚱한 범위를 본다.
 */


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

  /**
   * 목록.
   *
   * 행위자와 기간으로 좁힐 수 있어야 한다 — **"누가 무엇을 했나"를
   * 조사하는 것이 감사 로그의 용도**인데, 동작별 필터만으로는 사람을
   * 따라갈 수 없다. 사고가 났을 때 수만 건을 넘겨보게 된다.
   */
  async list(
    opts: {
      page?: number;
      action?: string;
      targetType?: string;
      /** 이메일 부분 일치 — 정확한 주소를 몰라도 찾을 수 있어야 한다 */
      actor?: string;
      /** YYYY-MM-DD (사이트 시간대). 이 날 0시부터 */
      from?: string;
      /** YYYY-MM-DD. **이 날 끝까지 포함** — 오늘까지 조회했는데 오늘이
       *  빠지면 조용히 놓친다 */
      to?: string;
    } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const size = 50;
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;
    const filters = [
      ...(opts.action ? [eq(auditLogs.action, opts.action)] : []),
      ...(opts.targetType ? [eq(auditLogs.targetType, opts.targetType)] : []),
      // ILIKE 는 대소문자를 무시한다. % 를 이스케이프해 와일드카드 주입을 막는다
      ...(opts.actor
        ? [sql`${auditLogs.actorEmail} ILIKE ${`%${opts.actor.replace(/[%_\\]/g, "\\$&")}%`}`]
        : []),
      ...(opts.from && dateShape.test(opts.from)
        ? [sql`${auditLogs.createdAt} >= (${opts.from}::date::timestamp AT TIME ZONE ${SITE_TZ})`]
        : []),
      ...(opts.to && dateShape.test(opts.to)
        ? [sql`${auditLogs.createdAt} < ((${opts.to}::date + 1)::timestamp AT TIME ZONE ${SITE_TZ})`]
        : []),
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
    return {
      items,
      total: Number(total?.value ?? 0),
      page,
      pageSize: size,
      timezone: SITE_TZ,
    };
  }

  /** 화면의 필터 목록을 채우는 데 쓴다 — 어떤 동작이 기록되는지 미리 알 수 없다 */
  async actions(): Promise<Array<{ action: string; count: number }>> {
    const { rows } = await this.db.execute(sql`
      SELECT action, count(*) AS n FROM audit_logs
      GROUP BY action ORDER BY n DESC LIMIT 100
    `);
    return rows.map((r: Record<string, unknown>) => ({
      action: String(r.action),
      count: Number(r.n),
    }));
  }

  /** 보관 기간이 지난 기록 정리 (MaintenanceService가 호출) */
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
    await this.db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff));
  }
}
