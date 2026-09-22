import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { pages } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { PageRenderService } from "./page-render.service.js";
import { AuditService } from "../audit/audit.service.js";

/**
 * 때가 되면 공개한다 — **30초**마다 본다.
 *
 * 정리 작업(MaintenanceService)에 얹지 않은 이유는 그쪽이 1시간 주기이기
 * 때문이다. 오후 2시 공개를 예약한 운영자에게 "2시에서 3시 사이" 는 예약이
 * 아니다. 30초면 사람이 보기에 약속한 시각이다.
 *
 * 워드프레스는 손님이 페이지를 열 때 예약을 확인한다(wp-cron). 그래서 방문이
 * 없는 새벽에는 예약이 늦고, 그 늦음이 유명하다. 우리는 서버가 스스로 본다.
 */
const EVERY_MS = 30_000;

@Injectable()
export class PublishSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("PublishScheduler");
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly renderer: PageRenderService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    /*
     * 부팅 직후에 한 번 본다.
     *
     * 서버가 꺼져 있는 동안 지나간 예약이 있을 수 있다(배포·재시작·장애).
     * 조건이 `<= now()` 이므로 늦게 깨어나도 밀린 것을 함께 연다 — 예약이
     * **영영 열리지 않는** 것이 가장 나쁘다.
     */
    void this.run();
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 때가 된 예약을 공개로 바꾼다. 바뀐 페이지 수를 돌려준다.
   *
   * 공개 여부를 보는 곳(렌더·검색·사이트맵)은 전부 `status = 'published'`
   * 하나를 보므로, 이 한 번의 UPDATE 가 곧 공개다.
   */
  async run(): Promise<number> {
    let due: Array<{ id: string; slug: string; title: string }> = [];
    try {
      /*
       * 시각 비교는 **DB 의 now()** 로 한다.
       *
       * 서버 프로세스의 시계와 DB 의 시계가 다를 수 있고(컨테이너·가상화에서
       * 실제로 어긋난다), 저장할 때 쓴 시계와 비교할 때 쓴 시계가 다르면
       * 예약이 이르거나 늦는다. 한쪽 시계만 본다.
       */
      due = (await this.db
        .update(pages)
        .set({ status: "published" })
        .where(and(eq(pages.status, "scheduled"), lte(pages.publishedAt, sql`now()`)))
        .returning({ id: pages.id, slug: pages.slug, title: pages.title })) as typeof due;
    } catch (err) {
      // 다음 주기에 다시 본다 — 조건이 시각이므로 한 번 걸러도 잃지 않는다
      this.logger.warn(`예약 발행 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    if (!due.length) return 0;

    // 캐시를 비우지 않으면 예약한 시각이 되어도 **손님은 옛 화면을 본다**
    await this.renderer.invalidate().catch(() => undefined);
    for (const page of due) {
      this.logger.log(`예약 발행: ${page.title} (/${page.slug})`);
      /*
       * 감사 로그에 남긴다. 행위자는 없다 — 사람이 아니라 시각이 연 것이다.
       * 그래도 기록은 있어야 한다: "누가 이 페이지를 공개했나" 에 답할 수
       * 있어야 하고, 예약이 실제로 돌았다는 증거가 여기 말고는 없다.
       */
      await this.audit.record({
        action: "page.publish.scheduled",
        targetType: "page",
        targetId: page.id,
        summary: `예약 발행: ${page.title} (/${page.slug})`,
      });
    }
    return due.length;
  }
}
