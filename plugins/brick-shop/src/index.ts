import { definePlugin } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { DEFAULT_SETTINGS, ShopError, STATUS_LABEL, escapeHtml, won,
         type Db, type OrderStatus, type ShopSettings } from "./types.js";
import { quote } from "./pricing.js";
import { addToCart, clearCart, getCartItems, updateCartItem, type CartOwner } from "./cart.js";
import { changeOrderStatus, createOrder, type PointsPort } from "./orders.js";
import { bankTransferGateway, confirmPayment, gateways, refundPayment, registerGateway } from "./payments.js";
import { CATEGORY_RESOURCE, COUPON_RESOURCE, ORDER_RESOURCE, PRODUCT_RESOURCE } from "./admin-resources.js";
import { registerStorefrontBlocks } from "./blocks.js";

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
             p.stock, p.status, p.sold_count, c.name AS category_name, c.slug AS category_slug
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
      RETURNING id, slug, name, summary, description, image_url, price, list_price,
                stock, status, free_shipping, sold_count, view_count, category_id
    `);
    const product = rows[0];
    if (!product) throw new ShopError(404, "상품을 찾을 수 없습니다.");
    const { rows: options } = await db.execute(sql`
      SELECT id, name, extra_price, stock FROM shop_product_options
      WHERE product_id = ${String(product.id)}::uuid AND is_active = true
      ORDER BY sort_order, name
    `);
    return { product, options };
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
      SELECT id, slug, name, price, list_price, stock, status, image_url, summary, description,
             free_shipping, sort_order, sold_count, category_id
      FROM shop_products ORDER BY sort_order, created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_products`);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: 30 };
  });

  ctx.registerRoute("POST", "/admin/products", async (req) => {
    requireAdmin(req);
    const p = validateProduct(req.body as Record<string, unknown>);
    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO shop_products
          (id, slug, name, price, list_price, stock, status, image_url, summary, description, free_shipping, sort_order)
        VALUES
          (${id}, ${p.slug}, ${p.name}, ${p.price}, ${p.listPrice}, ${p.stock}, ${p.status},
           ${p.imageUrl}, ${p.summary}, ${p.description}, ${p.freeShipping}, ${p.sortOrder})
      `);
    } catch (err) {
      throw slugConflict(err, "상품");
    }
    await ctx.cache.invalidateTag("pages");
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/products/:id", async (req) => {
    requireAdmin(req);
    const p = validateProduct(req.body as Record<string, unknown>);
    try {
      const { rows } = await db.execute(sql`
        UPDATE shop_products SET
          slug = ${p.slug}, name = ${p.name}, price = ${p.price}, list_price = ${p.listPrice},
          stock = ${p.stock}, status = ${p.status}, image_url = ${p.imageUrl}, summary = ${p.summary},
          description = ${p.description}, free_shipping = ${p.freeShipping}, sort_order = ${p.sortOrder},
          updated_at = now()
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new ShopError(404, "상품을 찾을 수 없습니다.");
    } catch (err) {
      throw slugConflict(err, "상품");
    }
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
      if (String(err).includes("shop_coupons_code_key") || String(err).includes("duplicate key")) {
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
  ctx.registerAdminResource(ORDER_RESOURCE);
  ctx.registerAdminResource(PRODUCT_RESOURCE);
  ctx.registerAdminResource(CATEGORY_RESOURCE);
  ctx.registerAdminResource(COUPON_RESOURCE);

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
  if (s.includes("_slug_key") || s.includes("duplicate key")) {
    return new ShopError(409, `이미 사용 중인 ${label} 주소(slug)입니다.`);
  }
  return err;
}

export { escapeHtml, won };
