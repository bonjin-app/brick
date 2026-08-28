/**
 * 통합검색 · 검색 로그 · 인기 검색어.
 *
 * ── 왜 다시 만들었나 ─────────────────────────────────
 *
 * 기존 `/api/search` 는 **페이지만** 찾았다. 게시글도 상품도 검색되지 않았다 —
 * 그누보드에서 검색은 게시판 통합검색이 기본인데, 이쪽은 검색창에 뭘 넣어도
 * 정적 페이지만 나왔다.
 *
 * 그리고 `total` 이 그 페이지의 행 수였다. 500건이 맞아도 20을 돌려주므로
 * **페이지네이션이 동작하지 않았다** — 화면은 항상 1페이지뿐이라고 판단한다.
 *
 * 코어가 게시글·상품 테이블을 알면 안 되므로 `registerSearchSource` 로
 * 받는다 (사이트맵과 같은 방식 — ADR-40).
 *
 * ── 검색 로그 ────────────────────────────────────────
 *
 * **무엇을 찾다가 못 찾고 나갔는지가 가장 값진 데이터다.** 결과 0건은
 * 쇼핑몰이면 팔 수 있었는데 못 판 것이고, 사이트면 안내가 없어서 문의로
 * 이어지는 것이다.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { pages } from "@brick/database";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import type { SearchHit, SearchParams } from "@brick/core";

/**
 * 최소 검색어 길이.
 *
 * 한 글자는 거의 모든 문서에 걸리므로 결과가 무의미하고, 부하만 크다.
 * 한글 한 글자로 의미 있는 검색이 되는 경우가 없다.
 */
export const MIN_QUERY_LENGTH = 2;

export const SEARCH_PAGE_SIZE = 20;

/** 날짜 경계를 자르는 시간대 — 리포트와 같은 값을 쓴다 (ADR-51) */
const SEARCH_TZ = process.env.BRICK_TIMEZONE?.trim() || "Asia/Seoul";

export interface SearchGroup {
  code: string;
  label: string;
  total: number;
  items: SearchHit[];
}

/**
 * 검색어 정규화.
 *
 * 집계의 기준이다. 이걸 하지 않으면 "  아이폰  케이스 " 와 "아이폰 케이스" 가
 * 다른 검색어로 세어져 **인기 검색어가 흩어진다.**
 */
export function normalizeQuery(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, 200);
}

@Injectable()
export class SearchService {
  private readonly log = new Logger("Search");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly plugins: PluginLoaderService,
  ) {}

  private hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHash("sha256").update(`search:${ip}`).digest("hex").slice(0, 64);
  }

  /** 화면의 분류 탭을 만드는 데 쓴다 — 어떤 플러그인이 켜져 있는지 미리 알 수 없다 */
  scopes(): Array<{ code: string; label: string }> {
    return [
      { code: "pages", label: "페이지" },
      ...[...this.plugins.searchSources]
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map((s) => ({ code: s.code, label: s.label })),
    ];
  }

  /**
   * 통합검색.
   *
   * 분류별로 개수와 결과를 함께 준다 — 화면이 탭에 건수를 표시할 수 있어야
   * 손님이 "게시글에 3건 있다"를 보고 옮겨간다.
   *
   * 한 공급자가 실패해도 **나머지는 보여준다.** 플러그인 하나의 SQL 오류로
   * 검색 전체가 죽으면 사이트가 고장난 것처럼 보인다.
   */
  async search(params: {
    raw: string;
    scope?: string;
    page?: number;
    viewer: { id: string; role: string } | null;
    ip?: string;
    /** false 면 기록하지 않는다 (관리자 화면의 미리보기 등) */
    log?: boolean;
  }): Promise<{
    query: string;
    normalized: string;
    /** 치환 규칙이 적용되었으면 원래 검색어 */
    replacedFrom: string | null;
    scope: string | null;
    page: number;
    pageSize: number;
    total: number;
    groups: SearchGroup[];
    tooShort: boolean;
  }> {
    const raw = String(params.raw ?? "").trim();
    let normalized = normalizeQuery(raw);
    const page = Math.max(1, Math.floor(Number(params.page ?? 1)));
    const scope = params.scope ? String(params.scope) : null;

    if (normalized.length < MIN_QUERY_LENGTH) {
      return {
        query: raw, normalized, replacedFrom: null, scope, page,
        pageSize: SEARCH_PAGE_SIZE, total: 0, groups: [], tooShort: true,
      };
    }

    // 치환 규칙 — "아이폰15" 로 찾는데 상품명이 "iPhone 15" 면 0건이다
    let replacedFrom: string | null = null;
    const replacement = await this.replacementFor(normalized);
    if (replacement) {
      replacedFrom = normalized;
      normalized = replacement;
    }

    const searchParams: SearchParams = { query: normalized, viewer: params.viewer };
    const offset = (page - 1) * SEARCH_PAGE_SIZE;

    const wanted = (code: string) => scope === null || scope === code;
    const groups: SearchGroup[] = [];

    if (wanted("pages")) {
      const [total, items] = await Promise.all([
        this.countPages(searchParams),
        this.searchPages({ ...searchParams, offset, limit: SEARCH_PAGE_SIZE }),
      ]);
      groups.push({ code: "pages", label: "페이지", total, items });
    }

    const sources = [...this.plugins.searchSources]
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .filter((s) => wanted(s.code));

    for (const source of sources) {
      try {
        const [total, items] = await Promise.all([
          source.count(searchParams),
          source.search({ ...searchParams, offset, limit: SEARCH_PAGE_SIZE }),
        ]);
        groups.push({ code: source.code, label: source.label, total: Number(total), items });
      } catch (err) {
        // 하나가 죽어도 나머지는 보여준다
        this.log.warn(`검색 공급자 실패 (${source.plugin}/${source.code}): ${String(err)}`);
      }
    }

    const total = groups.reduce((sum, g) => sum + g.total, 0);

    if (params.log !== false) {
      // 기록 실패로 검색이 실패하면 안 된다
      await this.record({
        normalized, raw, total, scope,
        userId: params.viewer?.id ?? null, ip: params.ip,
      }).catch((err) => this.log.warn(`검색 로그 기록 실패: ${String(err)}`));
    }

    return {
      query: raw, normalized, replacedFrom, scope, page,
      pageSize: SEARCH_PAGE_SIZE, total, groups, tooShort: false,
    };
  }

  private async replacementFor(normalized: string): Promise<string | null> {
    const { rows } = await this.db.execute(sql`
      SELECT replacement FROM search_rules
      WHERE term = ${normalized} AND kind = 'replace' LIMIT 1
    `);
    const value = rows[0]?.replacement;
    if (!value) return null;
    const next = normalizeQuery(String(value));
    // 자기 자신으로의 치환은 무한 루프의 씨앗이다 (지금은 1회만 적용하므로
    // 루프는 없지만, 규칙이 무의미하므로 무시한다)
    return next && next !== normalized ? next : null;
  }

  // ── 페이지 검색 (코어가 아는 유일한 대상) ──────────

  /**
   * ILIKE 로 찾는다.
   *
   * `%` `_` `\` 를 이스케이프해야 한다 — 안 하면 손님이 `%` 를 검색하면
   * 전체가 나오고, 그것은 검색이 아니라 전체 목록 유출이다.
   */
  private likePattern(query: string): string {
    return `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  }

  private async countPages(p: SearchParams): Promise<number> {
    const like = this.likePattern(p.query);
    const rows = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(pages)
      .where(
        and(
          eq(pages.status, "published"),
          sql`(${pages.title} ILIKE ${like} OR ${pages.plainText} ILIKE ${like})`,
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  private async searchPages(
    p: SearchParams & { offset: number; limit: number },
  ): Promise<SearchHit[]> {
    const like = this.likePattern(p.query);
    const rows = await this.db
      .select({
        slug: pages.slug,
        title: pages.title,
        plainText: pages.plainText,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(
        and(
          eq(pages.status, "published"),
          sql`(${pages.title} ILIKE ${like} OR ${pages.plainText} ILIKE ${like})`,
        ),
      )
      // 정렬을 고정한다 — 안 하면 페이지를 넘길 때 같은 항목이 두 번 나온다
      .orderBy(sql`${pages.updatedAt} DESC, ${pages.id} DESC`)
      .limit(p.limit)
      .offset(p.offset);

    return rows.map((r) => ({
      path: `/${r.slug}`,
      title: r.title,
      excerpt: excerpt(r.plainText ?? "", p.query),
      date: r.updatedAt,
    }));
  }

  // ── 로그 ──────────────────────────────────────────

  private async record(params: {
    normalized: string;
    raw: string;
    total: number;
    scope: string | null;
    userId: string | null;
    ip?: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO search_logs (id, query, raw_query, result_count, scope, user_id, ip_hash)
      VALUES (${uuidv7()}, ${params.normalized}, ${params.raw.slice(0, 200)},
              ${params.total}, ${params.scope}, ${params.userId}::uuid,
              ${this.hashIp(params.ip)})
    `);
  }

  /**
   * 인기 검색어.
   *
   * 차단 규칙에 걸린 것은 제외한다 — 인기 검색어는 화면에 노출되므로
   * 경쟁사명·욕설을 방치하면 사이트가 이상해진다.
   *
   * **같은 사람의 연속 입력을 한 번으로 센다.** IP 해시별로 중복을 제거하지
   * 않으면 한 사람이 열 번 검색한 것이 인기 1위가 된다.
   */
  async popular(params: { days?: number; limit?: number }): Promise<
    Array<{ query: string; count: number; emptyRatio: number }>
  > {
    const days = Math.min(365, Math.max(1, Math.floor(Number(params.days ?? 7))));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(params.limit ?? 10))));

    const { rows } = await this.db.execute(sql`
      WITH deduped AS (
        -- 같은 (검색어, 사람) 조합을 하루 단위로 한 번만 센다
        SELECT DISTINCT
          l.query,
          coalesce(l.user_id::text, l.ip_hash, l.id::text) AS who,
          (l.created_at AT TIME ZONE ${SEARCH_TZ})::date AS day,
          l.result_count
        FROM search_logs l
        WHERE l.created_at >= now() - (${days} || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM search_rules r WHERE r.term = l.query AND r.kind = 'block'
          )
      )
      SELECT query, count(*) AS n,
             -- 이 검색어가 얼마나 자주 빈손으로 끝나는가.
             -- 인기 있는데 결과가 없는 것이 가장 먼저 손봐야 할 것이다.
             round(
               (count(*) FILTER (WHERE result_count = 0))::numeric * 100 / count(*), 1
             ) AS empty_pct
      FROM deduped
      GROUP BY query
      ORDER BY n DESC, query
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      query: String(r.query),
      count: Number(r.n),
      emptyRatio: Number(r.empty_pct),
    }));
  }

  /**
   * 결과 0건 검색어.
   *
   * **이 목록이 이 기능의 핵심이다.** 손님이 찾았는데 없는 것 —
   * 쇼핑몰이면 팔 수 있었던 것이고, 사이트면 안내가 빠진 것이다.
   */
  async noResults(params: { days?: number; limit?: number }): Promise<
    Array<{ query: string; count: number; lastAt: Date }>
  > {
    const days = Math.min(365, Math.max(1, Math.floor(Number(params.days ?? 30))));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit ?? 50))));

    const { rows } = await this.db.execute(sql`
      SELECT query, count(*) AS n, max(created_at) AS last_at
      FROM search_logs
      WHERE result_count = 0
        AND created_at >= now() - (${days} || ' days')::interval
      GROUP BY query
      ORDER BY n DESC, last_at DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      query: String(r.query),
      count: Number(r.n),
      lastAt: r.last_at as Date,
    }));
  }

  // ── 규칙 ──────────────────────────────────────────

  async listRules(): Promise<
    Array<{ id: string; term: string; kind: string; replacement: string | null; note: string | null }>
  > {
    const { rows } = await this.db.execute(sql`
      SELECT id, term, kind, replacement, note FROM search_rules ORDER BY kind, term
    `);
    return rows.map((r) => ({
      id: String(r.id),
      term: String(r.term),
      kind: String(r.kind),
      replacement: r.replacement ? String(r.replacement) : null,
      note: r.note ? String(r.note) : null,
    }));
  }

  async upsertRule(params: {
    term: string;
    kind: string;
    replacement?: string;
    note?: string;
  }): Promise<{ id: string }> {
    const term = normalizeQuery(params.term);
    if (!term) throw new Error("검색어를 입력해주세요.");
    const kind = String(params.kind);
    if (kind !== "replace" && kind !== "block") {
      throw new Error("종류는 replace 또는 block 이어야 합니다.");
    }
    const replacement = kind === "replace" ? normalizeQuery(params.replacement ?? "") : null;
    if (kind === "replace" && !replacement) {
      throw new Error("바꿀 검색어를 입력해주세요.");
    }
    if (kind === "replace" && replacement === term) {
      throw new Error("같은 검색어로 바꿀 수 없습니다.");
    }

    const id = uuidv7();
    const { rows } = await this.db.execute(sql`
      INSERT INTO search_rules (id, term, kind, replacement, note)
      VALUES (${id}, ${term}, ${kind}, ${replacement}, ${params.note ?? null})
      ON CONFLICT (term) DO UPDATE
        SET kind = ${kind}, replacement = ${replacement}, note = ${params.note ?? null}
      RETURNING id
    `);
    return { id: String(rows[0]?.id ?? id) };
  }

  async deleteRule(id: string): Promise<{ ok: true }> {
    await this.db.execute(sql`DELETE FROM search_rules WHERE id = ${id}::uuid`);
    return { ok: true };
  }

  /**
   * 오래된 로그 정리 — 유지보수 작업이 부른다.
   *
   * 검색어는 그 자체로 민감할 수 있다(질병·법률·재정 문의). 집계 목적이
   * 끝나면 보관할 이유가 없다.
   */
  async prune(days = 180): Promise<{ deleted: number }> {
    const { rows } = await this.db.execute(sql`
      DELETE FROM search_logs WHERE created_at < now() - (${days} || ' days')::interval
      RETURNING id
    `);
    return { deleted: rows.length };
  }
}

/** 검색어 주변을 잘라 발췌문을 만든다 */
export function excerpt(text: string, query: string): string {
  const body = String(text ?? "");
  if (!body) return "";
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, 150);
  const start = Math.max(0, idx - 60);
  return (
    (start > 0 ? "…" : "") +
    body.slice(start, start + 150) +
    (start + 150 < body.length ? "…" : "")
  );
}
