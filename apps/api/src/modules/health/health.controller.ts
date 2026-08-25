import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";

/**
 * 헬스체크.
 *  - /healthz  : 프로세스 생존 (liveness) — DB를 건드리지 않는다
 *  - /readyz   : 트래픽 수용 가능 (readiness) — DB 연결 확인
 * Docker healthcheck / k8s probe가 사용한다.
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  @Get("healthz")
  live() {
    return { status: "ok", uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Get("readyz")
  async ready() {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch (err) {
      throw new ServiceUnavailableException({ status: "unavailable", database: String(err) });
    }
    return { status: "ok", database: "ok" };
  }
}
