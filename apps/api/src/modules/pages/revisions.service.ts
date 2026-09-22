import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { pageRevisions, users } from "@brick/database";
import { DB } from "../../runtime.module.js";

/**
 * 한 페이지에 남기는 판의 수.
 *
 * 무제한으로 쌓으면 블록 JSON 이 통째로 복사되어 테이블이 본문보다 커진다
 * (워드프레스가 이것으로 오래 욕을 먹었다). 서른 판이면 "어제 뭘 지웠더라" 에는
 * 충분하고, 그보다 오래된 것을 찾는 일은 백업의 몫이다.
 */
const KEEP = 30;

export interface RevisionInput {
  pageId: string;
  title: string;
  slug: string;
  blocks: unknown;
  seo: unknown;
  status: string;
  authorId?: string | null;
  note?: string;
}

/**
 * 페이지 이전 버전.
 *
 * **저장할 때마다 그때 저장한 내용을 한 판 남긴다.** 되돌리기는 옛 판을 다시
 * 저장하는 것이므로 되돌린 것 자체도 판이 된다 — 되돌리기를 되돌릴 수 있다.
 */
@Injectable()
export class RevisionsService {
  private readonly logger = new Logger("Revisions");

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  /**
   * 판을 남긴다. **절대 던지지 않는다** — 기록이 실패했다고 저장이 실패하면
   * 운영자는 쓴 글을 잃는다(감사 로그와 같은 원칙).
   *
   * 내용이 지난 판과 같으면 남기지 않는다. 저장을 두 번 눌렀다고 판이 두 개
   * 생기면 목록이 금세 의미를 잃는다 — 무엇이 언제 바뀌었는지를 보러 오는 곳이다.
   */
  async snapshot(input: RevisionInput): Promise<number | null> {
    try {
      const [last] = await this.db
        .select({
          revNo: pageRevisions.revNo,
          title: pageRevisions.title,
          slug: pageRevisions.slug,
          blocks: pageRevisions.blocks,
          seo: pageRevisions.seo,
        })
        .from(pageRevisions)
        .where(eq(pageRevisions.pageId, input.pageId))
        .orderBy(desc(pageRevisions.revNo))
        .limit(1);

      if (last && this.same(last, input)) return null;

      const revNo = (last?.revNo ?? 0) + 1;
      await this.db.insert(pageRevisions).values({
        id: uuidv7(),
        pageId: input.pageId,
        revNo,
        title: input.title,
        slug: input.slug,
        blocks: (input.blocks ?? []) as never,
        seo: (input.seo ?? {}) as never,
        status: input.status,
        authorId: input.authorId ?? null,
        note: (input.note ?? "").slice(0, 200),
      });
      await this.prune(input.pageId, revNo);
      return revNo;
    } catch (err) {
      this.logger.warn(`판 기록 실패 (page=${input.pageId}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 내용이 같은가 — 공개 상태는 내용이 아니므로 보지 않는다 */
  private same(
    last: { title: string; slug: string; blocks: unknown; seo: unknown },
    next: RevisionInput,
  ): boolean {
    return (
      last.title === next.title &&
      last.slug === next.slug &&
      JSON.stringify(last.blocks ?? []) === JSON.stringify(next.blocks ?? []) &&
      JSON.stringify(last.seo ?? {}) === JSON.stringify(next.seo ?? {})
    );
  }

  /** 오래된 판을 버린다 (KEEP 개만 남긴다) */
  private async prune(pageId: string, newestRevNo: number): Promise<void> {
    const cutoff = newestRevNo - KEEP;
    if (cutoff < 1) return;
    await this.db
      .delete(pageRevisions)
      .where(and(eq(pageRevisions.pageId, pageId), lte(pageRevisions.revNo, cutoff)));
  }

  /**
   * 판 목록 — 내용(blocks)은 빼고 준다.
   *
   * 목록 한 번에 서른 판의 블록 JSON 을 모두 실어 보내면 큰 페이지에서 몇 MB 가
   * 된다. 내용은 고른 판 하나만 읽는다.
   */
  async list(pageId: string) {
    const rows = await this.db
      .select({
        revNo: pageRevisions.revNo,
        title: pageRevisions.title,
        slug: pageRevisions.slug,
        status: pageRevisions.status,
        note: pageRevisions.note,
        createdAt: pageRevisions.createdAt,
        authorName: users.displayName,
        /** 블록 수 — 무엇이 얼마나 바뀌었는지의 가장 싼 단서 */
        blockCount: sql<number>`jsonb_array_length(coalesce(${pageRevisions.blocks}, '[]'::jsonb))`,
      })
      .from(pageRevisions)
      .leftJoin(users, eq(users.id, pageRevisions.authorId))
      .where(eq(pageRevisions.pageId, pageId))
      .orderBy(desc(pageRevisions.revNo))
      .limit(KEEP);
    return rows.map((r) => ({ ...r, blockCount: Number(r.blockCount ?? 0) }));
  }

  /** 판 하나 — 내용까지 */
  async get(pageId: string, revNo: number) {
    const [row] = await this.db
      .select()
      .from(pageRevisions)
      .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.revNo, revNo)))
      .limit(1);
    return row ?? null;
  }
}
