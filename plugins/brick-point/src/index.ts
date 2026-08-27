import { definePlugin } from "@brick/plugin-sdk";
import type { PluginDb } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import {
  createPointsService,
  expirePoints,
  DEFAULT_SETTINGS,
  type PointSettings,
  type PointsService,
} from "./service.js";

class PointError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const KIND_LABEL: Record<string, string> = {
  earn: "적립",
  spend: "사용",
  expire: "만료",
  adjust: "관리자 조정",
  refund: "사용 취소",
};

/**
 * brick-point — 그누보드식 포인트.
 *
 * 이 플러그인이 보여주는 것: **플러그인 간 협력**.
 *  - `provideService("points")` 로 서비스를 공개한다 → 쇼핑몰이 주문 트랜잭션 안에서 차감한다
 *  - 게시판·회원 훅을 구독한다 → 글쓰기·댓글·가입 적립
 *
 * 게시판이나 쇼핑몰이 이 플러그인을 알지 못해도 각자 동작한다.
 * 반대로 이 플러그인은 게시판이 없어도 동작한다.
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as PluginDb;

  const settings = async (): Promise<PointSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.settings.get<Partial<PointSettings>>("settings")) ?? {}),
  });

  const points = createPointsService(db, settings);

  // ── 다른 플러그인에 공개 ────────────────────────────
  ctx.provideService<PointsService>("points", points);

  // ════════════════════════════════════════════════════
  //  훅 구독 — 게시판·회원 활동 적립
  // ════════════════════════════════════════════════════

  ctx.hooks.onAction("user.registered", "brick-point", async (payload) => {
    const { userId } = (payload ?? {}) as { userId?: string };
    if (!userId) return;
    const s = await settings();
    if (s.signupPoint > 0) {
      await points.grant({
        userId,
        amount: s.signupPoint,
        reason: "회원가입 축하 포인트",
        refType: "user.signup",
        refId: userId,
      });
    }
  });

  ctx.hooks.onAction("board.post.created", "brick-point", async (payload) => {
    const { postId, authorId } = (payload ?? {}) as { postId?: string; authorId?: string | null };
    // 비회원 글은 적립 대상이 아니다
    if (!postId || !authorId) return;
    const s = await settings();
    if (s.postPoint > 0) {
      await points.grant({
        userId: authorId,
        amount: s.postPoint,
        reason: "게시글 작성",
        refType: "board.post",
        refId: postId,
      });
    }
  });

  ctx.hooks.onAction("board.comment.created", "brick-point", async (payload) => {
    const { commentId, authorId } = (payload ?? {}) as { commentId?: string; authorId?: string | null };
    if (!commentId || !authorId) return;
    const s = await settings();
    if (s.commentPoint > 0) {
      await points.grant({
        userId: authorId,
        amount: s.commentPoint,
        reason: "댓글 작성",
        refType: "board.comment",
        refId: commentId,
      });
    }
  });

  /**
   * 상품 후기 적립.
   * 후기는 구매한 사람만 쓸 수 있으므로(brick-shop이 검증) 어뷰징 여지가 작다.
   * 게시글보다 후하게 주는 것이 쇼핑몰의 관례다.
   */
  ctx.hooks.onAction("shop.review.created", "brick-point", async (payload) => {
    const { reviewId, authorId } = (payload ?? {}) as { reviewId?: string; authorId?: string | null };
    if (!reviewId || !authorId) return;
    const s = await settings();
    if (s.reviewPoint > 0) {
      await points.grant({
        userId: authorId,
        amount: s.reviewPoint,
        reason: "상품 후기 작성",
        refType: "shop.review",
        refId: reviewId,
      });
    }
  });

  /**
   * 쇼핑몰 결제 완료 적립.
   * refId를 주문번호로 두면 같은 주문에 두 번 적립되지 않는다(멱등 인덱스).
   */
  ctx.hooks.onAction("shop.order.paid", "brick-point", async (payload) => {
    const { userId, orderNo, amount } = (payload ?? {}) as {
      userId?: string | null;
      orderNo?: string;
      amount?: number;
    };
    if (!userId || !orderNo || !amount) return;
    const s = await settings();
    const earn = Math.floor((Number(amount) * s.purchaseRate) / 100);
    if (earn > 0) {
      await points.grant({
        userId,
        amount: earn,
        reason: `구매 적립 (주문 ${orderNo})`,
        refType: "shop.order",
        refId: orderNo,
      });
    }
  });

  /** 로그인 적립 — 1일 1회 (refId에 날짜를 넣어 멱등 인덱스가 막아준다) */
  ctx.hooks.onAction("auth.login", "brick-point", async (payload) => {
    const { userId } = (payload ?? {}) as { userId?: string };
    if (!userId) return;
    const s = await settings();
    if (s.loginPoint <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    await points.grant({
      userId,
      amount: s.loginPoint,
      reason: "출석 포인트",
      refType: "auth.login",
      refId: `${userId}:${today}`,
    });
  });

  // ════════════════════════════════════════════════════
  //  공개 API
  // ════════════════════════════════════════════════════

  /** 내 포인트 잔액과 내역 */
  ctx.registerRoute("GET", "/my", async (req) => {
    if (!req.user) throw new PointError(401, "로그인이 필요합니다.");
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 30;

    const [balance, history, counted, expiring] = await Promise.all([
      points.balance(req.user.id),
      db.execute(sql`
        SELECT amount, kind, reason, created_at, expires_at
        FROM point_ledger WHERE user_id = ${req.user.id}::uuid
        ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
      `).then((r) => r.rows),
      db.execute(sql`
        SELECT count(*) AS n FROM point_ledger WHERE user_id = ${req.user.id}::uuid
      `).then((r) => Number(r.rows[0]?.n ?? 0)),
      // 30일 안에 만료될 포인트 — 사용자에게 알려줘야 한다
      db.execute(sql`
        SELECT coalesce(sum(remaining), 0) AS n FROM point_ledger
        WHERE user_id = ${req.user.id}::uuid AND amount > 0 AND remaining > 0
          AND expires_at IS NOT NULL AND expires_at BETWEEN now() AND now() + interval '30 days'
      `).then((r) => Number(r.rows[0]?.n ?? 0)),
    ]);

    return {
      balance,
      expiringSoon: expiring,
      items: history.map((r) => ({
        ...r,
        kindLabel: KIND_LABEL[String(r.kind)] ?? String(r.kind),
      })),
      total: counted,
      page,
      pageSize: size,
    };
  });

  /** 주문서가 "사용 가능한 최대 포인트"를 계산할 때 쓴다 */
  ctx.registerRoute("GET", "/usable", async (req) => {
    if (!req.user) return { balance: 0, usable: 0 };
    const s = await settings();
    const orderAmount = Math.max(0, Math.floor(Number(req.query.amount ?? 0)));
    const balance = await points.balance(req.user.id);
    // 주문금액의 일정 비율까지만 사용 가능 (그누보드/영카트의 관례)
    const cap = orderAmount > 0 ? Math.floor((orderAmount * s.maxUseRate) / 100) : balance;
    const usable = Math.min(balance, cap);
    return {
      balance,
      usable: usable >= s.minUse ? usable : 0,
      minUse: s.minUse,
      maxUseRate: s.maxUseRate,
      earnRate: s.purchaseRate,
    };
  });

  // ════════════════════════════════════════════════════
  //  관리자
  // ════════════════════════════════════════════════════
  const requireAdmin = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new PointError(403, "관리자 권한이 필요합니다.");
    }
  };

  /** 회원별 잔액 목록 */
  ctx.registerRoute("GET", "/admin/balances", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT u.id, u.email, u.display_name,
             coalesce(sum(l.remaining) FILTER (
               WHERE l.amount > 0 AND l.remaining > 0
                 AND (l.expires_at IS NULL OR l.expires_at > now())
             ), 0) AS balance,
             coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0) AS total_earned,
             coalesce(-sum(l.amount) FILTER (WHERE l.amount < 0), 0) AS total_used
      FROM users u LEFT JOIN point_ledger l ON l.user_id = u.id
      GROUP BY u.id, u.email, u.display_name
      ORDER BY balance DESC, u.created_at DESC
      LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM users`);
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        email: String(r.email),
        display_name: String(r.display_name),
        balance: Number(r.balance),
        total_earned: Number(r.total_earned),
        total_used: Number(r.total_used),
        adjust: 0,
        reason: "",
      })),
      total: Number(cnt[0]?.n ?? 0),
      page,
      pageSize: 30,
    };
  });

  /** 관리자 수동 조정 (지급/차감) */
  ctx.registerRoute("PUT", "/admin/balances/:id", async (req) => {
    requireAdmin(req);
    const body = req.body as { adjust?: number; reason?: string };
    const delta = Math.floor(Number(body?.adjust ?? 0));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new PointError(400, "조정할 포인트를 입력해주세요. (지급은 양수, 차감은 음수)");
    }
    const reason = (body?.reason ?? "").trim() || "관리자 조정";

    if (delta > 0) {
      await points.grant({
        userId: req.params.id,
        amount: delta,
        reason,
        // 수동 조정은 여러 번 가능해야 하므로 ref를 두지 않는다(멱등 인덱스 회피)
        actorId: req.user?.id ?? null,
      });
    } else {
      const ok = await points.spend({
        userId: req.params.id,
        amount: -delta,
        reason,
        actorId: req.user?.id ?? null,
      });
      if (!ok) throw new PointError(400, "차감할 포인트가 부족합니다.");
    }
    const balance = await points.balance(req.params.id);
    return { ok: true, balance };
  });

  /** 특정 회원의 내역 (관리자) */
  ctx.registerRoute("GET", "/admin/ledger/:userId", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      SELECT amount, remaining, kind, reason, ref_type, ref_id, expires_at, created_at
      FROM point_ledger WHERE user_id = ${req.params.userId}::uuid
      ORDER BY created_at DESC LIMIT 100
    `);
    return { items: rows };
  });

  /** 설정 */
  ctx.registerRoute("GET", "/admin/settings", async (req) => {
    requireAdmin(req);
    return settings();
  });

  ctx.registerRoute("PUT", "/admin/settings", async (req) => {
    requireAdmin(req);
    const b = req.body as Partial<PointSettings>;
    const num = (v: unknown, fallback: number, min: number, max: number) => {
      const n = Math.floor(Number(v ?? fallback));
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new PointError(400, `값이 허용 범위를 벗어났습니다 (${min}~${max}).`);
      }
      return n;
    };
    const next: PointSettings = {
      expireDays: num(b.expireDays, DEFAULT_SETTINGS.expireDays, 0, 3650),
      signupPoint: num(b.signupPoint, DEFAULT_SETTINGS.signupPoint, 0, 1_000_000),
      postPoint: num(b.postPoint, DEFAULT_SETTINGS.postPoint, 0, 100_000),
      commentPoint: num(b.commentPoint, DEFAULT_SETTINGS.commentPoint, 0, 100_000),
      reviewPoint: num(b.reviewPoint, DEFAULT_SETTINGS.reviewPoint, 0, 100_000),
      loginPoint: num(b.loginPoint, DEFAULT_SETTINGS.loginPoint, 0, 100_000),
      purchaseRate: num(b.purchaseRate, DEFAULT_SETTINGS.purchaseRate, 0, 100),
      maxUseRate: num(b.maxUseRate, DEFAULT_SETTINGS.maxUseRate, 0, 100),
      minUse: num(b.minUse, DEFAULT_SETTINGS.minUse, 0, 1_000_000),
    };
    await ctx.settings.set("settings", next);
    return next;
  });

  // ── 관리 화면 (선언만으로 생성) ─────────────────────
  /**
   * 회원 탈퇴 시 포인트 처리.
   *
   * 잔액은 소멸시키고 원장 행은 남긴다. 원장을 지우면 과거 정산이 맞지 않는다 —
   * "지난달 적립 총액"이 탈퇴 때문에 바뀌면 회계가 성립하지 않는다.
   * 승계 제도가 없으므로 잔액은 돌려주지 않는다. 그래서 미리 알려야 한다.
   */
  ctx.registerDataEraser({
    label: "포인트",
    order: 40,
    async erase({ tx, userId }) {
      const { rows } = await tx.execute(sql`
        UPDATE point_ledger SET remaining = 0
        WHERE user_id = ${userId}::uuid AND remaining > 0
        RETURNING remaining
      `);
      return rows.length ? ["잔여 포인트 소멸 (원장 기록은 정산을 위해 유지)"] : [];
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT coalesce(sum(remaining), 0) AS balance FROM point_ledger
        WHERE user_id = ${userId}::uuid AND remaining > 0
      `);
      const balance = Number(rows[0]?.balance ?? 0);
      return [{
        label: "포인트",
        detail: balance > 0
          ? `${balance.toLocaleString("ko-KR")}점이 소멸됩니다. 되돌릴 수 없고 환불되지 않습니다.`
          : "잔여 포인트가 없습니다.",
      }];
    },
  });

  ctx.registerAdminResource({
    name: "balances",
    title: "포인트",
    itemLabel: "회원 포인트",
    basePath: "/admin/balances",
    order: 25,
    description:
      "회원별 포인트 잔액입니다. 수정에서 '조정' 값을 입력하면 지급(양수)·차감(음수)됩니다. " +
      "모든 변동은 원장에 기록되어 되돌릴 수 없습니다.",
    can: { create: false, delete: false },
    fields: [
      { name: "display_name", label: "이름", type: "text", readOnly: true, inList: true },
      { name: "email", label: "이메일", type: "text", readOnly: true, inList: true },
      { name: "balance", label: "잔액", type: "number", readOnly: true, inList: true },
      { name: "total_earned", label: "누적 적립", type: "number", readOnly: true, inList: true },
      { name: "total_used", label: "누적 사용", type: "number", readOnly: true, inList: true },
      { name: "adjust", label: "조정", type: "number",
        help: "지급은 양수, 차감은 음수를 입력하세요. 예: 500 또는 -200" },
      { name: "reason", label: "사유", type: "text", help: "회원의 포인트 내역에 표시됩니다." },
    ],
  });

  ctx.registerAdminResource({
    name: "settings",
    title: "포인트 설정",
    itemLabel: "설정",
    basePath: "/admin/settings-list",
    order: 26,
    description: "적립 정책과 사용 제한을 정합니다. 0으로 두면 해당 적립을 하지 않습니다.",
    can: { create: false, delete: false },
    fields: [
      { name: "signupPoint", label: "회원가입 적립", type: "number", inList: true },
      { name: "postPoint", label: "게시글 작성 적립", type: "number", inList: true },
      { name: "commentPoint", label: "댓글 작성 적립", type: "number", inList: true },
      { name: "reviewPoint", label: "상품 후기 적립", type: "number", inList: true,
        help: "구매 확인된 후기에만 지급됩니다." },
      { name: "loginPoint", label: "출석(로그인) 적립", type: "number", help: "1일 1회" },
      { name: "purchaseRate", label: "구매 적립률 (%)", type: "number", inList: true,
        help: "결제 완료 시 결제금액의 이 비율만큼 적립합니다." },
      { name: "maxUseRate", label: "주문당 사용 한도 (%)", type: "number",
        help: "주문금액의 이 비율까지만 포인트로 결제할 수 있습니다. 100이면 전액." },
      { name: "minUse", label: "최소 사용 포인트", type: "number" },
      { name: "expireDays", label: "유효기간 (일)", type: "number", inList: true,
        help: "0이면 무기한. 오래된 포인트부터 자동으로 사용됩니다." },
    ],
  });

  // 단일 설정을 목록 형태로 감싼다 (관리 화면이 목록을 기대한다)
  ctx.registerRoute("GET", "/admin/settings-list", async (req) => {
    requireAdmin(req);
    return { items: [{ id: "settings", ...(await settings()) }], total: 1 };
  });
  ctx.registerRoute("PUT", "/admin/settings-list/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Partial<PointSettings>;
    const num = (v: unknown, fallback: number, min: number, max: number) => {
      const n = Math.floor(Number(v ?? fallback));
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new PointError(400, `값이 허용 범위를 벗어났습니다 (${min}~${max}).`);
      }
      return n;
    };
    const current = await settings();
    const next: PointSettings = {
      expireDays: num(b.expireDays, current.expireDays, 0, 3650),
      signupPoint: num(b.signupPoint, current.signupPoint, 0, 1_000_000),
      postPoint: num(b.postPoint, current.postPoint, 0, 100_000),
      commentPoint: num(b.commentPoint, current.commentPoint, 0, 100_000),
      reviewPoint: num(b.reviewPoint, current.reviewPoint, 0, 100_000),
      loginPoint: num(b.loginPoint, current.loginPoint, 0, 100_000),
      purchaseRate: num(b.purchaseRate, current.purchaseRate, 0, 100),
      maxUseRate: num(b.maxUseRate, current.maxUseRate, 0, 100),
      minUse: num(b.minUse, current.minUse, 0, 1_000_000),
    };
    await ctx.settings.set("settings", next);
    return { ok: true };
  });

  // ── 만료 처리 (하루 1회) ────────────────────────────
  // 잔액 계산은 expires_at을 보므로 이 작업 없이도 잔액은 정확하다.
  // 사용자에게 "만료" 내역을 보여주기 위한 정리 작업이다.
  const timer = setInterval(
    () => {
      void expirePoints(db).catch(() => undefined);
    },
    24 * 60 * 60 * 1000,
  );
  timer.unref();
  void expirePoints(db).catch(() => undefined);

  // ── 블록: 내 포인트 위젯 ────────────────────────────
  ctx.registerBlock({
    name: "my-points",
    displayName: "내 포인트",
    render: async (_props, blockCtx) => {
      if (!blockCtx.user) {
        return `<div class="brick-point-widget"><a href="/login">로그인</a> 후 포인트를 확인할 수 있습니다.</div>${WIDGET_CSS}`;
      }
      const balance = await points.balance(blockCtx.user.id);
      return `<div class="brick-point-widget">
  <span class="brick-point-label">내 포인트</span>
  <strong class="brick-point-value">${balance.toLocaleString("ko-KR")}</strong>
</div>${WIDGET_CSS}`;
    },
  });

  return {
    deactivate: async () => {
      clearInterval(timer);
    },
  };
});

const WIDGET_CSS = `
<style>
.brick-point-widget{display:flex;align-items:baseline;gap:8px;padding:14px 18px;background:#f8f8fb;border-radius:10px;font-size:14px}
.brick-point-label{color:#888}
.brick-point-value{font-size:20px;color:var(--color-primary,#d0402c)}
</style>`;
