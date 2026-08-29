import { definePlugin } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { DEFAULT_SETTINGS, SiteError, type Db, type SiteSettings } from "./types.js";
import {
  countClick, countView, createPopup, livePopups, updatePopup,
} from "./popups.js";
import { localDayTag, pruneVisits, recordVisit, todayReferers, visitStats, visitorSalt } from "./visits.js";
import { POPUP_RESOURCE } from "./admin-resources.js";
import { registerSiteBlocks } from "./blocks.js";

/**
 * brick-site — 사이트 운영 플러그인.
 *
 * 그누보드에서 코어에 박혀 있던 두 기능을 담는다:
 *   - 접속자 집계 (오늘/어제/최고/전체)
 *   - 팝업 · 배너
 *
 * 둘 다 "있으면 좋지만 없어도 사이트는 돌아간다"는 성격이라 플러그인이 맞다.
 * 코어는 `page.viewed` 훅만 발행하고, 집계 방식은 이 플러그인이 정한다.
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as Db;

  const settings = async (): Promise<SiteSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.settings.get<Partial<SiteSettings>>("settings")) ?? {}),
  });

  const requireAdmin = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new SiteError(403, "권한이 없습니다.");
    }
  };

  /** 소금은 한 번만 만들고 프로세스 안에서 재사용한다 */
  let saltCache: string | null = null;
  const salt = async () => (saltCache ??= await visitorSalt(ctx.settings));

  /**
   * 하루 한 번만 정리한다.
   *
   * 방문마다 DELETE를 시도하면 소득 없는 스캔이 계속 붙는다. 날짜가 바뀐 것을
   * 처음 알아챈 요청에서만 돌린다. 프로세스가 재시작되면 표식이 사라지므로
   * 그 뒤 첫 방문에서 한 번 더 돌 뿐, 결과는 같다(멱등).
   */
  let prunedDay: string | null = null;

  // ════════════════════════════════════════════════════
  //  방문 집계
  // ════════════════════════════════════════════════════

  ctx.hooks.onAction("page.viewed", "brick-site", async (payload) => {
    const p = (payload ?? {}) as {
      path?: string;
      userId?: string | null;
      ip?: string;
      userAgent?: string;
      referer?: string;
    };
    const s = await settings();
    if (!s.countVisits) return;

    // 관리 화면 자신의 요청은 방문이 아니다.
    // 코어가 넘기는 path는 앞 슬래시가 없을 수 있어 양쪽을 모두 본다.
    const path = String(p.path ?? "").replace(/^\/+/, "");
    if (path === "admin" || path.startsWith("admin/")) return;

    // 검색 봇은 방문자로 세지 않는다 — 그러지 않으면 "오늘 방문자"가 봇 수가 된다
    const ua = String(p.userAgent ?? "");
    if (!ua || /bot|crawl|spider|slurp|curl|wget|headless|monitor|uptime/i.test(ua)) return;

    if (!s.countAdmins && p.userId) {
      const { rows } = await db.execute(sql`
        SELECT role FROM users WHERE id = ${p.userId}::uuid LIMIT 1
      `);
      const role = String(rows[0]?.role ?? "");
      if (role === "admin" || role === "manager") return;
    }

    const day = localDayTag();
    if (prunedDay !== day) {
      prunedDay = day;
      await pruneVisits(db, s.keepDailyDays);
    }

    await recordVisit(db, {
      salt: await salt(),
      ip: String(p.ip ?? ""),
      userAgent: ua,
      referer: String(p.referer ?? ""),
      userId: p.userId ?? null,
    });
  });

  /** 공개 집계 — 테마 푸터의 "오늘 N명" 표시에 쓴다 */
  ctx.registerRoute("GET", "/visits", async () => {
    const s = await visitStats(db);
    // 공개 응답에는 요약만 낸다. 일별 추이는 운영 정보이므로 관리자만 본다.
    return { today: s.today, yesterday: s.yesterday, total: s.total, best: s.best };
  });

  ctx.registerRoute("GET", "/admin/visits", async (req) => {
    requireAdmin(req);
    return { ...(await visitStats(db)), referers: await todayReferers(db) };
  });

  // ════════════════════════════════════════════════════
  //  팝업 · 배너
  // ════════════════════════════════════════════════════

  /**
   * 이 경로에 띄울 팝업.
   *
   * 노출 카운트를 여기서 올린다 — 목록을 받아간 것이 곧 노출이다.
   * 클라이언트가 별도 요청으로 알려주는 방식은 광고 차단기에 막히고,
   * 조작도 쉽다.
   */
  ctx.registerRoute("GET", "/popups", async (req) => {
    const path = String(req.query.path ?? "/");
    const kind = req.query.kind === "banner" ? "banner" : "popup";
    const rows = await livePopups(db, { path, kind });
    if (rows.length) {
      await countView(db, rows.map((r) => String(r.id)));
    }
    return { items: rows };
  });

  ctx.registerRoute("POST", "/popups/:id/click", async (req) => {
    await countClick(db, req.params.id);
    return { ok: true };
  });

  // ── 관리자 CRUD ─────────────────────────────────────
  ctx.registerRoute("GET", "/admin/popups", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT id, title, kind, content, image_url, link_url, link_target, path_prefix,
             pos_top, pos_left, width, hide_days, starts_at, ends_at, sort_order,
             is_active, view_count, click_count, created_at
      FROM site_popups ORDER BY sort_order, created_at DESC
      LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM site_popups`);
    return {
      items: rows.map((r) => ({
        ...r,
        kind_label: r.kind === "banner" ? "배너" : "레이어 팝업",
      })),
      total: Number(cnt[0]?.n ?? 0),
      page,
      pageSize: 30,
    };
  });

  ctx.registerRoute("POST", "/admin/popups", async (req) => {
    requireAdmin(req);
    const result = await createPopup(db, req.body as never);
    await ctx.cache.invalidateTag("pages");
    return result;
  });

  ctx.registerRoute("PUT", "/admin/popups/:id", async (req) => {
    requireAdmin(req);
    await updatePopup(db, req.params.id, req.body as never);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/popups/:id", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      DELETE FROM site_popups WHERE id = ${req.params.id}::uuid RETURNING id
    `);
    if (!rows.length) throw new SiteError(404, "팝업을 찾을 수 없습니다.");
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 설정 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/settings", async (req) => {
    requireAdmin(req);
    return await settings();
  });

  ctx.registerRoute("PUT", "/admin/settings", async (req) => {
    requireAdmin(req);
    const b = req.body as Partial<SiteSettings>;
    const next: SiteSettings = {
      countVisits: b.countVisits !== false,
      countAdmins: b.countAdmins === true,
      keepDailyDays: Math.min(3650, Math.max(0, Math.floor(Number(b.keepDailyDays ?? 0)) || 0)),
    };
    await ctx.settings.set("settings", next);
    return next;
  });

  ctx.registerAdminResource(POPUP_RESOURCE);
  registerSiteBlocks(ctx, db);

  // 대시보드 — 그누보드 관리자 첫 화면의 "오늘 방문자"
  ctx.registerDashboardCard({
    title: "오늘 방문자",
    order: 10,
    load: async () => {
      const s = await visitStats(db);
      return { value: s.today, sub: ctx.t("dash.yesterday", { n: s.yesterday }) };
    },
  });

  return {};
});
