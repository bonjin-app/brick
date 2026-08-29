import { definePlugin, isUniqueViolation, isValidBusinessNo, maskEmail, rawResponse, searchExcerpt } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { DEFAULT_SETTINGS, ShopError, STATUS_LABEL, escapeHtml, won,
         type Db, type OrderStatus, type ShopSettings } from "./types.js";
import { quote } from "./pricing.js";
import { addToCart, clearCart, getCartItems, updateCartItem, type CartOwner } from "./cart.js";
import { changeOrderStatus, createOrder, type PointsPort } from "./orders.js";
import { bankTransferGateway, confirmPayment, gateways, refundPayment, registerGateway } from "./payments.js";
import { CASH_RECEIPT_RESOURCE, CATEGORY_RESOURCE, COLLECTION_RESOURCE, GRADE_RESOURCE, COUPON_RESOURCE, INQUIRY_RESOURCE,
         ORDER_RESOURCE, PRODUCT_RESOURCE, RETURN_RESOURCE, REVIEW_RESOURCE,
         PAYMENT_REQUEST_RESOURCE, SHIPPING_ZONE_RESOURCE, SUBSCRIPTION_RESOURCE,
         TAX_INVOICE_RESOURCE } from "./admin-resources.js";
import { registerStorefrontBlocks } from "./blocks.js";
import {
  createInquiry, createReview, deleteInquiry, deleteReview, findPurchase,
  listInquiries, listReviews, replyToInquiry, replyToReview, setReviewVisible, updateReview,
} from "./reviews.js";
import { formatOptions, parseImages, parseOptions, syncOptions } from "./options.js";
import {
  KIND_LABEL, REASON_CODES, RETURN_KINDS, RETURN_STATUS, RETURN_STATUS_LABEL,
  cancelRequest, getReturn, getReturnable, listAllReturns, listMyReturns,
  requestReturn, updateReturnStatus,
} from "./returns.js";
import { RELATED_LIMIT, listRelated, syncRelated } from "./related.js";
import {
  cancelPaymentRequest, createPaymentRequest, listPaymentRequests,
  markRequestPaid, prepareOrderForRequest, viewPaymentRequest,
} from "./direct-payment.js";
import {
  activeCollections, createCollection, deleteCollection, listCollectionsAdmin,
  updateCollection, viewCollection,
} from "./collections.js";
import {
  GRADE_RECOMPUTE_JOB, createGrade, deleteGrade, eraseGrade, gradeOf, listGrades,
  myGrade, recomputeGrades, updateGrade,
} from "./grades.js";
import {
  RESTOCK_QUEUE_JOB, cancelRestockAlert, eraseRestockAlerts, listMyRestockAlerts,
  listRestockDemand, requestRestockAlert, sendRestockNotifications, sweepRestock,
} from "./restock.js";
import {
  RECEIPT_KINDS, RECEIPT_KIND_LABEL, VAT_PERIODS, cancelCashReceipt, cancelReceiptsForOrder,
  listCashReceiptGateways, listCashReceipts, listTaxInvoices, markCashReceiptIssued,
  requestCashReceipt, requestTaxInvoice, updateTaxInvoice, vatReport,
} from "./tax.js";
import {
  SITE_TZ, parseGroupBy, parsePeriod, salesByCategory, salesByPeriod,
  salesByProduct, salesSummary, toCsv,
} from "./reports.js";
import {
  addToWishlist, createZone, deleteZone, findZoneFee, isInWishlist, listRecentViews,
  listWishlist, listZones, mergeGuestViews, mergeGuestWishlist, purgeOldViews,
  recordView, removeFromWishlist, updateZone, type Owner as WishOwner,
} from "./wishlist.js";
import {
  SUBSCRIPTION_QUEUE_JOB, cancelSubscription, chargeDueSubscriptions, issueBillingKey,
  listBillingKeys, listBillingProviders, listMySubscriptions, listSubscriptionsAdmin,
  resumeSubscription, revokeBillingKey, subscribe, subscriptionEvents,
} from "./subscriptions.js";
import { BIRTHDAY_QUEUE_JOB, issueBirthdayCoupons } from "./birthday.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,148}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 폼의 "선택 없음"("")과 미지정을 모두 null 로 본다 */
function parseParentId(raw: unknown): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const v = String(raw).trim();
  if (!UUID_RE.test(v)) throw new ShopError(400, "상위 분류가 올바르지 않습니다.");
  return v;
}

/** 없는 분류를 부모로 지정하면 FK 위반 500 이 아니라 400 으로 알려준다 */
async function requireCategory(db: Db, id: string): Promise<void> {
  const { rows } = await db.execute(sql`SELECT 1 FROM shop_categories WHERE id = ${id}::uuid LIMIT 1`);
  if (!rows.length) throw new ShopError(400, "상위 분류를 찾을 수 없습니다.");
}

/**
 * brick-shop — 커머스 플러그인 (영카트에 대응).
 *
 * 이 플러그인이 증명하는 것: Brick의 플러그인 아키텍처가 쇼핑몰 규모의
 * 기능을 코어 수정 없이 담을 수 있다.
 *  - 자기 테이블 8개 (migrations/)
 *  - 관리 화면 4개 (registerAdminResource — React 코드 없이 선언만)
 *  - 스토어프론트 블록 (페이지 빌더에서 배치)
 *  - REST API (회원/비회원 장바구니, 주문, 결제)
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as Db;

  const settings = async (): Promise<ShopSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.settings.get<Partial<ShopSettings>>("settings")) ?? {}),
  });

  /**
   * 포인트 서비스 — brick-point가 설치·활성화된 경우에만 존재한다.
   *
   * 활성화 시점이 아니라 **사용 시점**에 조회한다. 플러그인 활성화 순서에 의존하면
   * 쇼핑몰이 먼저 켜진 경우 포인트를 못 찾는다.
   */
  const pointsPort = (): PointsPort | null => ctx.useService<PointsPort>("points");

  /** 요청에서 장바구니 소유자 판별 — 회원 우선, 비회원은 토큰 */
  const owner = (req: { user: { id: string } | null; query: Record<string, string> }): CartOwner =>
    req.user ? { userId: req.user.id } : { guestToken: req.query.guest ?? null };

  // ════════════════════════════════════════════════════
  //  스토어프론트 (공개 API)
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/products", async (req) => {
    const s = await settings();
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = Math.min(60, Number(req.query.size ?? s.pageSize));
    const category = req.query.category ?? "";
    const q = (req.query.q ?? "").trim();
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const { rows } = await db.execute(sql`
      SELECT p.id, p.slug, p.name, p.summary, p.image_url, p.price, p.list_price,
             p.stock, p.status, p.sold_count, p.review_count, p.rating_sum,
             c.name AS category_name, c.slug AS category_slug
      FROM shop_products p
      LEFT JOIN shop_categories c ON c.id = p.category_id
      WHERE p.status IN ('selling', 'soldout')
        AND (${category} = '' OR c.slug = ${category})
        AND (${q} = '' OR p.name ILIKE ${like} OR coalesce(p.summary,'') ILIKE ${like})
      ORDER BY p.sort_order, p.created_at DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}
    `);
    const { rows: cnt } = await db.execute(sql`
      SELECT count(*) AS n FROM shop_products p
      LEFT JOIN shop_categories c ON c.id = p.category_id
      WHERE p.status IN ('selling', 'soldout')
        AND (${category} = '' OR c.slug = ${category})
        AND (${q} = '' OR p.name ILIKE ${like} OR coalesce(p.summary,'') ILIKE ${like})
    `);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: size };
  });

  ctx.registerRoute("GET", "/products/:slug", async (req) => {
    const { rows } = await db.execute(sql`
      UPDATE shop_products SET view_count = view_count + 1
      WHERE slug = ${req.params.slug} AND status IN ('selling', 'soldout')
      RETURNING id, slug, name, summary, description, image_url, images, price, list_price,
                stock, status, free_shipping, sold_count, view_count, category_id,
                review_count, rating_sum, inquiry_count
    `);
    const product = rows[0];
    if (!product) throw new ShopError(404, "상품을 찾을 수 없습니다.");
    const { rows: options } = await db.execute(sql`
      SELECT id, name, extra_price, stock FROM shop_product_options
      WHERE product_id = ${String(product.id)}::uuid AND is_active = true
      ORDER BY sort_order, name
    `);
    // 관련 상품. 실패해도 상세는 응답해야 한다 (추천은 부가 기능이다)
    const related = await listRelated(db, String(product.id), RELATED_LIMIT).catch(() => []);
    // 최근 본 상품에 기록한다. 실패해도 상세 화면은 떠야 하므로 예외를 삼킨다 —
    // 열람 기록은 부가 기능이고, 이것 때문에 상품을 못 보면 안 된다.
    let viewToken: string | null = null;
    try {
      const owner = wishOwner(req);
      if (owner.userId || owner.guestToken || req.query.track === "1") {
        const rec = await recordView(db, { owner, productId: String(product.id) });
        viewToken = rec.guestToken;
      }
    } catch {
      // 무시
    }

    return {
      guestToken: viewToken,
      product: {
        ...product,
        rating_avg:
          Number(product.review_count) > 0
            ? Math.round((Number(product.rating_sum) / Number(product.review_count)) * 10) / 10
            : 0,
      },
      options,
      related,
    };
  });

  ctx.registerRoute("GET", "/categories", async () => {
    const { rows } = await db.execute(sql`
      SELECT c.id, c.slug, c.name, c.parent_id,
             (SELECT count(*) FROM shop_products p WHERE p.category_id = c.id AND p.status = 'selling') AS product_count
      FROM shop_categories c WHERE c.is_visible = true ORDER BY c.sort_order, c.name
    `);
    return rows;
  });

  // ── 장바구니 ────────────────────────────────────────
  ctx.registerRoute("GET", "/cart", async (req) => {
    const items = await getCartItems(db, owner(req));
    // 관대 모드: 품절/판매중지 상품이 있어도 장바구니는 보여야 한다.
    // (조회가 실패하면 사용자가 수량을 줄이거나 삭제할 수도 없게 된다)
    const q = await quote(
      db,
      items.map((it) => ({ ...it, ref: it.id })),
      await settings(),
      req.query.coupon,
      { enforceStock: false },
    );
    return {
      // ref로 장바구니 항목 id를 되돌려받는다 (인덱스 정렬에 의존하지 않는다)
      items: q.lines.map((line) => ({ ...line, id: line.ref })),
      subtotal: q.subtotal,
      discount: q.discount,
      shippingFee: q.shippingFee,
      total: q.total,
      couponCode: q.couponCode,
      couponError: q.couponError,
      hasUnavailable: q.hasUnavailable,
    };
  });

  ctx.registerRoute("POST", "/cart", async (req) => {
    const body = req.body as { productId: string; optionId?: string; quantity?: number; guestToken?: string };
    const own = req.user ? { userId: req.user.id } : { guestToken: body.guestToken || uuidv7().replace(/-/g, "") };
    await addToCart(db, own, body);
    // 비회원은 발급된 토큰을 받아 이후 요청에 사용한다
    return { ok: true, guestToken: req.user ? null : own.guestToken };
  });

  ctx.registerRoute("PUT", "/cart/:itemId", async (req) => {
    const body = req.body as { quantity: number };
    await updateCartItem(db, owner(req), req.params.itemId, body.quantity);
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/cart/:itemId", async (req) => {
    await updateCartItem(db, owner(req), req.params.itemId, 0);
    return { ok: true };
  });

  // ── 견적 (주문서에서 실시간 금액 확인) ───────────────
  ctx.registerRoute("POST", "/quote", async (req) => {
    const body = req.body as {
      items?: Array<{ productId: string; optionId?: string; quantity: number }>;
      couponCode?: string;
      pointUsed?: number;
      /** 배송지 우편번호 — 지역별 추가 배송비를 계산한다 */
      postcode?: string;
    };
    const items = body.items?.length ? body.items : await getCartItems(db, owner(req));

    // 포인트 사용 요청이 있으면 실제 잔액으로 상한을 잡는다 (클라이언트 값을 신뢰하지 않는다)
    let pointUsed = 0;
    const port = pointsPort();
    if (body.pointUsed && req.user && port) {
      const balance = await port.balance(req.user.id);
      pointUsed = Math.max(0, Math.min(Math.floor(Number(body.pointUsed)), balance));
    }

    const q = await quote(db, items, await settings(), body.couponCode, {
      pointUsed,
      postcode: body.postcode ?? null,
      // 장바구니 견적과 주문 생성이 **같은 등급**을 봐야 금액이 일치한다
      grade: await gradeOf(db, req.user?.id ?? null),
      userId: req.user?.id ?? null,
    });
    return { ...q, pointsAvailable: Boolean(port) };
  });

  // ── 주문 ────────────────────────────────────────────
  ctx.registerRoute("POST", "/orders", async (req) => {
    const body = req.body as {
      items?: Array<{ productId: string; optionId?: string; quantity: number }>;
      couponCode?: string;
      guestToken?: string;
      idempotencyKey?: string;
      pointUsed?: number;
      orderer: Parameters<typeof createOrder>[1]["orderer"];
    };
    const own = req.user ? { userId: req.user.id } : { guestToken: body.guestToken ?? null };
    const items = body.items?.length ? body.items : await getCartItems(db, own);
    if (!items.length) throw new ShopError(400, "장바구니가 비어 있습니다.");

    const result = await createOrder(db, {
      items,
      orderer: body.orderer,
      couponCode: body.couponCode,
      userId: req.user?.id ?? null,
      guestToken: body.guestToken ?? null,
      settings: await settings(),
      // 네트워크 재시도로 같은 주문이 두 번 생기는 것을 막는다
      idempotencyKey: body.idempotencyKey ?? null,
      pointUsed: body.pointUsed,
      pointsPort: pointsPort(),
      grade: await gradeOf(db, req.user?.id ?? null),
    });

    // 주문한 상품을 장바구니에서 비운다 (직접 구매가 아니라 장바구니 주문일 때만)
    if (!body.items?.length) await clearCart(db, own);
    await ctx.hooks.doAction("shop.order.created", {
      orderId: result.id, orderNo: result.orderNo, total: result.total, userId: req.user?.id ?? null,
    });

    const s = await settings();
    return { ...result, bankAccount: s.bankAccount };
  });

  /** 주문 조회 — 회원은 자기 주문, 비회원은 주문번호+토큰 */
  ctx.registerRoute("GET", "/orders/:orderNo", async (req) => {
    const guard = req.user
      ? sql`(o.user_id = ${req.user.id}::uuid OR ${req.user.role === "admin"})`
      : sql`o.guest_token = ${req.query.token ?? ""}`;
    const { rows } = await db.execute(sql`
      SELECT o.* FROM shop_orders o WHERE o.order_no = ${req.params.orderNo} AND ${guard} LIMIT 1
    `);
    const order = rows[0];
    if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");
    const { rows: items } = await db.execute(sql`
      SELECT product_name, option_name, unit_price, quantity, line_total
      FROM shop_order_items WHERE order_id = ${String(order.id)}::uuid
    `);
    const { rows: events } = await db.execute(sql`
      SELECT from_status, to_status, note, created_at FROM shop_order_events
      WHERE order_id = ${String(order.id)}::uuid ORDER BY created_at
    `);
    return { order, items, events, statusLabel: STATUS_LABEL[order.status as OrderStatus] };
  });

  /** 내 주문 목록 (회원) */
  ctx.registerRoute("GET", "/my/orders", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    const { rows } = await db.execute(sql`
      SELECT o.order_no, o.status, o.total, o.created_at,
             (SELECT string_agg(i.product_name, ', ') FROM shop_order_items i WHERE i.order_id = o.id) AS items_summary
      FROM shop_orders o WHERE o.user_id = ${req.user.id}::uuid
      ORDER BY o.created_at DESC LIMIT 50
    `);
    return { items: rows };
  });

  /** 주문 취소 (고객) — 입금대기 상태에서만 */
  ctx.registerRoute("POST", "/orders/:orderNo/cancel", async (req) => {
    const guard = req.user ? sql`user_id = ${req.user.id}::uuid` : sql`guest_token = ${(req.body as { token?: string })?.token ?? ""}`;
    const { rows } = await db.execute(sql`
      SELECT id, status FROM shop_orders WHERE order_no = ${req.params.orderNo} AND ${guard} LIMIT 1
    `);
    if (!rows[0]) throw new ShopError(404, "주문을 찾을 수 없습니다.");
    if (rows[0].status !== "pending") {
      throw new ShopError(400, "결제가 확인된 주문은 직접 취소할 수 없습니다. 판매자에게 문의해주세요.");
    }
    await changeOrderStatus(db, String(rows[0].id), "cancelled", {
      note: "고객 취소",
      actorId: req.user?.id ?? null,
      pointsPort: pointsPort(),
    });
    return { ok: true };
  });

  const requireAdmin = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") throw new ShopError(403, "권한이 없습니다.");
  };

  // ════════════════════════════════════════════════════
  //  결제
  // ════════════════════════════════════════════════════

  // 무통장입금은 기본 내장. PG는 별도 플러그인이 shop.payment.register 훅으로 등록한다.
  registerGateway(bankTransferGateway);

  /**
   * PG 플러그인이 게이트웨이를 등록하는 통로.
   * 별도 플러그인이 코어나 brick-shop을 수정하지 않고 결제수단을 추가할 수 있다.
   */
  ctx.hooks.onAction("shop.payment.register", "brick-shop", async (payload) => {
    const gateway = (payload as { gateway?: unknown })?.gateway;
    if (gateway && typeof gateway === "object" && "provider" in gateway && "confirm" in gateway) {
      registerGateway(gateway as never);
    }
  });

  /** 사용 가능한 결제수단 (주문서가 조회) */
  ctx.registerRoute("GET", "/payment-methods", async () => {
    const s = await settings();
    return {
      // 준비되지 않은 게이트웨이(키를 넣지 않은 PG)는 노출하지 않는다.
      // 손님이 고르면 실패하고, 사이트가 고장난 것처럼 보인다.
      methods: (
        await Promise.all(
          [...gateways.values()].map(async (g) => {
            const ready = g.isReady ? await g.isReady().catch(() => false) : true;
            return ready ? { provider: g.provider, displayName: g.displayName } : null;
          }),
        )
      ).filter((m): m is { provider: string; displayName: string } => m !== null),
      bankAccount: s.bankAccount,
      // 포인트 플러그인이 활성화되어 있으면 주문서에 포인트 사용 UI를 띄운다
      pointsAvailable: Boolean(pointsPort()),
    };
  });

  /**
   * 결제 승인.
   * 클라이언트(PG 리다이렉트)와 웹훅 모두 이 경로를 쓴다.
   * 금액 검증·중복 방어는 confirmPayment가 담당한다.
   */
  ctx.registerRoute("POST", "/payments/confirm", async (req) => {
    const b = req.body as { orderNo?: string; provider?: string; providerTid?: string; amount?: number };
    if (!b?.orderNo || !b?.provider || !b?.providerTid) {
      throw new ShopError(400, "orderNo, provider, providerTid가 필요합니다.");
    }
    // 무통장입금은 관리자만 승인할 수 있다 (고객이 스스로 입금완료 처리하면 안 된다)
    if (b.provider === "bank_transfer" && req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new ShopError(403, "무통장입금 확인은 관리자만 할 수 있습니다.");
    }
    return confirmPayment(db, {
      orderNo: b.orderNo,
      provider: b.provider,
      providerTid: b.providerTid,
      claimedAmount: b.amount,
      actorId: req.user?.id ?? null,
      pointsPort: pointsPort(),
      // 포인트 적립 등이 이 훅을 구독한다
      onPaid: async (info) => {
        // 개인결제 청구서였으면 결제완료로 표시한다.
        //
        // 훅(doAction)이 아니라 직접 부른다 — 훅은 플러그인별 예외를 삼키므로
        // 실패해도 아무도 모르고, 손님은 결제했는데 청구서는 "대기"로 남는다.
        // 같은 플러그인 안의 일이니 훅을 거칠 이유도 없다.
        await markRequestPaid(db, info.orderNo);
        await ctx.hooks.doAction("shop.order.paid", info);
      },
    });
  });

  /** 환불 (관리자) — 부분 환불 지원 */
  ctx.registerRoute("POST", "/admin/payments/refund", async (req) => {
    requireAdmin(req);
    const b = req.body as { orderNo?: string; amount?: number; reason?: string };
    if (!b?.orderNo) throw new ShopError(400, "orderNo가 필요합니다.");
    return refundPayment(db, {
      orderNo: b.orderNo,
      amount: b.amount,
      reason: b.reason || "관리자 환불",
      actorId: req.user?.id ?? null,
      pointsPort: pointsPort(),
    });
  });

  /** 주문의 결제 내역 (관리자) */
  ctx.registerRoute("GET", "/admin/payments/:orderNo", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      SELECT p.provider, p.provider_tid, p.status, p.amount, p.refunded_amount,
             p.method, p.failure_reason, p.approved_at, p.created_at
      FROM shop_payments p JOIN shop_orders o ON o.id = p.order_id
      WHERE o.order_no = ${req.params.orderNo} ORDER BY p.created_at DESC
    `);
    return { items: rows };
  });

  // ════════════════════════════════════════════════════
  //  관리자 API (선언한 리소스의 백엔드)
  // ════════════════════════════════════════════════════
  // ── 상품 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/products", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT p.id, p.slug, p.name, p.price, p.list_price, p.stock, p.status, p.image_url,
             p.summary, p.description, p.free_shipping, p.sort_order, p.sold_count,
             p.category_id, p.tax_free, p.sub_interval, p.images, p.review_count, p.rating_sum,
             coalesce(
               (SELECT json_agg(json_build_object('name', o.name, 'extra_price', o.extra_price, 'stock', o.stock)
                                ORDER BY o.sort_order, o.name)
                FROM shop_product_options o WHERE o.product_id = p.id),
               '[]'
             ) AS options,
             -- 관련 상품도 폼에 되돌려 보여준다. 없으면 저장할 때 지워진 것으로
             -- 오해해서, 상품을 수정할 때마다 관련 상품이 날아간다.
             coalesce(
               (SELECT string_agg(rp.slug, E'\n' ORDER BY r.sort_order, rp.name)
                FROM shop_related_products r
                JOIN shop_products rp ON rp.id = r.related_id
                WHERE r.product_id = p.id),
               ''
             ) AS related_text
      FROM shop_products p ORDER BY p.sort_order, p.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_products`);
    // 관리 화면은 배열을 편집할 수 없으므로 줄바꿈 텍스트로 바꿔 보낸다
    return {
      items: rows.map((r) => ({
        ...r,
        images_text: Array.isArray(r.images) ? (r.images as string[]).join("\n") : "",
        options_text: formatOptions(
          (r.options ?? []) as Array<{ name: unknown; extra_price: unknown; stock: unknown }>,
        ),
        rating_avg:
          Number(r.review_count) > 0
            ? Math.round((Number(r.rating_sum) / Number(r.review_count)) * 10) / 10
            : 0,
        images: undefined,
        options: undefined,
      })),
      total: Number(cnt[0]?.n ?? 0),
      page,
      pageSize: 30,
    };
  });

  ctx.registerRoute("POST", "/admin/products", async (req) => {
    requireAdmin(req);
    const body = req.body as Record<string, unknown>;
    const p = validateProduct(body);
    const images = parseImages(String(body.images_text ?? ""));
    const options = parseOptions(String(body.options_text ?? ""));
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO shop_products
          (id, slug, name, price, list_price, stock, status, image_url, summary, description,
           free_shipping, sort_order, images, category_id, tax_free, sub_interval)
        VALUES
          (${id}, ${p.slug}, ${p.name}, ${p.price}, ${p.listPrice}, ${p.stock}, ${p.status},
           ${p.imageUrl ?? images[0] ?? null}, ${p.summary}, ${p.description},
           ${p.freeShipping}, ${p.sortOrder}, ${JSON.stringify(images)}::jsonb,
           ${p.categoryId}::uuid, ${p.taxFree}, ${p.subInterval})
      `);
    } catch (err) {
      throw slugConflict(err, "상품");
    }
    if (options.length) await syncOptions(db, id, options);
    // 관련 상품은 상품이 만들어진 뒤에 붙인다 (FK 때문에 순서가 중요하다)
    await syncRelated(db, id, String(body.related_text ?? ""));
    await ctx.cache.invalidateTag("pages");
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/products/:id", async (req) => {
    requireAdmin(req);
    const body = req.body as Record<string, unknown>;
    const p = validateProduct(body);
    const images = parseImages(String(body.images_text ?? ""));
    const options = parseOptions(String(body.options_text ?? ""));
    try {
      const { rows } = await db.execute(sql`
        UPDATE shop_products SET
          slug = ${p.slug}, name = ${p.name}, price = ${p.price}, list_price = ${p.listPrice},
          stock = ${p.stock}, status = ${p.status},
          image_url = ${p.imageUrl ?? images[0] ?? null}, summary = ${p.summary},
          description = ${p.description}, free_shipping = ${p.freeShipping}, sort_order = ${p.sortOrder},
          images = ${JSON.stringify(images)}::jsonb, category_id = ${p.categoryId}::uuid,
          tax_free = ${p.taxFree}, sub_interval = ${p.subInterval}, updated_at = now()
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new ShopError(404, "상품을 찾을 수 없습니다.");
    } catch (err) {
      throw slugConflict(err, "상품");
    }
    // 옵션은 이름으로 짝지어 갱신한다 — 전부 지우면 장바구니의 옵션이 사라진다
    await syncOptions(db, req.params.id, options);
    await syncRelated(db, req.params.id, String(body.related_text ?? ""));
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/products/:id", async (req) => {
    requireAdmin(req);
    await db.execute(sql`DELETE FROM shop_products WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 분류 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/categories", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      SELECT id, slug, name, sort_order, is_visible FROM shop_categories ORDER BY sort_order, name
    `);
    return { items: rows, total: rows.length };
  });

  ctx.registerRoute("POST", "/admin/categories", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    const slug = String(b.slug ?? "").trim();
    if (!SLUG_RE.test(slug)) throw new ShopError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");
    if (!String(b.name ?? "").trim()) throw new ShopError(400, "분류명을 입력해주세요.");
    const parentId = parseParentId(b.parent_id);
    if (parentId) await requireCategory(db, parentId);
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO shop_categories (id, slug, name, sort_order, is_visible, parent_id)
        VALUES (${id}, ${slug}, ${String(b.name).trim()}, ${Number(b.sort_order ?? 0)},
                ${b.is_visible !== false}, ${parentId}::uuid)
      `);
    } catch (err) {
      throw slugConflict(err, "분류");
    }
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/categories/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    const slug = String(b.slug ?? "").trim();
    if (!SLUG_RE.test(slug)) throw new ShopError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");
    const parentId = parseParentId(b.parent_id);
    // 순환을 막는다. 자기 자신이나 자기 자손을 부모로 지정하면 분류 트리를
    // 훑는 재귀 쿼리가 끝나지 않는다 (선택지 목록·분류별 리포트가 멈춘다).
    if (parentId) {
      if (parentId === req.params.id) throw new ShopError(400, "자기 자신을 상위 분류로 지정할 수 없습니다.");
      await requireCategory(db, parentId);
      const { rows: cyc } = await db.execute(sql`
        WITH RECURSIVE up AS (
          SELECT id, parent_id FROM shop_categories WHERE id = ${parentId}::uuid
          UNION ALL
          SELECT c.id, c.parent_id FROM shop_categories c JOIN up ON up.parent_id = c.id
        )
        SELECT 1 FROM up WHERE id = ${req.params.id}::uuid LIMIT 1
      `);
      if (cyc.length) throw new ShopError(400, "하위 분류를 상위 분류로 지정할 수 없습니다.");
    }
    try {
      await db.execute(sql`
        UPDATE shop_categories SET slug = ${slug}, name = ${String(b.name ?? "").trim()},
          sort_order = ${Number(b.sort_order ?? 0)}, is_visible = ${b.is_visible !== false},
          parent_id = ${parentId}::uuid
        WHERE id = ${req.params.id}::uuid
      `);
    } catch (err) {
      throw slugConflict(err, "분류");
    }
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/categories/:id", async (req) => {
    requireAdmin(req);
    await db.execute(sql`DELETE FROM shop_categories WHERE id = ${req.params.id}::uuid`);
    return { ok: true };
  });

  // ── 주문 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/orders", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT o.id, o.order_no, o.status, o.total, o.created_at, o.orderer_name, o.tracking_no,
             o.receiver_name, o.receiver_phone, o.delivery_memo, o.payment_method,
             o.postcode || ' ' || o.address1 || ' ' || coalesce(o.address2, '') AS address_full,
             (SELECT string_agg(i.product_name || ' x' || i.quantity, ', ')
              FROM shop_order_items i WHERE i.order_id = o.id) AS items_summary
      FROM shop_orders o ORDER BY o.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_orders`);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: 30 };
  });

  ctx.registerRoute("PUT", "/admin/orders/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as { status?: string; tracking_no?: string; note?: string };
    if (b.status) {
      await changeOrderStatus(db, req.params.id, b.status as OrderStatus, {
        note: b.note || undefined,
        actorId: req.user?.id ?? null,
        trackingNo: b.tracking_no || null,
        pointsPort: pointsPort(),
      });
    } else if (b.tracking_no !== undefined) {
      await db.execute(sql`
        UPDATE shop_orders SET tracking_no = ${b.tracking_no}, updated_at = now()
        WHERE id = ${req.params.id}::uuid
      `);
    }
    return { ok: true };
  });

  // ── 쿠폰 ────────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/coupons", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      SELECT id, code, name, discount_type, discount_value, min_amount, max_discount,
             usage_limit, used_count, is_active,
             per_user_limit, first_purchase_only, grade_id, requires_issue, birthday_auto
      FROM shop_coupons ORDER BY created_at DESC LIMIT 100
    `);
    return { items: rows, total: rows.length };
  });

  ctx.registerRoute("POST", "/admin/coupons", async (req) => {
    requireAdmin(req);
    const c = validateCoupon(req.body as Record<string, unknown>);
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO shop_coupons
          (id, code, name, discount_type, discount_value, min_amount, max_discount, usage_limit,
           is_active, per_user_limit, first_purchase_only, grade_id, requires_issue, birthday_auto)
        VALUES (${id}, ${c.code}, ${c.name}, ${c.type}, ${c.value}, ${c.minAmount}, ${c.maxDiscount},
                ${c.usageLimit}, ${c.isActive},
                ${c.perUserLimit}, ${c.firstPurchaseOnly}, ${c.gradeId}::uuid, ${c.requiresIssue},
                ${c.birthdayAuto})
      `);
    } catch (err) {
      if (isUniqueViolation(err, "shop_coupons_code")) {
        throw new ShopError(409, `쿠폰 코드 "${c.code}" 는 이미 사용 중입니다.`);
      }
      throw err;
    }
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/coupons/:id", async (req) => {
    requireAdmin(req);
    const c = validateCoupon(req.body as Record<string, unknown>);
    await db.execute(sql`
      UPDATE shop_coupons SET code = ${c.code}, name = ${c.name}, discount_type = ${c.type},
        discount_value = ${c.value}, min_amount = ${c.minAmount}, max_discount = ${c.maxDiscount},
        usage_limit = ${c.usageLimit}, is_active = ${c.isActive},
        per_user_limit = ${c.perUserLimit}, first_purchase_only = ${c.firstPurchaseOnly},
        grade_id = ${c.gradeId}::uuid, requires_issue = ${c.requiresIssue},
        birthday_auto = ${c.birthdayAuto}
      WHERE id = ${req.params.id}::uuid
    `);
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/coupons/:id", async (req) => {
    requireAdmin(req);
    await db.execute(sql`DELETE FROM shop_coupons WHERE id = ${req.params.id}::uuid`);
    return { ok: true };
  });

  // ── 매출 통계 ───────────────────────────────────────
  //
  // 여기에 두 가지 버그가 있었다:
  //   1. sum(total) 이라 **부분 환불을 빼지 않았다.** 주문 상태가 cancelled 로
  //      바뀌는 것은 전체 취소뿐이어서, 두 개 중 하나를 반품한 주문은 전액이
  //      매출로 남았다.
  //   2. created_at 기준이고 서버 시간대라, 한국에서 1일 오전 9시 이전 결제가
  //      전달 매출로 잡혔다.
  // 이제 결제일(paid_at) · 사이트 시간대 · 환불 차감으로 센다 (reports.ts).
  ctx.registerRoute("GET", "/admin/stats", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      WITH refunds AS (
        SELECT order_id, sum(refund_amount) AS refunded
        FROM shop_returns WHERE status = 'completed' GROUP BY order_id
      )
      SELECT
        count(*) FILTER (WHERE o.status = 'pending')                     AS pending_orders,
        count(*) FILTER (WHERE o.status NOT IN ('cancelled','refunded')) AS valid_orders,
        coalesce(sum(o.total - coalesce(r.refunded, 0))
                 FILTER (WHERE o.paid_at IS NOT NULL), 0)               AS revenue,
        coalesce(sum(o.total - coalesce(r.refunded, 0))
                 FILTER (WHERE o.paid_at IS NOT NULL
                   AND o.paid_at >= (date_trunc('month', now() AT TIME ZONE ${SITE_TZ})
                                     AT TIME ZONE ${SITE_TZ})), 0)      AS revenue_this_month
      FROM shop_orders o
      LEFT JOIN refunds r ON r.order_id = o.id
    `);
    const { rows: low } = await db.execute(sql`
      SELECT name, stock FROM shop_products
      WHERE status = 'selling' AND stock IS NOT NULL AND stock <= 5 ORDER BY stock LIMIT 10
    `);
    return { ...rows[0], timezone: SITE_TZ, lowStock: low };
  });

  // ── 판매 리포트 ─────────────────────────────────────
  //
  // 기간·상품·분류. 정의(무엇을 매출로 세는가)와 시간대 처리는 reports.ts
  // 주석에 적어 두었다. CSV 는 운영자가 결국 엑셀에서 보기 때문에 필요하다.

  /** 엑셀에서 열리는 CSV 첨부 응답 */
  const csvReply = (
    name: string,
    headers: string[],
    rows: Array<Array<string | number | null>>,
  ) =>
    rawResponse(toCsv(headers, rows), "text/csv; charset=utf-8", {
      headers: { "content-disposition": `attachment; filename="${name}.csv"` },
    });

  /**
   * 분류 선택지 — 상품 등록 화면의 `category_id` 필드가 읽는다.
   *
   * 계층을 공백으로 들여써서 보여준다. 평면 목록으로 주면 "상의"가
   * 의류 아래인지 잡화 아래인지 알 수 없다.
   */
  ctx.registerRoute("GET", "/admin/options/categories", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      WITH RECURSIVE tree AS (
        -- path 를 text 로 캐스팅한다. 재귀 CTE 의 컬럼 타입은 **비재귀 항에서
        -- 결정되므로**, name(varchar 200) 으로 두면 재귀 항의 concat 결과(text)와
        -- 타입이 달라 "has type character varying(200) ... but type text overall"
        -- 로 실패한다.
        SELECT id, name, parent_id, 0 AS depth, name::text AS path
        FROM shop_categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.name, c.parent_id, t.depth + 1, t.path || ' > ' || c.name
        FROM shop_categories c JOIN tree t ON c.parent_id = t.id
      )
      SELECT id, name, depth FROM tree ORDER BY path
    `);
    return rows.map((r) => ({
      value: String(r.id),
      label: `${"\u00a0\u00a0".repeat(Number(r.depth))}${String(r.name)}`,
    }));
  });

  /** 리포트 종류와 파라미터 안내 — 화면이 폼을 만드는 데 쓴다 */
  ctx.registerRoute("GET", "/admin/reports", async (req) => {
    requireAdmin(req);
    return {
      timezone: SITE_TZ,
      basis: "결제일(paid_at) 기준입니다. 미결제 주문은 매출에 넣지 않습니다.",
      netFormula: "순매출 = 받은 돈 − 완료된 반품의 환불액",
      note: "신청만 하고 아직 입고되지 않은 반품은 차감하지 않습니다 — 실제로 나간 돈이 아닙니다.",
      reports: [
        { code: "sales", label: "기간별", params: ["from", "to", "groupBy(day|week|month)", "format=csv"] },
        { code: "products", label: "상품별", params: ["from", "to", "sort(net|qty|orders)", "limit", "format=csv"] },
        { code: "categories", label: "분류별", params: ["from", "to", "rollup(true=최상위로 합침)", "format=csv"] },
        { code: "summary", label: "요약 (직전 동일 기간 대비)", params: ["from", "to"] },
      ],
    };
  });

  ctx.registerRoute("GET", "/admin/reports/sales", async (req) => {
    requireAdmin(req);
    const period = parsePeriod(req.query);
    const groupBy = parseGroupBy(req.query.groupBy);
    const result = await salesByPeriod(db, { period, groupBy });
    if (String(req.query.format ?? "") === "csv") {
      return csvReply(
        `sales-${period.from}_${period.to}`,
        ["기간", "주문수", "총매출", "할인", "배송비", "환불", "순매출"],
        result.buckets.map((b) => [b.bucket, b.orders, b.gross, b.discount, b.shipping, b.refunded, b.net]),
      );
    }
    return result;
  });

  ctx.registerRoute("GET", "/admin/reports/products", async (req) => {
    requireAdmin(req);
    const period = parsePeriod(req.query);
    const result = await salesByProduct(db, {
      period,
      sort: req.query.sort as string | undefined,
      limit: Number(req.query.limit ?? 50),
    });
    if (String(req.query.format ?? "") === "csv") {
      return csvReply(
        `products-${period.from}_${period.to}`,
        ["상품명", "분류", "판매수량", "취소수량", "주문수", "총매출", "할인", "환불", "순매출"],
        result.products.map((p) => [
          p.productName, p.categoryName, p.qty, p.cancelledQty,
          p.orders, p.gross, p.discount, p.refunded, p.net,
        ]),
      );
    }
    return result;
  });

  ctx.registerRoute("GET", "/admin/reports/categories", async (req) => {
    requireAdmin(req);
    const period = parsePeriod(req.query);
    const result = await salesByCategory(db, {
      period,
      rollup: String(req.query.rollup ?? "") === "true",
    });
    if (String(req.query.format ?? "") === "csv") {
      return csvReply(
        `categories-${period.from}_${period.to}`,
        ["분류", "판매수량", "주문수", "총매출", "환불", "순매출"],
        result.categories.map((c) => [c.categoryName, c.qty, c.orders, c.gross, c.refunded, c.net]),
      );
    }
    return result;
  });

  ctx.registerRoute("GET", "/admin/reports/summary", async (req) => {
    requireAdmin(req);
    return await salesSummary(db, { period: parsePeriod(req.query) });
  });

  // ════════════════════════════════════════════════════
  //  회원 등급 — 구매 실적에 따른 혜택 (권한이 아니다)
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/grades", async () => {
    // 공개 — "얼마 사면 어떤 혜택"은 손님에게 보여줘야 의미가 있다
    return { items: await listGrades(db), windowMonths: 3 };
  });

  ctx.registerRoute("GET", "/me/grade", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    return await myGrade(db, req.user.id);
  });

  ctx.registerRoute("GET", "/admin/grades", async (req) => {
    requireAdmin(req);
    // 등급별 인원도 보여준다 — 경계를 조정할 때 필요한 정보다
    const grades = await listGrades(db);
    const { rows: counts } = await db.execute(sql`
      SELECT grade_id, count(*) AS n FROM shop_user_grades GROUP BY grade_id
    `);
    const byId = new Map(counts.map((r) => [String(r.grade_id), Number(r.n)]));
    return { items: grades.map((g) => ({ ...g, members: byId.get(g.id) ?? 0 })) };
  });

  ctx.registerRoute("POST", "/admin/grades", async (req) => {
    requireAdmin(req);
    return await createGrade(db, req.body as Record<string, unknown>);
  });

  ctx.registerRoute("PUT", "/admin/grades/:id", async (req) => {
    requireAdmin(req);
    return await updateGrade(db, req.params.id, req.body as Record<string, unknown>);
  });

  ctx.registerRoute("DELETE", "/admin/grades/:id", async (req) => {
    requireAdmin(req);
    return await deleteGrade(db, req.params.id);
  });

  /** 지금 재계산 — 등급을 만들거나 경계를 바꾼 직후 확인하는 데 쓴다 */
  ctx.registerRoute("POST", "/admin/grades/recompute", async (req) => {
    requireAdmin(req);
    return await recomputeGrades(db);
  });

  // 주기 재계산 — 재입고 스윕과 같은 자기 재예약 방식 (ADR-64).
  // 등급은 실시간일 필요가 없다: "이번 기간의 내 등급"으로 안내되는 값이고,
  // 주문 중에 바뀌면 장바구니와 결제 화면의 할인이 달라져 혼란스럽다.
  ctx.queue.process(GRADE_RECOMPUTE_JOB, async () => {
    const result = await recomputeGrades(db);
    if (result.assigned > 0) {
      ctx.logger.log(`회원 등급 재계산: ${result.assigned}명 배정`);
    }
    await ctx.queue.enqueue(GRADE_RECOMPUTE_JOB, {}, { delaySeconds: 21600, maxAttempts: 3 });
  });
  await ctx.queue.enqueue(GRADE_RECOMPUTE_JOB, {}, { delaySeconds: 120, maxAttempts: 3 });

  // ════════════════════════════════════════════════════
  //  기획전 — 상품을 묶어 보여주는 진열
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/collections", async () => {
    return { items: await activeCollections(db) };
  }, { summary: "진행 중 기획전 목록" });

  ctx.registerRoute("GET", "/collections/:slug", async (req) => {
    const c = await viewCollection(db, req.params.slug);
    if (!c) throw new ShopError(404, "기획전을 찾을 수 없습니다.");
    return c;
  });

  ctx.registerRoute("GET", "/admin/collections", async (req) => {
    requireAdmin(req);
    return await listCollectionsAdmin(db, Number(req.query.page ?? 1));
  });
  ctx.registerRoute("POST", "/admin/collections", async (req) => {
    requireAdmin(req);
    const result = await createCollection(db, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return result;
  });
  ctx.registerRoute("PUT", "/admin/collections/:id", async (req) => {
    requireAdmin(req);
    const result = await updateCollection(db, req.params.id, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return result;
  });
  ctx.registerRoute("DELETE", "/admin/collections/:id", async (req) => {
    requireAdmin(req);
    const result = await deleteCollection(db, req.params.id);
    await ctx.cache.invalidateTag("pages");
    return result;
  });

  // ════════════════════════════════════════════════════
  //  쿠폰함 — 발급형 쿠폰
  // ════════════════════════════════════════════════════

  /** 내 쿠폰함 — 지급받은 쿠폰과 사용 가능 여부 */
  ctx.registerRoute("GET", "/me/coupons", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    const { rows } = await db.execute(sql`
      SELECT uc.id, uc.issued_at, uc.used_at, uc.used_order_no,
             c.code, c.name, c.discount_type, c.discount_value, c.min_amount,
             c.max_discount, c.ends_at, c.is_active
      FROM shop_user_coupons uc
      JOIN shop_coupons c ON c.id = uc.coupon_id
      WHERE uc.user_id = ${req.user.id}::uuid
      ORDER BY (uc.used_at IS NOT NULL), c.ends_at NULLS LAST, uc.issued_at DESC
      LIMIT 100
    `);
    const now = Date.now();
    return {
      items: rows.map((r) => {
        const expired = r.ends_at !== null && new Date(r.ends_at as Date).getTime() < now;
        return {
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          discountType: String(r.discount_type),
          discountValue: Number(r.discount_value),
          minAmount: Number(r.min_amount),
          maxDiscount: r.max_discount === null ? null : Number(r.max_discount),
          endsAt: r.ends_at,
          // 상태를 계산해서 준다 — 화면이 "왜 못 쓰는지"를 보여줘야 한다
          status: r.used_at !== null ? "used" : expired ? "expired"
            : r.is_active !== true ? "inactive" : "usable",
          usedAt: r.used_at,
          usedOrderNo: r.used_order_no ? String(r.used_order_no) : null,
        };
      }),
    };
  });

  /**
   * 쿠폰 발급 (관리자) — 특정 회원들 또는 등급 전체에.
   *
   * 이미 지급된 회원은 조용히 건너뛴다(ON CONFLICT DO NOTHING) — "골드 전체에
   * 발급"을 두 번 누르면 두 장씩 가는 것이 아니라 빠진 사람만 채워져야 한다.
   */
  ctx.registerRoute("POST", "/admin/coupons/:id/issue", async (req) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as { emails?: string[]; gradeId?: string; all?: boolean };

    const { rows: coupon } = await db.execute(sql`
      SELECT id, requires_issue FROM shop_coupons WHERE id = ${req.params.id}::uuid LIMIT 1
    `);
    if (!coupon[0]) throw new ShopError(404, "쿠폰을 찾을 수 없습니다.");
    // 코드형 쿠폰의 "발급"은 의미가 없다 — 코드만 알면 누구나 쓰므로,
    // 발급했다고 믿은 통제가 실제로는 없는 것이 된다
    if (coupon[0].requires_issue !== true) {
      throw new ShopError(400, "발급형 쿠폰이 아닙니다. 쿠폰 설정에서 '발급형'을 켜세요.");
    }

    let targets: string;
    if (Array.isArray(b.emails) && b.emails.length) {
      if (b.emails.length > 1000) throw new ShopError(400, "한 번에 1,000명까지 지급할 수 있습니다.");
      const list = sql.join(b.emails.map((e) => sql`${String(e).toLowerCase()}`), sql`, `);
      targets = "emails";
      const { rows } = await db.execute(sql`
        INSERT INTO shop_user_coupons (id, coupon_id, user_id)
        SELECT gen_random_uuid(), ${req.params.id}::uuid, u.id
        FROM users u
        WHERE lower(u.email) IN (${list})
          AND u.is_active = true AND u.withdrawn_at IS NULL
        ON CONFLICT (coupon_id, user_id) DO NOTHING
        RETURNING id
      `);
      return { issued: rows.length, targets };
    }
    if (b.gradeId) {
      const { rows } = await db.execute(sql`
        INSERT INTO shop_user_coupons (id, coupon_id, user_id)
        SELECT gen_random_uuid(), ${req.params.id}::uuid, ug.user_id
        FROM shop_user_grades ug
        WHERE ug.grade_id = ${String(b.gradeId)}::uuid
        ON CONFLICT (coupon_id, user_id) DO NOTHING
        RETURNING id
      `);
      return { issued: rows.length, targets: "grade" };
    }
    if (b.all === true) {
      const { rows } = await db.execute(sql`
        INSERT INTO shop_user_coupons (id, coupon_id, user_id)
        SELECT gen_random_uuid(), ${req.params.id}::uuid, u.id
        FROM users u
        WHERE u.is_active = true AND u.withdrawn_at IS NULL
        ON CONFLICT (coupon_id, user_id) DO NOTHING
        RETURNING id
      `);
      return { issued: rows.length, targets: "all" };
    }
    throw new ShopError(400, "emails, gradeId, all 중 하나를 지정해주세요.");
  });

  /** 등급 선택지 — 쿠폰 폼의 grade_id 필드가 읽는다 */
  ctx.registerRoute("GET", "/admin/options/grades", async (req) => {
    requireAdmin(req);
    const grades = await listGrades(db);
    return grades.map((g) => ({
      value: g.id,
      label: `${g.name} (${g.minAmount.toLocaleString("ko-KR")}원~)`,
    }));
  });

  // ════════════════════════════════════════════════════
  //  재입고 알림
  // ════════════════════════════════════════════════════
  //
  // 품절 상품을 찾아온 손님에게 지금은 할 수 있는 것이 없다 — 그 손님은
  // 다시 오지 않고, 팔 수 있었던 것을 못 판다.

  ctx.registerRoute("POST", "/products/:slug/restock-alert", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await requestRestockAlert(db, {
      productSlug: req.params.slug,
      optionId: b.optionId ? String(b.optionId) : null,
      email: b.email ? String(b.email) : undefined,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
      ip: req.ip,
    });
    return {
      ...result,
      // 주소를 그대로 되돌려주지 않는다 — 남의 주소로 신청했는지 확인하는
      // 수단이 되면 안 된다
      email: maskEmail(result.email),
      notice: "재입고되면 1회 알려드립니다. 광고 메일이 아닙니다.",
    };
  });

  /** 내 신청 목록 */
  ctx.registerRoute("GET", "/me/restock-alerts", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    return await listMyRestockAlerts(db, req.user.id);
  });

  /** 해지 — 로그인 없이 토큰으로 (비회원도 신청할 수 있다) */
  ctx.registerRoute("POST", "/restock-alerts/cancel/:token", async (req) => {
    await cancelRestockAlert(db, req.params.token);
    return { ok: true, message: "재입고 알림이 해지되었습니다." };
  });

  /** 어떤 상품을 기다리는 사람이 많은지 — 재입고 우선순위의 근거 */
  ctx.registerRoute("GET", "/admin/restock-demand", async (req) => {
    requireAdmin(req);
    return await listRestockDemand(db, { page: Number(req.query.page ?? 1) });
  });

  /**
   * 재입고 스윕을 지금 돌린다 (관리자).
   *
   * 정기 스윕을 기다리지 않고 확인하고 싶을 때 쓴다. 재입고 직후 운영자가
   * "알림이 갔나"를 확인할 방법이 없으면 불안해서 수동으로 메일을 보낸다.
   */
  ctx.registerRoute("POST", "/admin/restock-sweep", async (req) => {
    requireAdmin(req);
    return await runRestockSweep();
  });

  /**
   * 재입고 스윕.
   *
   * 재고가 오르는 지점이 여러 곳(반품·취소·관리자 수정·이전 도구)이라
   * 각각에 알림을 붙이면 반드시 하나를 빠뜨린다. 주기적으로 "대기자가 있는데
   * 재고가 있는 조합"을 찾으면 경로와 무관하게 잡힌다 (restock.ts).
   */
  const runRestockSweep = async (): Promise<{ groups: number; sent: number; failed: number }> => {
    const targets = await sweepRestock(db);
    if (!targets.length) return { groups: 0, sent: 0, failed: 0 };

    const siteName = await ctx.site.name();
    let sent = 0;
    let failed = 0;
    for (const t of targets) {
      const result = await sendRestockNotifications(db, {
        productId: t.productId,
        optionId: t.optionId,
        siteUrl: ctx.site.url,
        siteName,
        send: (msg) => ctx.mail.send(msg),
        log: (m) => ctx.logger.warn(m),
      });
      sent += result.sent;
      failed += result.failed;
    }
    return { groups: targets.length, sent, failed };
  };

  // 큐 워커가 스윕을 돌리고 **스스로 다시 예약한다.**
  //
  // 큐에는 반복 실행 기능이 없다. setInterval 을 쓰면 플러그인을 비활성화해도
  // 계속 돌고, 서버가 여러 대면 모두가 돌아서 같은 일을 중복한다.
  // 큐를 쓰면 잡이 한 워커에서만 실행된다.
  ctx.queue.process(RESTOCK_QUEUE_JOB, async () => {
    const result = await runRestockSweep();
    if (result.sent > 0 || result.failed > 0) {
      ctx.logger.log(`재입고 알림: ${result.sent}건 발송, ${result.failed}건 실패`);
    }
    // 다음 스윕을 예약한다. 실패해도 큐가 재시도하므로 사슬이 끊기지 않는다.
    await ctx.queue.enqueue(RESTOCK_QUEUE_JOB, {}, { delaySeconds: 300, maxAttempts: 3 });
  });
  // 활성화 직후 한 번 예약한다 (이미 예약된 것이 있어도 스윕은 멱등하다)
  await ctx.queue.enqueue(RESTOCK_QUEUE_JOB, {}, { delaySeconds: 60, maxAttempts: 3 });

  // ════════════════════════════════════════════════════
  //  정기결제 — 카드는 PG 에, 해지는 한 클릭에 (subscriptions.ts)
  // ════════════════════════════════════════════════════

  const requireMember = (req: { user?: { id: string } | null }): string => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    return req.user.id;
  };

  /** 정기결제를 지원하는 결제수단 (카드 등록 화면이 조회) */
  ctx.registerRoute("GET", "/billing/providers", async () => {
    return { providers: listBillingProviders() };
  });

  /**
   * 카드 등록 준비 — PG 위젯에 넘길 고객 식별자를 발급한다.
   * 회원 id 를 그대로 쓰지 않는다: PG 에 넘어가는 값에 내부 식별자를 싣지 않는다.
   */
  ctx.registerRoute("POST", "/me/billing-keys/prepare", async (req) => {
    requireMember(req);
    return { customerKey: `cust-${uuidv7().replace(/-/g, "")}` };
  });

  ctx.registerRoute("POST", "/me/billing-keys", async (req) => {
    const userId = requireMember(req);
    const b = req.body as Record<string, unknown>;
    return await issueBillingKey(db, {
      userId,
      provider: String(b.provider ?? ""),
      authKey: String(b.authKey ?? ""),
      customerKey: String(b.customerKey ?? ""),
    });
  });

  ctx.registerRoute("GET", "/me/billing-keys", async (req) => {
    const userId = requireMember(req);
    return { items: await listBillingKeys(db, userId) };
  });

  ctx.registerRoute("DELETE", "/me/billing-keys/:id", async (req) => {
    const userId = requireMember(req);
    return await revokeBillingKey(db, { userId, keyId: req.params.id });
  });

  /** 가입 — 첫 회차를 즉시 결제한다. 실패하면 가입도 없다 */
  ctx.registerRoute("POST", "/subscriptions", async (req) => {
    const userId = requireMember(req);
    const b = req.body as Record<string, unknown>;
    return await subscribe(db, {
      userId,
      productSlug: String(b.productSlug ?? b.product_slug ?? ""),
      quantity: b.quantity === undefined ? 1 : Number(b.quantity),
      billingKeyId: String(b.billingKeyId ?? b.billing_key_id ?? ""),
      orderer: (b.orderer ?? {}) as Parameters<typeof subscribe>[1]["orderer"],
      settings: await settings(),
      pointsPort: pointsPort(),
    });
  });

  ctx.registerRoute("GET", "/me/subscriptions", async (req) => {
    const userId = requireMember(req);
    return { items: await listMySubscriptions(db, userId) };
  });

  ctx.registerRoute("GET", "/me/subscriptions/:id/events", async (req) => {
    const userId = requireMember(req);
    return { items: await subscriptionEvents(db, req.params.id, userId) };
  });

  /** 해지 — 항상, 즉시, 조건 없이. 확인 절차를 여기에 쌓지 않는다 */
  ctx.registerRoute("POST", "/me/subscriptions/:id/cancel", async (req) => {
    const userId = requireMember(req);
    return await cancelSubscription(db, { id: req.params.id, userId, actor: "member" });
  });

  ctx.registerRoute("POST", "/me/subscriptions/:id/resume", async (req) => {
    const userId = requireMember(req);
    const b = req.body as Record<string, unknown>;
    return await resumeSubscription(db, {
      id: req.params.id,
      userId,
      billingKeyId: b.billingKeyId ? String(b.billingKeyId) : null,
    });
  });

  ctx.registerRoute("GET", "/admin/subscriptions", async (req) => {
    requireAdmin(req);
    return await listSubscriptionsAdmin(db, Number(req.query.page ?? 1));
  });

  /** 관리자 해지 (CS 전화 요청 등) — 삭제가 아니라 청구 중단이고, 이력은 남는다 */
  ctx.registerRoute("DELETE", "/admin/subscriptions/:id", async (req) => {
    requireAdmin(req);
    return await cancelSubscription(db, { id: req.params.id, actor: "admin" });
  });

  const runSubscriptionSweep = async () => {
    return await chargeDueSubscriptions(db, {
      settings: await settings(),
      pointsPort: pointsPort(),
      notify: (msg) => ctx.mail.send({ to: msg.email, subject: msg.subject, text: msg.text }),
      log: (m) => ctx.logger.warn(m),
    });
  };

  /** 수동 스윕 (운영·테스트용) — 주기 스윕과 같은 코드를 돈다 */
  ctx.registerRoute("POST", "/admin/subscriptions/sweep", async (req) => {
    requireAdmin(req);
    return await runSubscriptionSweep();
  });

  // 회차 청구도 재입고와 같은 자기 재예약 큐 잡이다 — 한 워커에서만 돌고,
  // 플러그인을 비활성화하면 함께 멈춘다. setInterval 은 둘 다 못 한다.
  ctx.queue.process(SUBSCRIPTION_QUEUE_JOB, async () => {
    const result = await runSubscriptionSweep();
    if (result.due > 0) {
      ctx.logger.log(
        `정기결제: 대상 ${result.due} · 성공 ${result.charged} · 실패 ${result.failed} · 중지 ${result.paused}`,
      );
    }
    await ctx.queue.enqueue(SUBSCRIPTION_QUEUE_JOB, {}, { delaySeconds: 600, maxAttempts: 3 });
  });
  await ctx.queue.enqueue(SUBSCRIPTION_QUEUE_JOB, {}, { delaySeconds: 90, maxAttempts: 3 });

  // ── 생일 쿠폰 자동 지급 (birthday.ts) ────────────────
  // 지급이 멱등하므로(쿠폰당 회원당 1회) 넉넉히 자주 돌아도 안전하다 —
  // 자정 근처 한 번만 돌리려는 정밀함은 서버가 그 시각에 꺼져 있으면
  // 그날 생일자를 통째로 놓친다.
  ctx.registerRoute("POST", "/admin/coupons/birthday-sweep", async (req) => {
    requireAdmin(req);
    return await issueBirthdayCoupons(db);
  });
  ctx.queue.process(BIRTHDAY_QUEUE_JOB, async () => {
    const result = await issueBirthdayCoupons(db);
    if (result.issued > 0) ctx.logger.log(`생일 쿠폰: ${result.issued}장 지급`);
    await ctx.queue.enqueue(BIRTHDAY_QUEUE_JOB, {}, { delaySeconds: 6 * 3600, maxAttempts: 3 });
  });
  await ctx.queue.enqueue(BIRTHDAY_QUEUE_JOB, {}, { delaySeconds: 120, maxAttempts: 3 });

  // ════════════════════════════════════════════════════
  //  개인결제 (주문서 없는 청구)
  // ════════════════════════════════════════════════════
  //
  // 전화·상담으로 주문받고 금액만 청구한다. 결제하면 **주문을 만든다** —
  // 주문 없는 결제는 매출 집계와 세금 신고에서 빠진다 (direct-payment.ts).

  ctx.registerRoute("POST", "/admin/payment-requests", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    const result = await createPaymentRequest(db, {
      title: String(b.title ?? ""),
      description: b.description ? String(b.description) : undefined,
      amount: Number(b.amount ?? 0),
      expireDays: b.expireDays === undefined ? undefined : Number(b.expireDays),
      customerName: b.customerName ? String(b.customerName) : undefined,
      customerPhone: b.customerPhone ? String(b.customerPhone) : undefined,
      customerEmail: b.customerEmail ? String(b.customerEmail) : undefined,
      memo: b.memo ? String(b.memo) : undefined,
      createdBy: req.user!.id,
    });
    return {
      ...result,
      // 손님에게 보낼 링크. 토큰이 그대로 들어가므로 관리자에게만 보인다.
      payPath: `/shop/pay/${result.token}`,
    };
  });

  ctx.registerRoute("GET", "/admin/payment-requests", async (req) => {
    requireAdmin(req);
    return await listPaymentRequests(db, {
      status: req.query.status ? String(req.query.status) : undefined,
      page: Number(req.query.page ?? 1),
    });
  });

  ctx.registerRoute("PUT", "/admin/payment-requests/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    if (String(b.status ?? "") !== "cancelled") {
      throw new ShopError(400, "청구서는 취소만 할 수 있습니다. 금액을 바꾸려면 새로 청구하세요.");
    }
    return await cancelPaymentRequest(db, {
      id: req.params.id,
      reason: b.reason ? String(b.reason) : undefined,
    });
  });

  /** 손님이 보는 청구서 — 로그인 불필요 (전화 주문 손님이 회원일 이유가 없다) */
  ctx.registerRoute("GET", "/pay/:token", async (req) => {
    return await viewPaymentRequest(db, req.params.token);
  });

  /**
   * 결제 준비 — 청구서로 주문을 만든다.
   *
   * 이후 결제는 **일반 주문과 같은 경로**(`/payments/confirm`)를 쓴다.
   * 별도 경로를 만들면 금액 위조 방어를 두 번 구현해야 한다.
   */
  ctx.registerRoute("POST", "/pay/:token/prepare", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return await prepareOrderForRequest(db, {
      token: req.params.token,
      userId: req.user?.id ?? null,
      ordererName: b.ordererName ? String(b.ordererName) : undefined,
      ordererPhone: b.ordererPhone ? String(b.ordererPhone) : undefined,
      ordererEmail: b.ordererEmail ? String(b.ordererEmail) : undefined,
    });
  });

  // ════════════════════════════════════════════════════
  //  세금 증빙 — 현금영수증 · 세금계산서 · 부가세 신고
  // ════════════════════════════════════════════════════

  /** 발급 안내 — 화면이 폼을 만들고 손님에게 설명하는 데 쓴다 */
  ctx.registerRoute("GET", "/tax/info", async () => ({
    receiptKinds: RECEIPT_KINDS.map((code) => ({ code, label: RECEIPT_KIND_LABEL[code] })),
    gateways: listCashReceiptGateways().map((g) => ({ code: g.provider, label: g.displayName })),
    notice:
      "카드 결제는 카드사가 국세청에 자동 통보하므로 현금영수증을 발급하지 않습니다. " +
      "무통장 입금 주문에 발급할 수 있습니다.",
    legalBasis: "부가가치세법 제32조의2 · 제46조",
  }));

  /** 손님이 자기 주문에 현금영수증을 신청한다 */
  ctx.registerRoute("POST", "/orders/:orderNo/cash-receipt", async (req) => {
    const b = req.body as Record<string, unknown>;
    return await requestCashReceipt(db, {
      orderNo: req.params.orderNo,
      kind: String(b.kind ?? ""),
      identifier: String(b.identifier ?? ""),
      userId: req.user?.id ?? null,
      isManager: isManager(req),
      gateway: b.gateway ? String(b.gateway) : undefined,
      isValidBusinessNo,
    });
  });

  /** 내 주문의 발급 내역 */
  ctx.registerRoute("GET", "/orders/:orderNo/cash-receipt", async (req) => {
    const { rows } = await db.execute(sql`
      SELECT id, user_id FROM shop_orders WHERE order_no = ${req.params.orderNo} LIMIT 1
    `);
    const order = rows[0];
    // 남의 주문이 존재하는지 알려주지 않는다
    if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");
    if (!isManager(req)) {
      if (!req.user || String(order.user_id ?? "") !== req.user.id) {
        throw new ShopError(404, "주문을 찾을 수 없습니다.");
      }
    }
    return await listCashReceipts(db, { orderId: String(order.id) });
  });

  /** 손님이 세금계산서를 요청한다 */
  ctx.registerRoute("POST", "/orders/:orderNo/tax-invoice", async (req) => {
    return await requestTaxInvoice(db, {
      orderNo: req.params.orderNo,
      userId: req.user?.id ?? null,
      isManager: isManager(req),
      body: (req.body ?? {}) as Record<string, unknown>,
      isValidBusinessNo,
    });
  });

  ctx.registerRoute("GET", "/admin/cash-receipts", async (req) => {
    requireAdmin(req);
    return await listCashReceipts(db, {
      status: req.query.status ? String(req.query.status) : undefined,
      page: Number(req.query.page ?? 1),
    });
  });

  /** 수동 발급 완료 처리 — 운영자가 홈택스에서 발급하고 승인번호를 적는다 */
  ctx.registerRoute("PUT", "/admin/cash-receipts/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    const status = String(b.status ?? "");
    if (status === "issued") {
      return await markCashReceiptIssued(db, {
        id: req.params.id,
        approvalNo: String(b.approvalNo ?? ""),
        receiptUrl: b.receiptUrl ? String(b.receiptUrl) : undefined,
      });
    }
    if (status === "cancelled") {
      return await cancelCashReceipt(db, {
        id: req.params.id,
        reason: String(b.reason ?? "운영자 취소"),
      });
    }
    throw new ShopError(400, "상태는 issued 또는 cancelled 여야 합니다.");
  });

  ctx.registerRoute("GET", "/admin/tax-invoices", async (req) => {
    requireAdmin(req);
    return await listTaxInvoices(db, {
      status: req.query.status ? String(req.query.status) : undefined,
      page: Number(req.query.page ?? 1),
    });
  });

  ctx.registerRoute("PUT", "/admin/tax-invoices/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    return await updateTaxInvoice(db, {
      id: req.params.id,
      status: String(b.status ?? ""),
      invoiceNo: b.invoiceNo ? String(b.invoiceNo) : undefined,
      invoiceUrl: b.invoiceUrl ? String(b.invoiceUrl) : undefined,
      reason: b.reason ? String(b.reason) : undefined,
    });
  });

  /** 부가세 신고용 과세기간 목록 — 운영자가 날짜를 계산하지 않게 한다 */
  ctx.registerRoute("GET", "/admin/reports/vat/periods", async (req) => {
    requireAdmin(req);
    const thisYear = new Date().getFullYear();
    return {
      years: [thisYear, thisYear - 1, thisYear - 2],
      periods: VAT_PERIODS.map((p) => ({ code: p.code, label: p.label })),
    };
  });

  ctx.registerRoute("GET", "/admin/reports/vat", async (req) => {
    requireAdmin(req);
    const year = Math.floor(Number(req.query.year ?? new Date().getFullYear()));
    const period = String(req.query.period ?? "1-full");
    const result = await vatReport(db, { year, period, timezone: SITE_TZ });
    if (String(req.query.format ?? "") === "csv") {
      return csvReply(
        `vat-${result.year}-${result.period}`,
        ["증빙 구분", "주문수", "합계", "과세분", "공급가액", "부가세", "면세금액"],
        result.groups.map((g) => [
          g.label, g.orders, g.total, g.taxable, g.supplyAmount, g.vatAmount, g.taxFreeAmount,
        ]),
      );
    }
    return result;
  });


  // ════════════════════════════════════════════════════
  //  상품 후기 · 문의 (공개)
  // ════════════════════════════════════════════════════

  /** 로그인 필수 — 후기·문의는 익명 허용하지 않는다 (구매 검증과 책임 추적) */
  const requireLogin = (req: { user: { id: string; displayName?: string } | null }) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    return req.user;
  };
  const isManager = (req: { user: { role: string } | null }) =>
    req.user?.role === "admin" || req.user?.role === "manager";

  ctx.registerRoute("GET", "/products/:id/reviews", async (req) => {
    return await listReviews(db, {
      productId: req.params.id,
      page: Number(req.query.page ?? 1),
      viewerId: req.user?.id ?? null,
      isManager: isManager(req),
    });
  });

  /** 후기 작성 가능 여부 — 화면이 폼을 보여줄지 결정하는 데 쓴다 */
  ctx.registerRoute("GET", "/products/:id/reviews/eligibility", async (req) => {
    if (!req.user) return { canWrite: false, reason: "login" };
    const orderNo = await findPurchase(db, { productId: req.params.id, userId: req.user.id });
    if (!orderNo) return { canWrite: false, reason: "not_purchased" };
    const { rows } = await db.execute(sql`
      SELECT id FROM shop_reviews
      WHERE product_id = ${req.params.id}::uuid AND user_id = ${req.user.id}::uuid LIMIT 1
    `);
    if (rows.length) return { canWrite: false, reason: "already_written", reviewId: rows[0].id };
    return { canWrite: true, reason: null };
  });

  ctx.registerRoute("POST", "/products/:id/reviews", async (req) => {
    const user = requireLogin(req);
    const result = await createReview(db, {
      productId: req.params.id,
      userId: user.id,
      authorName: String(user.displayName ?? "회원").slice(0, 100),
      input: req.body as never,
    });
    await ctx.cache.invalidateTag("pages");
    // 후기 작성 포인트 — brick-point가 설치되어 있으면 적립된다
    await ctx.hooks.doAction("shop.review.created", {
      reviewId: result.id, productId: req.params.id, authorId: user.id,
    });
    return { id: result.id };
  });

  ctx.registerRoute("PUT", "/reviews/:id", async (req) => {
    const user = requireLogin(req);
    await updateReview(db, {
      reviewId: req.params.id, userId: user.id, isManager: isManager(req),
      input: req.body as never,
    });
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/reviews/:id", async (req) => {
    const user = requireLogin(req);
    await deleteReview(db, { reviewId: req.params.id, userId: user.id, isManager: isManager(req) });
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("GET", "/products/:id/inquiries", async (req) => {
    return await listInquiries(db, {
      productId: req.params.id,
      page: Number(req.query.page ?? 1),
      viewerId: req.user?.id ?? null,
      isManager: isManager(req),
    });
  });

  ctx.registerRoute("POST", "/products/:id/inquiries", async (req) => {
    const user = requireLogin(req);
    const result = await createInquiry(db, {
      productId: req.params.id,
      userId: user.id,
      authorName: String(user.displayName ?? "회원").slice(0, 100),
      input: req.body as never,
    });
    await ctx.cache.invalidateTag("pages");
    await ctx.hooks.doAction("shop.inquiry.created", {
      inquiryId: result.id, productId: req.params.id, authorId: user.id,
    });
    return { id: result.id };
  });

  ctx.registerRoute("DELETE", "/inquiries/:id", async (req) => {
    const user = requireLogin(req);
    await deleteInquiry(db, { inquiryId: req.params.id, userId: user.id, isManager: isManager(req) });
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 관리자: 후기 ────────────────────────────────────
  ctx.registerRoute("GET", "/admin/reviews", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT r.id, r.rating, r.content, r.admin_reply, r.is_visible, r.created_at,
             r.author_name, (r.order_no IS NOT NULL) AS verified, p.name AS product_name
      FROM shop_reviews r JOIN shop_products p ON p.id = r.product_id
      ORDER BY r.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_reviews`);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: 30 };
  });

  ctx.registerRoute("PUT", "/admin/reviews/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    await replyToReview(db, req.params.id, String(b.admin_reply ?? ""));
    await setReviewVisible(db, req.params.id, b.is_visible !== false);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/reviews/:id", async (req) => {
    requireAdmin(req);
    await deleteReview(db, { reviewId: req.params.id, userId: req.user!.id, isManager: true });
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 관리자: 문의 ────────────────────────────────────
  ctx.registerRoute("GET", "/admin/inquiries", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT q.id, q.title, q.content, q.is_secret, q.status, q.admin_reply, q.created_at,
             q.author_name, p.name AS product_name
      FROM shop_inquiries q JOIN shop_products p ON p.id = q.product_id
      ORDER BY (q.status = 'open') DESC, q.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_inquiries`);
    return {
      items: rows.map((q) => ({
        ...q,
        status_label: q.status === "answered" ? "답변완료" : "미답변",
      })),
      total: Number(cnt[0]?.n ?? 0),
      page,
      pageSize: 30,
    };
  });

  ctx.registerRoute("PUT", "/admin/inquiries/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    await replyToInquiry(db, req.params.id, String(b.admin_reply ?? ""));
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/inquiries/:id", async (req) => {
    requireAdmin(req);
    await deleteInquiry(db, { inquiryId: req.params.id, userId: req.user!.id, isManager: true });
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });


  // ════════════════════════════════════════════════════
  //  취소 · 반품 · 교환
  //
  //  전자상거래법 제17조: 소비자는 상품을 받은 날부터 7일 안에 청약철회를 할 수
  //  있고, 사업자는 이를 거부할 수 없다. 편의 기능이 아니라 법적 요건이다.
  // ════════════════════════════════════════════════════

  /** 반품·교환 사유 목록 — 화면이 선택지를 만들 때 쓴다 */
  ctx.registerRoute("GET", "/returns/reasons", async () => ({
    items: Object.entries(REASON_CODES).map(([code, v]) => ({
      code,
      label: v.label,
      // 누가 반송비를 내는지 **미리** 알려준다. 나중에 환불액이 깎여 있으면 분쟁이 된다
      shippingPayer: v.payer,
    })),
    kinds: RETURN_KINDS.map((k) => ({ code: k, label: KIND_LABEL[k] })),
  }));

  /** 이 주문에서 무엇을 얼마나 신청할 수 있는가 */
  ctx.registerRoute("GET", "/orders/:orderNo/returnable", async (req) => {
    const view = await getReturnable(db, { orderNo: req.params.orderNo, viewer: req.user });
    const s = await settings();
    return {
      items: view.items,
      allowedKinds: view.allowedKinds.map((k) => ({ code: k, label: KIND_LABEL[k] })),
      withdrawalDeadline: view.withdrawalDeadline,
      withdrawalExpired: view.withdrawalExpired,
      returnShippingFee: s.returnShippingFee,
      orderStatus: view.order.status,
    };
  });

  ctx.registerRoute("POST", "/orders/:orderNo/returns", async (req) => {
    const s = await settings();
    const result = await requestReturn(db, {
      orderNo: req.params.orderNo,
      input: req.body as never,
      viewer: req.user,
      settings: { returnShippingFee: s.returnShippingFee },
    });
    await ctx.hooks.doAction("shop.return.requested", {
      returnId: result.id, returnNo: result.returnNo, orderNo: req.params.orderNo,
      userId: req.user?.id ?? null,
    });
    return result;
  });

  ctx.registerRoute("GET", "/my/returns", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    return await listMyReturns(db, req.user.id, Number(req.query.page ?? 1));
  });

  ctx.registerRoute("GET", "/returns/:id", async (req) => {
    return await getReturn(db, { returnId: req.params.id, viewer: req.user });
  });

  /** 고객이 요청을 철회 (처리 시작 전에만) */
  ctx.registerRoute("POST", "/returns/:id/cancel", async (req) => {
    await cancelRequest(db, { returnId: req.params.id, viewer: req.user });
    return { ok: true };
  });

  // ── 관리자 ──────────────────────────────────────────
  ctx.registerRoute("GET", "/admin/returns", async (req) => {
    requireAdmin(req);
    return await listAllReturns(db, {
      page: Number(req.query.page ?? 1),
      status: req.query.status,
      kind: req.query.kind,
    });
  });

  ctx.registerRoute("PUT", "/admin/returns/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Record<string, unknown>;
    const result = await updateReturnStatus(db, {
      returnId: req.params.id,
      status: String(b.status ?? ""),
      actorId: req.user!.id,
      note: b.admin_note === undefined ? undefined : String(b.admin_note),
      rejectReason: b.reject_reason === undefined ? undefined : String(b.reject_reason),
      pickupTrackingNo: b.pickup_tracking_no === undefined ? undefined : String(b.pickup_tracking_no),
      exchangeTrackingNo: b.exchange_tracking_no === undefined ? undefined : String(b.exchange_tracking_no),
      // 실제 환불은 결제 모듈이 한다 — 금액 검증과 PG 호출이 거기 있다
      refund: async (orderNo, amount, reason) => {
        await refundPayment(db, {
          orderNo, amount, reason, actorId: req.user!.id, pointsPort: pointsPort(),
        });
      },
      pointsPort: pointsPort(),
    });

    if (result.status === "completed" || result.status === "rejected") {
      await ctx.hooks.doAction("shop.return.resolved", {
        returnId: req.params.id, status: result.status, refunded: result.refunded,
      });
    }
    await ctx.cache.invalidateTag("pages");
    return result;
  });


  // ════════════════════════════════════════════════════
  //  위시리스트 · 최근 본 상품
  //
  //  비회원도 쓸 수 있다. "담아두다가 나중에 가입"이 실제 흐름이고,
  //  로그인을 요구하면 아무도 쓰지 않는다 (장바구니와 같은 판단).
  // ════════════════════════════════════════════════════

  /** 위시리스트 소유자 — 회원 우선, 비회원은 장바구니와 같은 토큰을 쓴다 */
  const wishOwner = (req: {
    user: { id: string } | null;
    query: Record<string, string>;
    body?: unknown;
  }): WishOwner =>
    req.user
      ? { userId: req.user.id }
      : {
          guestToken:
            (req.body as { guestToken?: string } | undefined)?.guestToken ??
            req.query.guest ??
            null,
        };

  ctx.registerRoute("GET", "/wishlist", async (req) => {
    const owner = wishOwner(req);
    if (!owner.userId && !owner.guestToken) return { items: [], total: 0 };
    return await listWishlist(db, owner);
  });

  ctx.registerRoute("POST", "/wishlist", async (req) => {
    const body = req.body as { productId?: string };
    if (!body?.productId) throw new ShopError(400, "상품을 지정해주세요.");
    const result = await addToWishlist(db, {
      owner: wishOwner(req),
      productId: String(body.productId),
    });
    return { ok: true, added: result.added, guestToken: result.guestToken };
  });

  ctx.registerRoute("DELETE", "/wishlist/:productId", async (req) => {
    await removeFromWishlist(db, {
      owner: wishOwner(req),
      productId: req.params.productId,
    });
    return { ok: true };
  });

  /** 하트 상태 — 목록 화면이 여러 상품을 한 번에 물어본다 */
  ctx.registerRoute("GET", "/wishlist/check", async (req) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      .slice(0, 100);
    return { ids: await isInWishlist(db, { owner: wishOwner(req), productIds: ids }) };
  });

  ctx.registerRoute("GET", "/recent-views", async (req) => {
    const owner = wishOwner(req);
    if (!owner.userId && !owner.guestToken) return { items: [] };
    return await listRecentViews(db, owner, Number(req.query.limit ?? 10));
  });

  /**
   * 로그인 후 비회원 데이터 이어받기.
   *
   * 클라이언트가 로그인 직후 호출한다. 이게 없으면 "담아두고 가입했더니
   * 사라졌다"가 되어 비회원 허용의 의미가 없어진다.
   */
  ctx.registerRoute("POST", "/wishlist/merge", async (req) => {
    if (!req.user) throw new ShopError(401, "로그인이 필요합니다.");
    const token = String((req.body as { guestToken?: string })?.guestToken ?? "");
    if (!token) return { merged: 0 };
    const merged = await mergeGuestWishlist(db, { userId: req.user.id, guestToken: token });
    await mergeGuestViews(db, { userId: req.user.id, guestToken: token });
    return { merged };
  });

  // ── 지역별 배송비 ───────────────────────────────────

  /** 우편번호로 추가 배송비 조회 — 주문서가 금액을 미리 보여주는 데 쓴다 */
  ctx.registerRoute("GET", "/shipping-zone", async (req) => {
    const zone = await findZoneFee(db, String(req.query.postcode ?? ""));
    return zone ?? { name: null, extraFee: 0 };
  });

  ctx.registerRoute("GET", "/admin/shipping-zones", async (req) => {
    requireAdmin(req);
    return await listZones(db);
  });

  ctx.registerRoute("POST", "/admin/shipping-zones", async (req) => {
    requireAdmin(req);
    const result = await createZone(db, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return result;
  });

  ctx.registerRoute("PUT", "/admin/shipping-zones/:id", async (req) => {
    requireAdmin(req);
    await updateZone(db, req.params.id, req.body as Record<string, unknown>);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/shipping-zones/:id", async (req) => {
    requireAdmin(req);
    await deleteZone(db, req.params.id);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  // ── 쇼핑몰 설정 ─────────────────────────────────────
  ctx.registerRoute("GET", "/admin/settings", async (req) => {
    requireAdmin(req);
    return await settings();
  });

  ctx.registerRoute("PUT", "/admin/settings", async (req) => {
    requireAdmin(req);
    const b = req.body as Partial<ShopSettings>;
    const next: ShopSettings = {
      shippingFee: Math.max(0, Math.floor(Number(b.shippingFee ?? DEFAULT_SETTINGS.shippingFee))),
      freeShippingOver: Math.max(0, Math.floor(Number(b.freeShippingOver ?? DEFAULT_SETTINGS.freeShippingOver))),
      bankAccount: String(b.bankAccount ?? "").slice(0, 200),
      pageSize: Math.min(60, Math.max(4, Math.floor(Number(b.pageSize ?? DEFAULT_SETTINGS.pageSize)))),
      returnShippingFee: Math.max(0, Math.floor(Number(b.returnShippingFee ?? DEFAULT_SETTINGS.returnShippingFee))),
    };
    await ctx.settings.set("settings", next);
    await ctx.cache.invalidateTag("pages");
    return next;
  });

  // ════════════════════════════════════════════════════
  //  관리자 화면 선언 + 스토어프론트 블록
  // ════════════════════════════════════════════════════
  /**
   * 회원 탈퇴 시 커머스 데이터 처리.
   *
   * 여기가 파기 의무와 보존 의무가 충돌하는 지점이다:
   *   개인정보보호법 제21조 — 목적 달성 후 지체 없이 파기
   *   전자상거래법 제6조   — 계약·결제·배송 기록은 5년 보존
   *
   * 둘 다 지키는 방법은 하나뿐이다. **개인을 지우고 거래를 남긴다.**
   * 주문 행은 남기되 회원 연결을 끊는다. 주문 안의 수령인 정보는 보존 의무의
   * 대상이므로 지우지 않는다 — 반품·분쟁·세무 조사에 필요하고, 지우면
   * 사업자가 법을 위반한다.
   */
  ctx.registerDataEraser({
    label: "쇼핑몰",
    order: 30,
    async erase({ tx, userId }) {
      const done: string[] = [];

      // 재입고 알림 신청 — 보존 의무가 없다
      done.push(...(await eraseRestockAlerts(tx, userId)));
      // 등급 배정 — 실적 원본(주문)이 남으므로 배정만 지우면 된다
      done.push(...(await eraseGrade(tx, userId)));
      // 쿠폰함 — 보존 의무가 없다
      const { rows: wallet } = await tx.execute(sql`
        DELETE FROM shop_user_coupons WHERE user_id = ${userId}::uuid RETURNING id
      `);
      if (wallet.length) done.push(`쿠폰함 ${wallet.length}장 삭제`);

      // 장바구니는 구매 전 데이터 — 보존 의무가 없다.
      // 소유자는 shop_carts 에 있다 (shop_cart_items 에는 user_id 가 없다).
      const { rows: carts } = await tx.execute(sql`
        DELETE FROM shop_carts WHERE user_id = ${userId}::uuid RETURNING id
      `);
      if (carts.length) done.push("장바구니 삭제");

      // 주문: 행은 남기고 회원 연결만 해제
      const { rows: orders } = await tx.execute(sql`
        UPDATE shop_orders SET user_id = NULL WHERE user_id = ${userId}::uuid RETURNING id
      `);
      if (orders.length) {
        done.push(`주문 ${orders.length}건은 법정 보존 기간(5년) 동안 유지 — 회원 연결만 해제`);
      }

      // 후기는 남긴다. 다른 구매자에게 유용한 정보이고 개인정보가 아니다.
      // 다만 작성자는 익명화한다.
      const { rows: reviews } = await tx.execute(sql`
        UPDATE shop_reviews SET user_id = NULL, author_name = '탈퇴한 회원'
        WHERE user_id = ${userId}::uuid RETURNING id
      `);
      if (reviews.length) done.push(`상품 후기 ${reviews.length}건 작성자 익명화`);

      // 비밀 문의는 지운다 — 배송지·연락처를 적는 경우가 많다
      const { rows: secret } = await tx.execute(sql`
        DELETE FROM shop_inquiries
        WHERE user_id = ${userId}::uuid AND is_secret = true RETURNING id
      `);
      await tx.execute(sql`
        UPDATE shop_inquiries SET user_id = NULL, author_name = '탈퇴한 회원'
        WHERE user_id = ${userId}::uuid
      `);
      if (secret.length) done.push(`비밀 문의 ${secret.length}건 삭제 (개인정보 포함)`);

      return done;
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE status IN ('pending','paid','preparing','shipped')) AS ongoing
        FROM shop_orders WHERE user_id = ${userId}::uuid
      `);
      const total = Number(rows[0]?.total ?? 0);
      const ongoing = Number(rows[0]?.ongoing ?? 0);
      const items: Array<{ label: string; detail: string }> = [];
      if (ongoing > 0) {
        items.push({
          label: "진행 중인 주문",
          detail: `${ongoing}건이 있습니다. 배송이 끝나기 전에 탈퇴하면 주문 조회가 어려워집니다.`,
        });
      }
      if (total > 0) {
        items.push({
          label: "주문 내역",
          detail: `${total}건은 전자상거래법에 따라 5년간 보존되지만, 회원 연결이 끊겨 조회할 수 없게 됩니다.`,
        });
      }
      return items;
    },
  });

  ctx.registerAdminResource(ORDER_RESOURCE);
  ctx.registerAdminResource(PRODUCT_RESOURCE);
  ctx.registerAdminResource(CATEGORY_RESOURCE);
  ctx.registerAdminResource(COUPON_RESOURCE);
  ctx.registerAdminResource(REVIEW_RESOURCE);
  ctx.registerAdminResource(INQUIRY_RESOURCE);
  ctx.registerAdminResource(RETURN_RESOURCE);
  ctx.registerAdminResource(SHIPPING_ZONE_RESOURCE);
  ctx.registerAdminResource(CASH_RECEIPT_RESOURCE);
  ctx.registerAdminResource(TAX_INVOICE_RESOURCE);
  ctx.registerAdminResource(PAYMENT_REQUEST_RESOURCE);
  ctx.registerAdminResource(GRADE_RESOURCE);
  ctx.registerAdminResource(COLLECTION_RESOURCE);
  ctx.registerAdminResource(SUBSCRIPTION_RESOURCE);

  /**
   * 사이트맵: 판매 중인 상품 주소.
   *
   * draft·hidden 은 제외한다. soldout 은 포함한다 — 품절이어도 상품 페이지는
   * 유효한 콘텐츠이고, 재입고되면 색인이 이미 되어 있는 것이 유리하다.
   */
  /**
   * 통합검색 — 상품.
   *
   * `draft`(작성 중)와 `hidden`(내린 상품)은 제외한다. draft 노출은 정보
   * 유출이고(가격을 정하기 전의 상품, 미공개 신상품), hidden 은 눌러도
   * 404 가 난다.
   *
   * `count` 와 `search` 가 같은 조건을 쓰도록 한 곳에 둔다.
   */
  const productSearchWhere = (query: string) => {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return sql`
      p.status IN ('selling', 'soldout')
      AND (p.name ILIKE ${like} OR p.summary ILIKE ${like} OR p.description ILIKE ${like})
    `;
  };

  /**
   * 연결 대상 — 쇼핑몰 화면과 상품 분류.
   *
   * 분류가 200개인 사이트가 있으므로 상한과 검색을 지킨다. 전부 내보내면
   * 선택 목록이 멈춘다.
   */
  ctx.registerLinkTarget({
    label: "쇼핑몰",
    code: "shop",
    order: 20,
    async list({ query, limit }) {
      const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      // 고정 화면 — 분류보다 먼저 보여준다. 메뉴에 가장 많이 넣는 것이다.
      // /shop/orders 를 넣었다가 뺐다 — 그 주소를 그리는 화면이 없어서
      // 메뉴에 넣으면 404 였다. **링크 목록은 실제로 렌더되는 주소만** 담는다.
      const fixed = [
        { path: "/shop", label: "상품 목록 (전체)", hint: null },
        { path: "/shop/cart", label: "장바구니", hint: null },
        { path: "/shop/event", label: "기획전 목록", hint: null },
      ].filter((f) => !query || f.label.includes(query) || f.path.includes(query));

      // 진행 중 기획전 — 메뉴에 가장 많이 붙는 것이다
      const cols = await activeCollections(db);
      const collectionTargets = cols
        .filter((c) => !query || c.title.includes(query) || c.slug.includes(query))
        .slice(0, 10)
        .map((c) => ({
          path: `/shop/event/${encodeURIComponent(c.slug)}`,
          label: c.title,
          hint: "기획전",
        }));

      const { rows } = await db.execute(sql`
        SELECT slug, name FROM shop_categories
        WHERE is_visible = true
          ${query ? sql`AND (name ILIKE ${like} OR slug ILIKE ${like})` : sql``}
        ORDER BY sort_order, name
        LIMIT ${Math.max(1, limit - fixed.length)}
      `);
      return [
        ...fixed,
        ...collectionTargets,
        ...rows.map((r) => ({
          path: `/shop?category=${encodeURIComponent(String(r.slug))}`,
          label: String(r.name),
          hint: "상품 분류",
        })),
      ];
    },
  });

  ctx.registerSearchSource({
    label: "상품",
    code: "products",
    order: 5,
    async count({ query }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM shop_products p WHERE ${productSearchWhere(query)}
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async search({ query, offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT p.slug, p.name, p.summary, p.description, p.price, p.status, p.created_at,
               c.name AS category_name
        FROM shop_products p
        LEFT JOIN shop_categories c ON c.id = p.category_id
        WHERE ${productSearchWhere(query)}
        -- 판매중을 품절보다 먼저. 눌러도 못 사는 것이 위에 오면 안 된다.
        ORDER BY (p.status = 'selling') DESC, p.sold_count DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/shop/${String(r.slug)}`,
        title: String(r.name),
        // 짧은 설명이 있으면 그것을, 없으면 상세에서 발췌한다
        excerpt: searchExcerpt(String(r.summary || r.description || ""), query),
        date: r.created_at as Date,
        meta: [
          String(r.category_name ?? "") || null,
          `${Number(r.price).toLocaleString("ko-KR")}원`,
          String(r.status) === "soldout" ? "품절" : null,
        ].filter(Boolean).join(" · "),
      }));
    },
  });

  ctx.registerSitemapSource({
    label: "상품",
    async count() {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM shop_products WHERE status IN ('selling', 'soldout')
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async page({ offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT slug, updated_at FROM shop_products
        WHERE status IN ('selling', 'soldout')
        ORDER BY created_at, id
        LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/shop/${String(r.slug)}`,
        lastmod: r.updated_at as Date,
        changefreq: "daily" as const,
        priority: 0.8,
      }));
    },
  });

  registerStorefrontBlocks(ctx, db, settings);

  // 대시보드 — 운영자가 매일 아침 보는 숫자. "오늘"은 리포트와 같은 사이트 시간대다
  ctx.registerDashboardCard({
    title: "오늘 주문",
    order: 20,
    link: "/admin/x/brick-shop/orders",
    load: async () => {
      const { rows } = await db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE (created_at AT TIME ZONE ${SITE_TZ})::date = (now() AT TIME ZONE ${SITE_TZ})::date
              AND status <> 'cancelled'
          ) AS today,
          count(*) FILTER (WHERE status = 'pending') AS awaiting
        FROM shop_orders
      `);
      return {
        value: Number(rows[0]?.today ?? 0),
        sub: ctx.t("dash.awaitingPayment", { n: Number(rows[0]?.awaiting ?? 0) }),
      };
    },
  });

  return {};
});

/* ── 검증 헬퍼 ──────────────────────────────────────── */

function validateProduct(b: Record<string, unknown>) {
  const slug = String(b.slug ?? "").trim();
  const name = String(b.name ?? "").trim();
  if (!name) throw new ShopError(400, "상품명을 입력해주세요.");
  if (!SLUG_RE.test(slug)) throw new ShopError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");

  const price = Math.floor(Number(b.price ?? 0));
  if (!Number.isFinite(price) || price < 0) throw new ShopError(400, "판매가는 0원 이상이어야 합니다.");

  const listPrice = b.list_price === null || b.list_price === undefined || b.list_price === ""
    ? null : Math.floor(Number(b.list_price));
  if (listPrice !== null && (!Number.isFinite(listPrice) || listPrice < 0)) {
    throw new ShopError(400, "정가가 올바르지 않습니다.");
  }

  const stock = b.stock === null || b.stock === undefined || b.stock === ""
    ? null : Math.floor(Number(b.stock));
  if (stock !== null && (!Number.isFinite(stock) || stock < 0)) {
    throw new ShopError(400, "재고는 0 이상이어야 합니다.");
  }

  const status = String(b.status ?? "draft");
  if (!["draft", "selling", "soldout", "hidden"].includes(status)) {
    throw new ShopError(400, "판매 상태가 올바르지 않습니다.");
  }

  // 분류는 없어도 된다 (미분류 상품이 있다). 빈 문자열은 null 로 본다 —
  // 폼에서 "선택 없음"을 고르면 "" 가 온다.
  const rawCategory = b.category_id;
  const categoryId =
    rawCategory === null || rawCategory === undefined || String(rawCategory).trim() === ""
      ? null : String(rawCategory).trim();
  if (categoryId !== null && !UUID_RE.test(categoryId)) {
    throw new ShopError(400, "분류가 올바르지 않습니다.");
  }

  return {
    slug, name, price, listPrice, stock, status, categoryId,
    // 면세 상품 (도서·농수산물 등). 세금 증빙 금액 분해에 쓴다
    taxFree: b.tax_free === true || b.tax_free === "true",
    imageUrl: String(b.image_url ?? "").trim() || null,
    summary: String(b.summary ?? "").trim() || null,
    description: String(b.description ?? ""),
    freeShipping: b.free_shipping === true,
    sortOrder: Math.floor(Number(b.sort_order ?? 0)) || 0,
    // 정기배송 주기. 빈 값이면 일반 상품
    subInterval: ((): string | null => {
      const v = String(b.sub_interval ?? "").trim();
      if (!v) return null;
      if (!["week", "month"].includes(v)) throw new ShopError(400, "정기배송 주기가 올바르지 않습니다.");
      return v;
    })(),
  };
}

function validateCoupon(b: Record<string, unknown>) {
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,50}$/.test(code)) {
    throw new ShopError(400, "쿠폰 코드는 영문/숫자/하이픈 3~50자로 입력해주세요.");
  }
  const type = String(b.discount_type ?? "fixed");
  if (!["fixed", "percent"].includes(type)) throw new ShopError(400, "할인 방식이 올바르지 않습니다.");
  const value = Math.floor(Number(b.discount_value ?? 0));
  if (!Number.isFinite(value) || value <= 0) throw new ShopError(400, "할인 값은 0보다 커야 합니다.");
  if (type === "percent" && value > 100) throw new ShopError(400, "정률 할인은 100%를 넘을 수 없습니다.");

  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.floor(Number(v)));
  const perUserLimit = num(b.per_user_limit);
  if (perUserLimit !== null && perUserLimit < 1) {
    throw new ShopError(400, "1인당 한도는 1 이상이어야 합니다.");
  }
  const gradeId = String(b.grade_id ?? "").trim() || null;
  if (gradeId && !UUID_RE.test(gradeId)) throw new ShopError(400, "등급이 올바르지 않습니다.");
  return {
    code,
    name: String(b.name ?? "").trim() || code,
    type,
    value,
    minAmount: num(b.min_amount) ?? 0,
    maxDiscount: num(b.max_discount),
    usageLimit: num(b.usage_limit),
    isActive: b.is_active !== false,
    perUserLimit,
    firstPurchaseOnly: b.first_purchase_only === true || b.first_purchase_only === "true",
    gradeId,
    // 생일 쿠폰은 발급형이어야 한다 — 코드형이면 "자동 지급"이 의미가 없다
    // (코드를 아는 누구나 쓸 수 있으니). 켜면 발급형을 함께 켠다.
    requiresIssue:
      b.requires_issue === true || b.requires_issue === "true" ||
      b.birthday_auto === true || b.birthday_auto === "true",
    birthdayAuto: b.birthday_auto === true || b.birthday_auto === "true",
  };
}

function slugConflict(err: unknown, label: string): unknown {
  const s = String(err);
  if (isUniqueViolation(err, "_slug")) {
    return new ShopError(409, `이미 사용 중인 ${label} 주소(slug)입니다.`);
  }
  return err;
}

export { escapeHtml, won };
