import { definePlugin, isUniqueViolation } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { DEFAULT_SETTINGS, ShopError, STATUS_LABEL, escapeHtml, won,
         type Db, type OrderStatus, type ShopSettings } from "./types.js";
import { quote } from "./pricing.js";
import { addToCart, clearCart, getCartItems, updateCartItem, type CartOwner } from "./cart.js";
import { changeOrderStatus, createOrder, type PointsPort } from "./orders.js";
import { bankTransferGateway, confirmPayment, gateways, refundPayment, registerGateway } from "./payments.js";
import { CATEGORY_RESOURCE, COUPON_RESOURCE, INQUIRY_RESOURCE, ORDER_RESOURCE,
         PRODUCT_RESOURCE, REVIEW_RESOURCE } from "./admin-resources.js";
import { registerStorefrontBlocks } from "./blocks.js";
import {
  createInquiry, createReview, deleteInquiry, deleteReview, findPurchase,
  listInquiries, listReviews, replyToInquiry, replyToReview, setReviewVisible, updateReview,
} from "./reviews.js";
import { formatOptions, parseImages, parseOptions, syncOptions } from "./options.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,148}$/;

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
    return {
      product: {
        ...product,
        rating_avg:
          Number(product.review_count) > 0
            ? Math.round((Number(product.rating_sum) / Number(product.review_count)) * 10) / 10
            : 0,
      },
      options,
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
    };
    const items = body.items?.length ? body.items : await getCartItems(db, owner(req));

    // 포인트 사용 요청이 있으면 실제 잔액으로 상한을 잡는다 (클라이언트 값을 신뢰하지 않는다)
    let pointUsed = 0;
    const port = pointsPort();
    if (body.pointUsed && req.user && port) {
      const balance = await port.balance(req.user.id);
      pointUsed = Math.max(0, Math.min(Math.floor(Number(body.pointUsed)), balance));
    }

    const q = await quote(db, items, await settings(), body.couponCode, { pointUsed });
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
      methods: [...gateways.values()].map((g) => ({ provider: g.provider, displayName: g.displayName })),
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
             p.category_id, p.images, p.review_count, p.rating_sum,
             coalesce(
               (SELECT json_agg(json_build_object('name', o.name, 'extra_price', o.extra_price, 'stock', o.stock)
                                ORDER BY o.sort_order, o.name)
                FROM shop_product_options o WHERE o.product_id = p.id),
               '[]'
             ) AS options
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
           free_shipping, sort_order, images)
        VALUES
          (${id}, ${p.slug}, ${p.name}, ${p.price}, ${p.listPrice}, ${p.stock}, ${p.status},
           ${p.imageUrl ?? images[0] ?? null}, ${p.summary}, ${p.description},
           ${p.freeShipping}, ${p.sortOrder}, ${JSON.stringify(images)}::jsonb)
      `);
    } catch (err) {
      throw slugConflict(err, "상품");
    }
    if (options.length) await syncOptions(db, id, options);
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
          images = ${JSON.stringify(images)}::jsonb, updated_at = now()
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new ShopError(404, "상품을 찾을 수 없습니다.");
    } catch (err) {
      throw slugConflict(err, "상품");
    }
    // 옵션은 이름으로 짝지어 갱신한다 — 전부 지우면 장바구니의 옵션이 사라진다
    await syncOptions(db, req.params.id, options);
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
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO shop_categories (id, slug, name, sort_order, is_visible)
        VALUES (${id}, ${slug}, ${String(b.name).trim()}, ${Number(b.sort_order ?? 0)}, ${b.is_visible !== false})
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
    try {
      await db.execute(sql`
        UPDATE shop_categories SET slug = ${slug}, name = ${String(b.name ?? "").trim()},
          sort_order = ${Number(b.sort_order ?? 0)}, is_visible = ${b.is_visible !== false}
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
             usage_limit, used_count, is_active
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
          (id, code, name, discount_type, discount_value, min_amount, max_discount, usage_limit, is_active)
        VALUES (${id}, ${c.code}, ${c.name}, ${c.type}, ${c.value}, ${c.minAmount}, ${c.maxDiscount},
                ${c.usageLimit}, ${c.isActive})
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
        usage_limit = ${c.usageLimit}, is_active = ${c.isActive}
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
  ctx.registerRoute("GET", "/admin/stats", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'pending')                     AS pending_orders,
        count(*) FILTER (WHERE status NOT IN ('cancelled','refunded')) AS valid_orders,
        coalesce(sum(total) FILTER (WHERE status NOT IN ('pending','cancelled','refunded')), 0) AS revenue,
        coalesce(sum(total) FILTER (WHERE status NOT IN ('pending','cancelled','refunded')
                                     AND created_at >= date_trunc('month', now())), 0) AS revenue_this_month
      FROM shop_orders
    `);
    const { rows: low } = await db.execute(sql`
      SELECT name, stock FROM shop_products
      WHERE status = 'selling' AND stock IS NOT NULL AND stock <= 5 ORDER BY stock LIMIT 10
    `);
    return { ...rows[0], lowStock: low };
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

  /**
   * 사이트맵: 판매 중인 상품 주소.
   *
   * draft·hidden 은 제외한다. soldout 은 포함한다 — 품절이어도 상품 페이지는
   * 유효한 콘텐츠이고, 재입고되면 색인이 이미 되어 있는 것이 유리하다.
   */
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

  return {
    slug, name, price, listPrice, stock, status,
    imageUrl: String(b.image_url ?? "").trim() || null,
    summary: String(b.summary ?? "").trim() || null,
    description: String(b.description ?? ""),
    freeShipping: b.free_shipping === true,
    sortOrder: Math.floor(Number(b.sort_order ?? 0)) || 0,
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
  return {
    code,
    name: String(b.name ?? "").trim() || code,
    type,
    value,
    minAmount: num(b.min_amount) ?? 0,
    maxDiscount: num(b.max_discount),
    usageLimit: num(b.usage_limit),
    isActive: b.is_active !== false,
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
