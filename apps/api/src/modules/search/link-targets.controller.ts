/**
 * 연결 대상 목록.
 *
 * 메뉴·팝업·버튼에 링크를 넣을 때 **주소를 직접 타이핑하지 않게** 한다.
 * 지금까지 운영자는 만든 게시판의 slug 를 외워 `/board/free` 를 손으로 적어야
 * 했고, 오타가 나도 저장은 되고 눌러야 404 를 본다.
 *
 * 코어는 페이지만 알고, 게시판·상품 분류 주소는 플러그인이 안다 —
 * 사이트맵·검색과 같은 방식이다 (ADR-40, ADR-60).
 */
import { Controller, Get, Inject, Logger, Query, UseGuards } from "@nestjs/common";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { pages } from "@brick/database";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";

/** 그룹당 상한 — 게시판 50개, 분류 200개인 사이트에서 전부 내보내면 화면이 멈춘다 */
const PER_GROUP = 30;

@Controller("api")
export class LinkTargetsController {
  private readonly log = new Logger("LinkTargets");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly plugins: PluginLoaderService,
  ) {}

  /**
   * 관리자 전용.
   *
   * 임시 저장 페이지와 비공개 게시판까지 나오므로 공개하면 안 된다 —
   * 아직 안 만든 페이지의 존재와 주소가 새어 나간다.
   */
  @Get("admin/link-targets")
  @UseGuards(AdminGuard)
  async list(@Query("q") q?: string) {
    const query = String(q ?? "").trim().slice(0, 100);
    const groups: Array<{ code: string; label: string; items: unknown[] }> = [];

    // ── 코어가 아는 것: 페이지 ──
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db
      .select({ slug: pages.slug, title: pages.title, status: pages.status })
      .from(pages)
      .where(
        query
          ? or(ilike(pages.title, like), ilike(pages.slug, like))
          : undefined,
      )
      .orderBy(sql`${pages.status} = 'published' DESC, ${pages.title}`)
      .limit(PER_GROUP);

    groups.push({
      code: "pages",
      label: "페이지",
      items: rows.map((r) => ({
        // home 은 사이트 루트다 — /home 으로 링크하면 404 가 난다
        path: r.slug === "home" ? "/" : `/${r.slug}`,
        label: r.title,
        // 임시 저장 페이지도 보여준다. 곧 공개할 페이지를 미리 메뉴에 넣는 것이
        // 실제 순서이고, 숨기면 "왜 목록에 없나"로 헤맨다.
        hint: r.status === "published" ? null : "임시 저장 (아직 공개되지 않음)",
      })),
    });

    // ── 플러그인이 아는 것 ──
    const sources = [...this.plugins.linkTargets].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    for (const source of sources) {
      try {
        const items = await source.list({ query, limit: PER_GROUP });
        if (items.length) groups.push({ code: source.code, label: source.label, items });
      } catch (err) {
        // 하나가 죽어도 나머지는 보여준다 — 링크를 못 고르면 아무것도 연결할 수 없다
        this.log.warn(`연결 대상 공급자 실패 (${source.plugin}/${source.code}): ${String(err)}`);
      }
    }

    return {
      query,
      groups,
      /** 직접 입력도 계속 허용한다 — 외부 링크와 앵커는 목록에 있을 수 없다 */
      manualHint: "목록에 없으면 주소를 직접 입력할 수 있습니다 (외부 링크는 https:// 로 시작).",
    };
  }
}
