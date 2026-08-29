import { definePlugin, isUniqueViolation } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  DEFAULT_SETTINGS, HelpError, STATUS_LABEL, TICKET_STATUS,
  type Db, type HelpSettings,
} from "./types.js";
import {
  addReply, createTicket, getTicket, listAllTickets, listMyTickets, updateTicket,
} from "./tickets.js";
import {
  createFaq, deleteFaq, listCategories, listCategoriesAdmin, listFaqs, listFaqsAdmin,
  markViewed, rateFaq, updateFaq, validateCategory,
} from "./faq.js";
import { FAQ_RESOURCE, FAQ_CATEGORY_RESOURCE, TICKET_RESOURCE } from "./admin-resources.js";
import { registerHelpdeskBlocks } from "./blocks.js";

/**
 * brick-helpdesk — 1:1 문의 + FAQ.
 *
 * 왜 게시판으로 하지 않았나: 게시판은 **기본이 공개**다. 문의는 반대여야 한다.
 * 비밀글 옵션을 켜서 쓰면 실수로 공개 글을 쓰는 순간 주문번호·연락처가 노출된다.
 * 기본값이 안전한 쪽이어야 한다.
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as Db;

  const settings = async (): Promise<HelpSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.settings.get<Partial<HelpSettings>>("settings")) ?? {}),
  });

  const requireManager = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new HelpError(403, "권한이 없습니다.");
    }
  };
  const isManager = (req: { user: { role: string } | null }) =>
    req.user?.role === "admin" || req.user?.role === "manager";

  // ════════════════════════════════════════════════════
  //  1:1 문의 (공개)
  // ════════════════════════════════════════════════════

  /** 문의 화면이 필요한 것: 분류 목록과 비회원 허용 여부 */
  ctx.registerRoute("GET", "/config", async () => {
    const s = await settings();
    return { categories: s.categories, allowGuest: s.allowGuest };
  });

  ctx.registerRoute("POST", "/tickets", async (req) => {
    const s = await settings();

    // 도배 방지 — 문의는 메일 알림을 유발하므로 스팸의 표적이 된다
    const key = req.user ? `help:${req.user.id}` : `help-ip:${req.ip}`;
    const recent = await ctx.cache.get<number>(key);
    if (recent) {
      throw new HelpError(429, "잠시 후 다시 문의해주세요. (1분에 1건)");
    }

    const result = await createTicket(db, {
      input: req.body as never,
      settings: s,
      user: req.user
        ? { id: req.user.id, displayName: req.user.displayName, email: req.user.email }
        : null,
    });
    await ctx.cache.set(key, 1, 60);

    // 운영자에게 알린다. 실패해도 문의는 접수된 상태를 유지한다 —
    // 메일이 안 나갔다고 사용자의 문의를 버리면 안 된다.
    await ctx.hooks.doAction("helpdesk.ticket.created", {
      ticketId: result.id, ticketNo: result.ticketNo, userId: req.user?.id ?? null,
    });

    return result;
  });

  ctx.registerRoute("GET", "/my/tickets", async (req) => {
    if (!req.user) throw new HelpError(401, "로그인이 필요합니다.");
    const s = await settings();
    return await listMyTickets(db, {
      userId: req.user.id,
      page: Number(req.query.page ?? 1),
      pageSize: s.pageSize,
      status: req.query.status,
    });
  });

  /**
   * 문의 상세.
   *
   * 비회원은 조회 비밀번호를 쿼리로 넘긴다. 본문(POST)이 아닌 이유는
   * 링크로 공유할 수 있어야 하기 때문 — 다만 비밀번호가 주소에 남으므로
   * 서버 로그에 기록되지 않게 주의해야 한다(운영 문서에 적었다).
   */
  ctx.registerRoute("GET", "/tickets/:id", async (req) => {
    return await getTicket(db, {
      id: req.params.id,
      viewer: req.user,
      guestPassword: req.query.pw,
    });
  });

  /** 문의번호로 조회 (비회원이 메일 링크로 들어오는 경로) */
  ctx.registerRoute("GET", "/tickets/by-no/:ticketNo", async (req) => {
    return await getTicket(db, {
      ticketNo: req.params.ticketNo,
      viewer: req.user,
      guestPassword: req.query.pw,
    });
  });

  ctx.registerRoute("POST", "/tickets/:id/replies", async (req) => {
    const body = req.body as { content?: string; attachments?: string[]; pw?: string };

    // 권한 확인은 getTicket 이 한다 — 여기서 다시 구현하면 두 곳이 어긋난다
    const found = await getTicket(db, {
      id: req.params.id,
      viewer: req.user,
      guestPassword: body?.pw,
    });
    if (!found.canReply) throw new HelpError(403, "답변할 수 없습니다.");

    const result = await addReply(db, {
      ticketId: req.params.id,
      content: String(body?.content ?? ""),
      attachments: body?.attachments,
      author: req.user
        ? { id: req.user.id, displayName: req.user.displayName, role: req.user.role }
        : null,
      // 비회원 답변자의 이름 — 티켓의 작성자 이름을 그대로 쓴다.
      // getTicket 의 반환 타입에서는 좁혀져 있으므로 레코드로 접근한다.
      guestName: String((found.ticket as Record<string, unknown>).author_name ?? "작성자"),
    });

    // 운영자 답변이면 작성자에게 알린다
    if (result.status === "answered") {
      await ctx.hooks.doAction("helpdesk.ticket.answered", {
        ticketId: req.params.id, replyId: result.id,
      });
    }
    return result;
  });

  // ════════════════════════════════════════════════════
  //  FAQ (공개)
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/faqs", async (req) => {
    return await listFaqs(db, {
      category: req.query.category,
      q: req.query.q,
      limit: Number(req.query.limit ?? 100),
    });
  });

  ctx.registerRoute("GET", "/faq-categories", async () => await listCategories(db));

  ctx.registerRoute("POST", "/faqs/:id/viewed", async (req) => {
    await markViewed(db, req.params.id);
    return { ok: true };
  });

  ctx.registerRoute("POST", "/faqs/:id/rate", async (req) => {
    const b = req.body as { helpful?: boolean };
    // 같은 방문자가 반복 누르는 것을 캐시로 막는다.
    // 로그인을 요구하지 않는 이유: 요구하면 아무도 누르지 않고 신호가 사라진다.
    const key = `faq-rate:${req.params.id}:${req.ip}`;
    if (await ctx.cache.get<number>(key)) {
      return { ok: true, counted: false };
    }
    await rateFaq(db, req.params.id, b?.helpful === true);
    await ctx.cache.set(key, 1, 86400);
    return { ok: true, counted: true };
  });

  // ════════════════════════════════════════════════════
  //  관리자
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/admin/tickets", async (req) => {
    requireManager(req);
    const s = await settings();
    const result = await listAllTickets(db, {
      page: Number(req.query.page ?? 1),
      pageSize: s.pageSize,
      status: req.query.status,
      q: req.query.q,
      category: req.query.category,
    });
    return {
      ...result,
      items: result.items.map((t) => ({
        ...t,
        status_label: STATUS_LABEL[String(t.status) as never] ?? String(t.status),
      })),
    };
  });

  ctx.registerRoute("GET", "/admin/tickets/:id", async (req) => {
    requireManager(req);
    return await getTicket(db, { id: req.params.id, viewer: req.user });
  });

  ctx.registerRoute("PUT", "/admin/tickets/:id", async (req) => {
    requireManager(req);
    const b = req.body as Record<string, unknown>;

    // 관리 화면의 폼에서 답변 내용을 함께 보낼 수 있게 한다 —
    // 선언적 리소스는 하위 목록을 편집할 수 없으므로(ADR-12) 답변을 한 칸으로 받는다
    const reply = String(b.reply ?? "").trim();
    if (reply) {
      await addReply(db, {
        ticketId: req.params.id,
        content: reply,
        author: { id: req.user!.id, displayName: req.user!.displayName, role: req.user!.role },
      });
    }

    await updateTicket(db, {
      id: req.params.id,
      status: b.status === undefined ? undefined : String(b.status),
      assigneeId: b.assignee_id === undefined ? undefined : (b.assignee_id as string | null),
    });

    if (reply) {
      await ctx.hooks.doAction("helpdesk.ticket.answered", { ticketId: req.params.id });
    }
    return { ok: true };
  });

  // ── FAQ 관리 ────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/faqs", async (req) => {
    requireManager(req);
    return await listFaqsAdmin(db, Number(req.query.page ?? 1));
  });

  ctx.registerRoute("POST", "/admin/faqs", async (req) => {
    requireManager(req);
    const result = await createFaq(db, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return result;
  });

  ctx.registerRoute("PUT", "/admin/faqs/:id", async (req) => {
    requireManager(req);
    await updateFaq(db, req.params.id, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/faqs/:id", async (req) => {
    requireManager(req);
    await deleteFaq(db, req.params.id);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("GET", "/admin/faq-categories", async (req) => {
    requireManager(req);
    return await listCategoriesAdmin(db);
  });

  ctx.registerRoute("POST", "/admin/faq-categories", async (req) => {
    requireManager(req);
    const v = validateCategory(req.body as Record<string, unknown>);
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO help_faq_categories (id, name, slug, sort_order, is_visible)
        VALUES (${id}, ${v.name}, ${v.slug}, ${v.sortOrder}, ${v.isVisible})
      `);
    } catch (err) {
      if (isUniqueViolation(err, "help_faq_categories_slug")) {
        throw new HelpError(409, "이미 사용 중인 분류 주소(slug)입니다.");
      }
      throw err;
    }
    await ctx.cache.invalidateTag("pages");
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/faq-categories/:id", async (req) => {
    requireManager(req);
    const v = validateCategory(req.body as Record<string, unknown>);
    try {
      const { rows } = await db.execute(sql`
        UPDATE help_faq_categories SET
          name = ${v.name}, slug = ${v.slug}, sort_order = ${v.sortOrder}, is_visible = ${v.isVisible}
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new HelpError(404, "분류를 찾을 수 없습니다.");
    } catch (err) {
      if (isUniqueViolation(err, "help_faq_categories_slug")) {
        throw new HelpError(409, "이미 사용 중인 분류 주소(slug)입니다.");
      }
      throw err;
    }
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/faq-categories/:id", async (req) => {
    requireManager(req);
    // FAQ 는 지우지 않는다 (ON DELETE SET NULL) — 분류를 정리하다가
    // 내용을 잃는 것이 더 나쁘다
    await db.execute(sql`DELETE FROM help_faq_categories WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 설정 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/settings", async (req) => {
    requireManager(req);
    return await settings();
  });

  ctx.registerRoute("PUT", "/admin/settings", async (req) => {
    requireManager(req);
    const b = req.body as Partial<HelpSettings> & { categoriesText?: string };
    // 선언적 폼은 배열을 편집할 수 없으므로 줄바꿈 텍스트로 받는다 (상품 옵션과 같은 방식)
    const categories = b.categoriesText !== undefined
      ? String(b.categoriesText).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20)
      : (Array.isArray(b.categories) ? b.categories : DEFAULT_SETTINGS.categories);
    if (!categories.length) throw new HelpError(400, "문의 분류를 하나 이상 남겨주세요.");

    const next: HelpSettings = {
      allowGuest: b.allowGuest === true,
      categories,
      notifyOnAnswer: b.notifyOnAnswer !== false,
      pageSize: Math.min(50, Math.max(5, Math.floor(Number(b.pageSize ?? DEFAULT_SETTINGS.pageSize)))),
    };
    await ctx.settings.set("settings", next);
    await ctx.cache.invalidateTag("pages");
    return next;
  });

  // ════════════════════════════════════════════════════
  //  알림 · 개인정보 · 사이트맵
  // ════════════════════════════════════════════════════

  /** 운영자 답변이 등록되면 작성자에게 메일 */
  ctx.hooks.onAction<{ ticketId?: string }>("helpdesk.ticket.answered", "brick-helpdesk", async (payload) => {
    const s = await settings();
    if (!s.notifyOnAnswer) return;
    const ticketId = String(payload?.ticketId ?? "");
    if (!ticketId) return;

    const { rows } = await db.execute(sql`
      SELECT ticket_no, title, author_email, author_name FROM help_tickets
      WHERE id = ${ticketId}::uuid LIMIT 1
    `);
    const t = rows[0];
    if (!t?.author_email) return;

    await ctx.mail.send({
      to: String(t.author_email),
      subject: `[문의 ${String(t.ticket_no)}] 답변이 등록되었습니다`,
      text:
        `${String(t.author_name)}님, 문의하신 내용에 답변이 등록되었습니다.\n\n` +
        `문의번호: ${String(t.ticket_no)}\n제목: ${String(t.title)}\n\n` +
        `사이트에 접속해 확인해주세요.`,
    });
  });

  /**
   * 회원 탈퇴 시 문의 처리 (ADR-38).
   *
   * 문의 내용에는 주문번호·연락처·환불 계좌가 들어 있는 경우가 많다.
   * 게시글처럼 익명화만 하고 남기면 개인정보가 그대로 남는다 — **지운다.**
   * 보존 의무가 있는 것은 주문 기록이고, 그건 쇼핑몰 쪽에 남는다.
   */
  ctx.registerDataEraser({
    label: "1:1 문의",
    order: 15,
    async erase({ tx, userId }) {
      const { rows } = await tx.execute(sql`
        DELETE FROM help_tickets WHERE user_id = ${userId}::uuid RETURNING id
      `);
      // 남의 문의에 남긴 운영자 답변은 익명화만 한다 — 답변 내용은 다른
      // 사용자에게 전달된 정보이고, 지우면 그 사람의 문의가 반쪽이 된다
      await tx.execute(sql`
        UPDATE help_replies SET author_id = NULL, author_name = '탈퇴한 회원'
        WHERE author_id = ${userId}::uuid
      `);
      return rows.length ? [`1:1 문의 ${rows.length}건 삭제 (개인정보 포함)`] : [];
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM help_tickets WHERE user_id = ${userId}::uuid
      `);
      const n = Number(rows[0]?.n ?? 0);
      return n
        ? [{ label: "1:1 문의", detail: `${n}건이 삭제됩니다. 답변 내역도 함께 사라집니다.` }]
        : [];
    },
  });

  /** 사이트맵: FAQ 는 공개 콘텐츠이고 검색 유입이 실제로 많다 */
  ctx.registerSitemapSource({
    label: "FAQ",
    async count() {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM help_faq_categories WHERE is_visible = true
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async page({ offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT slug FROM help_faq_categories WHERE is_visible = true
        ORDER BY created_at, id LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/faq?category=${encodeURIComponent(String(r.slug))}`,
        changefreq: "weekly" as const,
        priority: 0.5,
      }));
    },
  });

  ctx.registerAdminResource(TICKET_RESOURCE);
  ctx.registerAdminResource(FAQ_RESOURCE);
  ctx.registerAdminResource(FAQ_CATEGORY_RESOURCE);

  registerHelpdeskBlocks(ctx, db, settings);

  // 대시보드 — 답변을 기다리는 문의는 운영자가 가장 먼저 봐야 할 숫자다
  ctx.registerDashboardCard({
    title: "답변 대기 문의",
    order: 40,
    link: "/admin/x/brick-helpdesk/tickets",
    load: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM help_tickets WHERE status = 'open'
      `);
      return { value: Number(rows[0]?.n ?? 0) };
    },
  });

  return {};
});
