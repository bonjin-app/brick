/**
 * 정기결제 — 카드는 PG 에, 해지는 한 클릭에.
 *
 * 원칙:
 *  1. **카드번호는 이 시스템을 지나가지 않는다.** PG 화면에서 등록하고
 *     우리는 빌링키(토큰)만 저장한다.
 *  2. **청구액은 가입 시점에 고정된다** (agreed_total = 첫 주문 총액).
 *     가격·배송비가 바뀌어 회차 주문의 총액이 달라지면 결제하지 않고
 *     멈춘 뒤 알린다 — 동의 없는 인상 청구는 법 이전에 신뢰의 문제다.
 *  3. **해지는 항상, 즉시, 조건 없이 된다.** 가입은 한 클릭인데 해지는
 *     전화를 걸어야 하는 서비스를 만들지 않는다.
 *  4. 회차마다 **일반 주문이 생긴다** — 매출·리포트·환불·세금 증빙이
 *     기존 경로 그대로 정합하다. 구독만의 특별한 돈 흐름을 만들지 않는다.
 *  5. 밀린 회차를 몰아서 청구하지 않는다 — 서버가 한 달 죽어 있었다고
 *     네 번 치지 않는다. 한 번 청구하고 다음 예정일을 미래로 옮긴다.
 */
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { isUniqueViolation } from "@brick/plugin-sdk";
import type { Db, ShopSettings } from "./types.js";
import { ShopError } from "./types.js";
import { createOrder, changeOrderStatus, type OrdererInput, type PointsPort } from "./orders.js";
import { gateways, type PaymentGateway } from "./payments.js";
import { quote } from "./pricing.js";
// 메일 문구도 사이트 언어를 따른다 — 메일은 사이트 밖에서 혼자 읽힌다
import { t, money } from "./i18n.js";

export const SUBSCRIPTION_QUEUE_JOB = "shop.subscription.charge";

const MAX_FAILS = 3;
const RETRY_DELAY_HOURS = 24;

const INTERVAL_LABEL: Record<string, string> = { week: "매주", month: "매월" };

export interface SubscriptionNotifier {
  /**
   * `userId` 는 **사이트 안 알림함**용이다 — 정기배송은 회원만 하므로 항상 있다.
   * 메일만 보내던 시절에는 SMTP 가 없는 사이트에서 "결제가 실패했습니다" 도
   * "정기배송이 멈췄습니다" 도 아무에게도 닿지 않았다.
   */
  (params: { userId: string; email: string; subject: string; text: string }): Promise<boolean>;
}

/** 두 메서드를 모두 구현한 게이트웨이만 정기결제를 지원한다 */
function billingGateway(provider: string): PaymentGateway | null {
  const g = gateways.get(provider);
  if (!g || !g.issueBillingKey || !g.chargeBillingKey) return null;
  return g;
}

export async function listBillingProviders(): Promise<Array<{ provider: string; displayName: string }>> {
  const out: Array<{ provider: string; displayName: string }> = [];
  for (const g of gateways.values()) {
    /*
     * 서버 쪽 둘(발급·청구)만으로는 부족하다. 카드 등록 창을 여는 **클라이언트
     * 단계**(checkout.script 안의 registerCard)가 없으면 회원은 카드를 등록할
     * 길이 없다 — 그런 결제수단을 목록에 내놓으면 누를 수는 있는데 아무 일도
     * 일어나지 않는다. 결제수단을 감추는 isReady 와 같은 원칙이다.
     */
    if (!(g.issueBillingKey && g.chargeBillingKey && g.checkout)) continue;
    const ready = g.isBillingReady ?? g.isReady;
    if (ready && !(await ready.call(g).catch(() => false))) continue;
    out.push({ provider: g.provider, displayName: g.displayName });
  }
  return out;
}

// ── 빌링키 ──────────────────────────────────────────

/** 회원의 PG 고객 식별자 — 없으면 만든다. 동시에 두 번 불려도 하나만 남는다 */
export async function billingCustomerKey(db: Db, userId: string): Promise<string> {
  await db.execute(sql`
    INSERT INTO shop_billing_customers (user_id, customer_key)
    VALUES (${userId}::uuid, ${`cust-${uuidv7().replace(/-/g, "")}`})
    ON CONFLICT (user_id) DO NOTHING
  `);
  const { rows } = await db.execute(sql`SELECT customer_key FROM shop_billing_customers WHERE user_id = ${userId}::uuid`);
  return String(rows[0]?.customer_key ?? "");
}

export async function issueBillingKey(
  db: Db,
  params: { userId: string; provider: string; authKey: string; customerKey: string },
): Promise<{ id: string; cardLabel: string | null }> {
  const gateway = billingGateway(params.provider);
  if (!gateway) throw new ShopError(400, "정기결제를 지원하지 않는 결제수단입니다.");

  const authKey = String(params.authKey ?? "").trim();
  const customerKey = String(params.customerKey ?? "").trim();
  if (!authKey || !customerKey || customerKey.length > 100) {
    throw new ShopError(400, "카드 등록 정보가 올바르지 않습니다.");
  }

  /*
   * 고객 식별자가 **이 회원에게 준 값**이어야 한다. 요청이 들고 온 값을 믿으면, 남의 카드 등록 결과
   * (빌링키 + 그 사람의 고객 식별자 — 돌아오는 주소에 실린다)로 내 계정에 카드를 붙일 수 있다.
   * 게이트웨이는 그 빌링키가 이 고객 식별자로 발급됐는지 PG 에 확인한다 — 둘이 합쳐 "이 회원의 카드" 다.
   */
  const { rows: mine } = await db.execute(sql`
    SELECT 1 FROM shop_billing_customers WHERE user_id = ${params.userId}::uuid AND customer_key = ${customerKey}
  `);
  if (!mine.length) throw new ShopError(400, "카드 등록 정보가 올바르지 않습니다. 카드 등록을 처음부터 다시 해 주세요.");

  const result = await gateway.issueBillingKey!({ authKey, customerKey });
  if (!result.ok || !result.billingKey) {
    throw new ShopError(402, result.failureReason ?? "카드 등록에 실패했습니다.");
  }
  // 같은 빌링키가 다른 회원에게 살아 있으면 받지 않는다(위 대조를 지나온 경우의 이중 방어)
  const { rows: taken } = await db.execute(sql`
    SELECT 1 FROM shop_billing_keys
    WHERE provider = ${params.provider} AND billing_key = ${result.billingKey}
      AND user_id <> ${params.userId}::uuid AND revoked_at IS NULL
  `);
  if (taken.length) throw new ShopError(409, "이미 다른 계정에 등록된 카드입니다.");

  const id = uuidv7();
  await db.execute(sql`
    INSERT INTO shop_billing_keys (id, user_id, provider, billing_key, customer_key, card_label)
    VALUES (${id}, ${params.userId}::uuid, ${params.provider}, ${result.billingKey},
            ${customerKey}, ${result.cardLabel ?? null})
  `);
  return { id, cardLabel: result.cardLabel ?? null };
}

export async function listBillingKeys(db: Db, userId: string) {
  const { rows } = await db.execute(sql`
    SELECT id, provider, card_label, created_at
    FROM shop_billing_keys
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
    ORDER BY created_at DESC
  `);
  return rows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    cardLabel: r.card_label ? String(r.card_label) : null,
    createdAt: r.created_at,
  }));
}

/**
 * 빌링키 해지. 이 키를 쓰는 구독은 **즉시 멈춘다** — 회원이 결제수단을
 * 지웠는데 다음 회차가 청구되면 그것이 사고다.
 */
export async function revokeBillingKey(
  db: Db,
  params: { userId: string; keyId: string },
): Promise<{ pausedSubscriptions: number }> {
  return await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      UPDATE shop_billing_keys SET revoked_at = now()
      WHERE id = ${params.keyId}::uuid AND user_id = ${params.userId}::uuid AND revoked_at IS NULL
      RETURNING id
    `);
    if (!rows.length) throw new ShopError(404, "등록된 카드를 찾을 수 없습니다.");

    const { rows: paused } = await tx.execute(sql`
      UPDATE shop_subscriptions
      SET status = 'paused', pause_reason = '결제 카드가 삭제되었습니다. 카드를 다시 등록한 뒤 재개할 수 있습니다.'
      WHERE billing_key_id = ${params.keyId}::uuid AND status = 'active'
      RETURNING id, cycle_no
    `);
    for (const p of paused) {
      await tx.execute(sql`
        INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
        VALUES (${uuidv7()}, ${String(p.id)}::uuid, ${Number(p.cycle_no)}, 'paused', '결제 카드 삭제')
      `);
    }
    return { pausedSubscriptions: paused.length };
  });
}

// ── 청구 한 회차 (결제의 핵심 경로) ──────────────────

/**
 * 실패한 회차 주문을 취소하고 **멱등키를 회수한다.**
 *
 * 회수하지 않으면 실패한(취소된) 주문이 그 회차의 키를 차지한 채 남고,
 * 재시도는 createOrder 멱등성 때문에 그 취소된 주문을 되돌려받는다 —
 * 카드를 고쳐도, 가격을 되돌려도 그 구독은 영원히 재개되지 않는다.
 * (토스 confirm 멱등키에서 배운 것과 같은 병: 실패가 키를 오염시킨다)
 */
async function abandonCycleOrder(db: Db, orderId: string, note: string): Promise<void> {
  await changeOrderStatus(db, orderId, "cancelled", { note }).catch(() => undefined);
  await db.execute(sql`
    UPDATE shop_orders SET idempotency_key = NULL WHERE id = ${orderId}::uuid
  `);
}

/**
 * 주문 하나를 빌링키로 결제하고 기록한다. confirmPayment 와 같은 방어를 한다:
 * 시도 기록 → PG 청구 → **승인 금액 대조** → 확정. provider_tid unique 가
 * 같은 PG 거래의 이중 계상을 막는다.
 */
async function chargeOrder(
  db: Db,
  params: {
    gateway: PaymentGateway;
    billingKey: string;
    customerKey: string;
    orderId: string;
    orderNo: string;
    amount: number;
    orderName: string;
    idempotencyKey: string;
    pointsPort?: PointsPort | null;
  },
): Promise<
  | { ok: true }
  | { ok: false; pending: true }
  | { ok: false; pending?: false; reason: string; customerReason: string }
> {
  const paymentId = uuidv7();
  await db.execute(sql`
    INSERT INTO shop_payments (id, order_id, provider, status, amount)
    VALUES (${paymentId}, ${params.orderId}::uuid, ${params.gateway.provider}, 'requested', ${params.amount})
  `);

  const result = await params.gateway.chargeBillingKey!({
    billingKey: params.billingKey,
    customerKey: params.customerKey,
    orderNo: params.orderNo,
    amount: params.amount,
    orderName: params.orderName,
    idempotencyKey: params.idempotencyKey,
  });

  if (!result.ok && result.pending) {
    // PG 에 거래가 생기지 않았다 — 이 시도의 기록은 남길 것이 없다. 'failed' 로 두면
    // 대사(對査) 때 "실패한 결제" 로 읽히고, 'requested' 로 두면 끝나지 않은 결제로 읽힌다.
    await db.execute(sql`DELETE FROM shop_payments WHERE id = ${paymentId}`);
    return { ok: false, pending: true };
  }

  if (!result.ok || !result.providerTid) {
    /*
     * 자세한 이유는 **기록에만** 남는다.
     *
     * 이 값은 곧장 손님에게 갔다: 가입 실패 문장, 멈춤 사유(내 정기배송 화면),
     * 회차 이력, 실패 알림 메일 — 네 곳이다. PG 가 닿지 않으면 그 자리에
     * `TypeError: fetch failed` 가 찍혔다. 손님은 자기가 무엇을 해야 하는지 알 수
     * 없고, 우리는 서버 사정을 밖으로 흘린다.
     */
    const reason = (result.failureReason ?? "청구 실패").slice(0, 500);
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed', failure_reason = ${reason},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    return { ok: false, reason, customerReason: result.customerReason?.trim() || t("pay.failed") };
  }

  // 승인 금액 대조 — 다르면 즉시 취소한다. 청구는 우리가 시작했으므로
  // 금액 불일치는 공격이 아니라 버그지만, 버그일수록 돈이 움직이면 안 된다.
  const approved = Number(result.approvedAmount);
  if (!Number.isFinite(approved) || approved !== params.amount) {
    await params.gateway
      .cancel({ providerTid: result.providerTid, reason: "청구 금액 불일치",
                idempotencyKey: `${params.idempotencyKey}-mismatch` })
      .catch(() => undefined);
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed',
        failure_reason = ${`금액 불일치: 청구 ${params.amount}원 / 승인 ${approved}원`},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    // 이 문장은 손님에게 보여도 된다 — 우리 쪽 대조 결과이고 서버 사정이 없다
    const mismatch = "승인 금액이 청구 금액과 일치하지 않습니다.";
    return { ok: false, reason: mismatch, customerReason: mismatch };
  }

  try {
    await db.execute(sql`
      UPDATE shop_payments SET status = 'paid', provider_tid = ${result.providerTid},
        method = ${result.method ?? "카드"},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, approved_at = now(), updated_at = now()
      WHERE id = ${paymentId}
    `);
  } catch (err) {
    if (!isUniqueViolation(err, "shop_payments_tid_uniq")) throw err;
    /*
     * **같은 PG 거래를 결제 완료 통지(웹훅)가 먼저 기록했다.** PG 는 웹훅과 API 응답의 순서를 보장하지 않는다 —
     * 청구 응답을 기다리는 사이 웹훅이 와서 이 주문을 결제 완료로 만들 수 있다. 여기서 던지면 회차는 "실패" 로
     * 세어지고 끝나지 않은 시도 기록이 남았고, **가입 첫 결제에서는 카드가 긁혔는데 손님이 500 을 받았다**
     * (다시 누르면 두 번째 청구다). 거래는 하나다 — 이 시도의 기록을 치우고 먼저 적힌 쪽을 따른다.
     */
    await db.execute(sql`DELETE FROM shop_payments WHERE id = ${paymentId}`);
    const { rows: first } = await db.execute(sql`
      SELECT status FROM shop_payments
      WHERE provider = ${params.gateway.provider} AND provider_tid = ${result.providerTid}
    `);
    // 통지 쪽이 아직 확정 중이면 그쪽이 끝낸다 — 처리 중으로 물러난다(주문도 실패 기록도 건드리지 않는다)
    if (first[0]?.status === "paid") return { ok: true };
    return { ok: false, pending: true };
  }
  await db.execute(sql`
    UPDATE shop_orders SET payment_method = ${params.gateway.provider}, updated_at = now()
    WHERE id = ${params.orderId}::uuid
  `);
  try {
    await changeOrderStatus(db, params.orderId, "paid", {
      // 이력 note 는 저장되는 데이터다 — 번역하지 않는다 (payments.ts 의 같은 주석 참고)
      note: `정기결제 승인 (${approved.toLocaleString("ko-KR")}원)`,
      pointsPort: params.pointsPort ?? null,
    });
  } catch (err) {
    /*
     * **돈은 움직였는데 주문이 결제 상태가 될 수 없다.**
     *
     * 청구 도중 그 주문이 취소되면(겹쳐 돈 청구, 운영자의 수동 취소) PG 는 승인했는데
     * 주문은 취소 상태다. 그대로 두면 손님은 결제되고 받을 것이 없으며, 우리 쪽 화면은
     * 어디에도 "결제됨" 이라고 말하지 않는다 — 그래서 아무도 환불하지 않는다.
     * 받을 수 없는 주문의 돈은 돌려준다. 취소 상태가 아닌 다른 이유라면(일시적 DB
     * 오류 등) 여기서 판단하지 않고 그대로 던진다 — 멀쩡한 결제를 환불하면 안 된다.
     */
    const { rows } = await db.execute(sql`SELECT status FROM shop_orders WHERE id = ${params.orderId}::uuid`);
    if (rows[0]?.status !== "cancelled") throw err;
    const refund = await params.gateway
      .cancel({ providerTid: result.providerTid, reason: "주문이 취소된 뒤 승인된 정기결제",
                idempotencyKey: `${params.idempotencyKey}-orphan` })
      .catch(() => ({ ok: false as const }));
    await db.execute(sql`
      UPDATE shop_payments SET
        status = ${refund.ok ? "refunded" : "paid"},
        refunded_amount = ${refund.ok ? approved : 0},
        failure_reason = ${refund.ok ? "주문이 취소된 뒤 승인되어 전액 환불" : "주문이 취소된 뒤 승인됨 — 환불 실패, 수동 환불 필요"},
        updated_at = now()
      WHERE id = ${paymentId}
    `);
    // 환불까지 실패하면 사람이 봐야 한다 — 손님의 돈이 우리에게 있다
    const reason = refund.ok
      ? "주문이 취소된 뒤 승인되어 환불했습니다."
      : `주문이 취소된 뒤 승인되었고 환불에 실패했습니다 — 수동 환불이 필요합니다 (거래 ${result.providerTid}).`;
    return { ok: false, reason, customerReason: t("pay.failed") };
  }
  return { ok: true };
}

// ── 가입 ────────────────────────────────────────────

/**
 * 정기배송으로 팔 수 있는 상품인가 — 가입과 견적이 **같은 판정**을 쓴다.
 *
 * 견적이 무른 판정을 쓰면 화면은 금액을 보여 주는데 가입 버튼은 거절한다.
 */
async function subscribableProduct(
  db: Db, slug: string,
): Promise<{ id: string; name: string; interval: string }> {
  const { rows } = await db.execute(sql`
    SELECT id, name, status, sub_interval FROM shop_products WHERE slug = ${slug} LIMIT 1
  `);
  const p = rows[0];
  if (!p) throw new ShopError(404, "상품을 찾을 수 없습니다.");
  if (!p.sub_interval) throw new ShopError(400, "정기배송 상품이 아닙니다.");
  if (p.status !== "selling") throw new ShopError(400, "지금은 판매하지 않는 상품입니다.");
  return { id: String(p.id), name: String(p.name), interval: String(p.sub_interval) };
}

/**
 * 가입 전 청구 금액 — **가입이 실제로 계산하는 방식 그대로** 계산한다.
 *
 * 일반 견적(`POST /quote`)을 그대로 쓰면 안 된다: 그것은 등급 할인·쿠폰·
 * 포인트를 얹는데 `subscribe()` 는 그중 무엇도 넣지 않는다(바로 아래 주석의
 * 이유로). 등급이 있는 회원에게 할인된 금액을 보여 주고 실제로는 정가를
 * 청구하게 된다 — 정기결제에서 **보여 준 금액과 빠져나가는 금액이 다른 것**은
 * 가장 나쁜 종류의 버그다.
 *
 * 지역 추가 배송비는 우편번호를 받아야 나오므로, 화면은 주소를 넣을 때마다
 * 다시 묻는다.
 */
export async function quoteSubscription(
  db: Db,
  params: {
    productSlug: string; quantity?: number; postcode?: string | null; settings: ShopSettings;
    /** 성인 상품이면 묻는다 (본인인증) */
    isAdult?: () => Promise<boolean>;
  },
): Promise<{
  productName: string; quantity: number; interval: string;
  subtotal: number; shippingFee: number; zoneFee: number; zoneName: string | null; total: number;
}> {
  const quantity = Math.max(1, Math.min(999, Math.floor(Number(params.quantity ?? 1))));
  const product = await subscribableProduct(db, String(params.productSlug ?? ""));
  const q = await quote(db, [{ productId: product.id, quantity }], params.settings, null, {
    postcode: params.postcode ?? null,
    grade: null,
    userId: null,
    isAdult: params.isAdult,
  });
  return {
    productName: product.name,
    quantity,
    interval: product.interval,
    subtotal: q.subtotal,
    shippingFee: q.shippingFee,
    zoneFee: q.zoneFee,
    zoneName: q.zoneName,
    total: q.total,
  };
}

export async function subscribe(
  db: Db,
  params: {
    userId: string;
    productSlug: string;
    quantity?: number;
    billingKeyId: string;
    orderer: OrdererInput;
    settings: ShopSettings;
    pointsPort?: PointsPort | null;
    isAdult?: () => Promise<boolean>;
  },
): Promise<{ id: string; orderNo: string; total: number; nextChargeAt: unknown }> {
  const quantity = Math.max(1, Math.floor(Number(params.quantity ?? 1)));
  const product = await subscribableProduct(db, String(params.productSlug ?? ""));
  const interval = product.interval;

  const { rows: keys } = await db.execute(sql`
    SELECT id, provider, billing_key, customer_key FROM shop_billing_keys
    WHERE id = ${params.billingKeyId}::uuid AND user_id = ${params.userId}::uuid AND revoked_at IS NULL
    LIMIT 1
  `);
  const key = keys[0];
  if (!key) throw new ShopError(404, "등록된 카드를 찾을 수 없습니다. 카드를 먼저 등록해주세요.");
  const gateway = billingGateway(String(key.provider));
  if (!gateway) throw new ShopError(400, "이 카드의 결제수단을 지금 사용할 수 없습니다.");

  // 첫 회차 주문 — 등급·쿠폰·포인트를 적용하지 않는다.
  // 할인이 붙으면 agreed_total 이 그 할인을 포함해 고정되는데, 등급은 바뀌고
  // 쿠폰은 소진된다 — 2회차부터 금액이 달라져 구독이 멈춘다. 청구액이
  // 조용히 변하지 않는 것이 정기결제의 약속이므로, 처음부터 넣지 않는다.
  const subId = uuidv7();
  const order = await createOrder(db, {
    items: [{ productId: String(product.id), quantity }],
    orderer: params.orderer,
    userId: params.userId,
    settings: params.settings,
    idempotencyKey: `sub-${subId}-c1`,
    pointsPort: params.pointsPort ?? null,
    isAdult: params.isAdult,
  });

  // 구독 행을 청구 **전에** 만든다 (next_charge_at NULL = 아직 첫 결제 전 —
  // 스윕은 NULL 을 집지 않는다). 청구 후 만들다 중간에 죽으면 돈은 나갔는데
  // 구독이 없는 상태가 된다 — 그 반대(구독은 있는데 결제 전)는 무해하다.
  await db.execute(sql`
    INSERT INTO shop_subscriptions
      (id, user_id, product_id, product_name, quantity, interval_unit,
       agreed_total, billing_key_id, status, cycle_no, next_charge_at, orderer)
    VALUES
      (${subId}, ${params.userId}::uuid, ${String(product.id)}::uuid, ${String(product.name)},
       ${quantity}, ${interval}, ${order.total}, ${String(key.id)}::uuid,
       'active', 1, NULL, ${JSON.stringify({ ...params.orderer })}::jsonb)
  `);

  const charged = await chargeOrder(db, {
    gateway,
    billingKey: String(key.billing_key),
    customerKey: String(key.customer_key),
    orderId: order.id,
    orderNo: order.orderNo,
    amount: order.total,
    orderName: `${String(product.name)} 정기배송 1회차`,
    idempotencyKey: `sub-${subId}-c1`,
    pointsPort: params.pointsPort ?? null,
  });

  if (!charged.ok && charged.pending) {
    // 청구 결과를 아직 모른다(같은 요청이 청구 중이거나, PG 응답을 잃었다). 실패로 처리해 주문을 취소하면
    // 긁힌 돈이 갈 곳이 없다 — 물러난다. 구독은 다음 결제일 없이 남고, 스윕이 몇 분 뒤 이어서 끝낸다
    // (settleFirstCharges — 같은 회차 키로 다시 물어 결제됐으면 구독을 열고, 거절되면 가입을 거둔다).
    throw new ShopError(409, "결제가 처리 중입니다. 잠시 뒤 내 정기배송에서 확인하세요.");
  }
  if (!charged.ok) {
    // 첫 결제 실패 = 가입 실패. 주문을 취소해 재고를 되돌리고 구독을 지운다.
    // 주문 이력(운영자가 본다)에는 자세한 이유를, 손님에게는 보여도 되는 것만
    await abandonCycleOrder(db, order.id, `정기결제 가입 실패: ${charged.reason}`);
    await db.execute(sql`DELETE FROM shop_subscriptions WHERE id = ${subId}`);
    throw new ShopError(402, charged.customerReason);
  }

  const { rows: updated } = await db.execute(sql`
    UPDATE shop_subscriptions
    SET next_charge_at = now() + ${sql.raw(interval === "week" ? "interval '7 days'" : "interval '1 month'")}
    WHERE id = ${subId}
    RETURNING next_charge_at
  `);
  await db.execute(sql`
    INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, order_no, detail)
    VALUES (${uuidv7()}, ${subId}, 1, 'charged', ${order.orderNo},
            ${`가입 · ${order.total.toLocaleString("ko-KR")}원`})
  `);

  return { id: subId, orderNo: order.orderNo, total: order.total, nextChargeAt: updated[0]?.next_charge_at };
}

// ── 회차 청구 스윕 ───────────────────────────────────

async function pauseSubscription(
  db: Db, subId: string, cycleNo: number, reason: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_subscriptions SET status = 'paused', pause_reason = ${reason}
    WHERE id = ${subId}::uuid AND status = 'active'
  `);
  await db.execute(sql`
    INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
    VALUES (${uuidv7()}, ${subId}::uuid, ${cycleNo}, 'paused', ${reason})
  `);
}

/**
 * 결제일이 된 구독을 청구한다.
 *
 * "한 번에 하나" 는 호출자가 잠금으로 지킨다(index.ts 의 exclusive). 그래도 여기서
 * 겹침을 전제로 방어한다 — 잠금이 끊기는 경우(DB 연결 순단으로 세션이 끝나면 잠금도
 * 풀린다)가 있고, 돈이 걸린 코드는 한 겹으로 두지 않는다.
 *
 * 한 구독의 실패가 다른 구독을 막지 않도록 각각 격리해 처리한다.
 */
export async function chargeDueSubscriptions(
  db: Db,
  deps: {
    settings: ShopSettings;
    pointsPort?: PointsPort | null;
    notify: SubscriptionNotifier;
    log: (message: string) => void;
    /**
     * 성인 상품 회차 — 가입 때 확인했어도 회차마다 다시 본다. 인증이 지워졌으면(탈퇴 후
     * 복구·관리자 정리) 회차는 재고 부족과 같은 실패 경로로 간다.
     */
    isAdult?: (userId: string) => Promise<boolean>;
  },
): Promise<{ due: number; charged: number; failed: number; paused: number }> {
  const { rows: due } = await db.execute(sql`
    SELECT s.id, s.user_id, s.product_id, s.product_name, s.quantity, s.interval_unit,
           s.agreed_total, s.cycle_no, s.fail_count, s.orderer, s.next_charge_at,
           k.provider, k.billing_key, k.customer_key, k.revoked_at,
           u.email AS user_email,
           p.status AS product_status
    FROM shop_subscriptions s
    JOIN shop_billing_keys k ON k.id = s.billing_key_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN shop_products p ON p.id = s.product_id
    WHERE s.status = 'active' AND s.next_charge_at IS NOT NULL AND s.next_charge_at <= now()
      -- 탈퇴는 구독을 해지한다(쇼핑몰 eraser). 그 전에 만들어진 구독이 남았어도 청구하지 않는다
      AND u.withdrawn_at IS NULL AND k.billing_key <> ''
    ORDER BY s.next_charge_at
    LIMIT 50
  `);

  let charged = 0; let failed = 0; let paused = 0;

  // 첫 결제를 확인하지 못한 가입부터 끝낸다 — 결제일 청구와 따로 센다
  await settleFirstCharges(db, deps).catch((err: unknown) => {
    deps.log(`정기결제 첫 결제 확인 오류: ${err instanceof Error ? err.message : String(err)}`);
  });

  for (const sub of due) {
    const subId = String(sub.id);
    const cycleNo = Number(sub.cycle_no);
    const email = String(sub.user_email);
    const name = String(sub.product_name);
    try {
      const halt = async (reason: string) => {
        await pauseSubscription(db, subId, cycleNo, reason);
        paused += 1;
        await deps.notify({
          userId: String(sub.user_id),
          email,
          subject: t("subsmail.pausedSubject", { name }),
          text: `${t("subsmail.pausedBody")}\n\n${t("subsmail.product", { name })}\n` +
                `${t("subsmail.reason", { reason })}\n\n${t("subsmail.pausedWhere")}`,
        }).catch(() => false);
      };

      // 청구 전에 멈춰야 하는 조건들 — 전부 "결제된 금액은 없습니다"가 참이다
      if (!sub.product_id || sub.product_status !== "selling") {
        await halt("상품 판매가 종료되었습니다.");
        continue;
      }
      if (sub.revoked_at) {
        await halt("결제 카드가 삭제되었습니다.");
        continue;
      }
      const gateway = billingGateway(String(sub.provider));
      if (!gateway) {
        await halt("결제수단을 지금 사용할 수 없습니다.");
        continue;
      }

      const nextCycle = cycleNo + 1;
      const idemKey = `sub-${subId}-c${nextCycle}`;
      // PG 멱등키는 시도 단위다 — PG 는 같은 키에 저장된 응답을 그대로 돌려주므로,
      // 회차 단위로 하면 첫 실패 응답이 재생되어 카드를 고쳐도 영원히 실패한다.
      const pgIdemKey = `${idemKey}-a${Number(sub.fail_count)}`;
      const orderer = sub.orderer as OrdererInput;

      // 회차 주문 — 재고 부족 등은 결제 실패와 같은 재시도 경로를 탄다
      let order: { id: string; orderNo: string; total: number };
      try {
        order = await createOrder(db, {
          items: [{ productId: String(sub.product_id), quantity: Number(sub.quantity) }],
          orderer,
          userId: String(sub.user_id),
          settings: deps.settings,
          idempotencyKey: idemKey,
          pointsPort: deps.pointsPort ?? null,
          isAdult: deps.isAdult ? () => deps.isAdult!(String(sub.user_id)) : undefined,
        });
      } catch (err) {
        const reason = err instanceof ShopError ? err.message : "주문 생성 실패";
        await recordFailure(db, deps, { subId, cycleNo, userId: String(sub.user_id), email, name, reason });
        failed += 1;
        continue;
      }

      // 크래시 복구: 이전 시도가 결제까지 마치고 회차 전진 전에 죽었다면
      // 멱등키가 이미 결제된 주문을 돌려준다 — 다시 청구하면 이중 청구다.
      const { rows: existing } = await db.execute(sql`
        SELECT payment_status FROM shop_orders WHERE id = ${order.id}::uuid
      `);
      const alreadyPaid = existing[0]?.payment_status === "paid";

      // 청구액 대조 — 가입 때 합의한 금액과 다르면 결제하지 않는다.
      // 가격 인상·배송비 변경이 여기서 잡힌다. 몰래 청구하는 것이 아니라
      // 멈추고 알리는 것이 맞다.
      if (!alreadyPaid && order.total !== Number(sub.agreed_total)) {
        await abandonCycleOrder(db, order.id, "정기결제 청구액 변경으로 중지");
        await halt(
          t("sub.amountChanged", {
            agreed: money(Number(sub.agreed_total)),
            current: money(Number(order.total)),
          }),
        );
        continue;
      }

      if (!alreadyPaid) {
        const result = await chargeOrder(db, {
          gateway,
          billingKey: String(sub.billing_key),
          customerKey: String(sub.customer_key),
          orderId: order.id,
          orderNo: order.orderNo,
          amount: order.total,
          orderName: `${name} 정기배송 ${nextCycle}회차`,
          idempotencyKey: pgIdemKey,
          pointsPort: deps.pointsPort ?? null,
        });

        if (!result.ok && result.pending) {
          // 다른 청구가 같은 회차를 처리 중이다 — 주문도 실패 기록도 건드리지 않는다.
          // 여기서 주문을 취소한 것이 "긁혔는데 취소된" 사고의 직접 원인이었다.
          deps.log(`정기결제: ${subId} ${nextCycle}회차는 다른 청구가 처리 중이라 건너뜁니다`);
          continue;
        }
        if (!result.ok) {
          await abandonCycleOrder(db, order.id, `정기결제 실패: ${result.reason}`);
          // 로그에는 자세히, 손님이 읽는 곳(이력·멈춤 사유·메일)에는 보여도 되는 것만
          deps.log(`정기결제 청구 실패 (${subId}, ${cycleNo}회차): ${result.reason}`);
          await recordFailure(db, deps, {
            subId, cycleNo, userId: String(sub.user_id), email, name, reason: result.customerReason,
          });
          failed += 1;
          continue;
        }
      }

      // 성공 — 다음 예정일로 전진. 밀린 회차는 몰아 청구하지 않는다:
      // 예정일+주기가 이미 지났으면 지금부터 한 주기 뒤로 잡는다.
      const step = sql.raw(String(sub.interval_unit) === "week" ? "interval '7 days'" : "interval '1 month'");
      // **읽었던 회차일 때만** 전진한다. 겹쳐 돈 청구가 이미 전진시켰다면 여기서 한 번
      // 더 밀면 다음 결제일이 두 주기 뒤로 간다 — 손님이 한 달을 건너뛴다.
      const { rows: advanced } = await db.execute(sql`
        UPDATE shop_subscriptions
        SET cycle_no = ${nextCycle}, fail_count = 0,
            next_charge_at = CASE
              WHEN next_charge_at + ${step} > now() THEN next_charge_at + ${step}
              ELSE now() + ${step}
            END
        WHERE id = ${subId}::uuid AND cycle_no = ${cycleNo}
        RETURNING id
      `);
      if (!advanced.length) continue;
      // ON CONFLICT: 크래시 복구 재실행에서 같은 회차 이벤트가 이미 있을 수 있다
      await db.execute(sql`
        INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, order_no, detail)
        VALUES (${uuidv7()}, ${subId}::uuid, ${nextCycle}, 'charged', ${order.orderNo},
                ${`${order.total.toLocaleString("ko-KR")}원`})
        ON CONFLICT DO NOTHING
      `);
      charged += 1;
    } catch (err) {
      // 한 구독의 예기치 못한 오류가 스윕 전체를 죽이면 안 된다
      deps.log(`정기결제 처리 오류 (${subId}): ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  return { due: due.length, charged, failed, paused };
}

/** 가입 요청이 아직 돌고 있을 수 있는 동안은 건드리지 않는다 */
const FIRST_CHARGE_GRACE = "5 minutes";

/**
 * 첫 결제를 확인하지 못한 가입을 끝낸다.
 *
 * 가입의 첫 청구가 "처리 중" 으로 끝나면(PG 응답을 잃고 조회도 안 됐다) 구독은 다음 결제일 없이 남는다. 결제일
 * 청구는 결제일이 있는 구독만 집으므로, **그런 구독은 아무도 끝내지 않았다** — 카드는 긁혔을 수 있는데 구독은
 * 열리지 않고, 손님은 "잠시 뒤 확인하세요" 를 들은 채 기다린다.
 *
 * 같은 회차 키로 다시 청구한다 — PG 는 같은 키(포트원은 같은 결제 ID)의 두 번째 청구를 새로 긁지 않고 먼저 간
 * 결과를 돌려준다. 결제됐으면 구독을 열고, 거절되면 가입을 거둔다(주문 취소·재고 복원, 구독은 해지로 남겨
 * 손님이 이유를 본다). 아직도 모르면 다음 스윕에 다시 본다.
 */
async function settleFirstCharges(
  db: Db,
  deps: { pointsPort?: PointsPort | null; log: (message: string) => void },
): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT s.id, s.product_name, s.interval_unit,
           k.provider, k.billing_key, k.customer_key, k.revoked_at,
           o.id AS order_id, o.order_no, o.total, o.status AS order_status, o.payment_status
    FROM shop_subscriptions s
    JOIN shop_billing_keys k ON k.id = s.billing_key_id
    LEFT JOIN shop_orders o ON o.idempotency_key = 'sub-' || s.id::text || '-c1'
    WHERE s.status = 'active' AND s.next_charge_at IS NULL AND s.cycle_no = 1
      AND s.created_at < now() - ${sql.raw(`interval '${FIRST_CHARGE_GRACE}'`)}
    ORDER BY s.created_at
    LIMIT 20
  `);
  for (const s of rows) {
    const subId = String(s.id);
    try {
      /** 가입을 거둔다 — 구독은 지우지 않고 해지로 남긴다(손님이 내 정기배송에서 이유를 본다) */
      const drop = async (reason: string, customerReason: string) => {
        if (s.order_id) await abandonCycleOrder(db, String(s.order_id), `정기결제 가입 실패: ${reason}`);
        const { rows: gone } = await db.execute(sql`
          UPDATE shop_subscriptions SET status = 'cancelled', cancelled_at = now(), pause_reason = ${customerReason}
          WHERE id = ${subId}::uuid AND status = 'active' AND next_charge_at IS NULL RETURNING id
        `);
        if (gone.length) {
          await db.execute(sql`
            INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
            VALUES (${uuidv7()}, ${subId}::uuid, 1, 'cancelled', ${`첫 결제 실패: ${customerReason}`})
          `);
        }
        deps.log(`정기결제 가입 ${subId}: 첫 결제를 확인하지 못해 거둡니다 (${reason})`);
      };

      // 첫 회차 주문이 없거나 이미 취소됐다(운영자가 취소했다 등) — 열 구독이 아니다
      if (!s.order_id || s.order_status === "cancelled") {
        await drop("첫 회차 주문 없음", t("pay.failed"));
        continue;
      }
      if (s.payment_status !== "paid") {
        const gateway = billingGateway(String(s.provider));
        // 결제수단이 꺼져 있다 — 물어볼 곳이 없다. 판단하지 않고 다음에 다시 본다(켜지면 끝난다)
        if (!gateway) continue;
        if (s.revoked_at || !String(s.billing_key ?? "")) {
          // 카드를 지웠다 — 긁혔는지 모르는 채로 새로 긁을 수 없다. 같은 키로 묻기만 하는 길이 없으니 사람이 본다
          deps.log(`정기결제 가입 ${subId}: 첫 결제 확인 전에 카드가 삭제됐습니다 — 주문 ${String(s.order_no)} 을 PG 에서 확인하세요`);
          continue;
        }
        const result = await chargeOrder(db, {
          gateway,
          billingKey: String(s.billing_key),
          customerKey: String(s.customer_key),
          orderId: String(s.order_id),
          orderNo: String(s.order_no),
          amount: Number(s.total),
          orderName: `${String(s.product_name)} 정기배송 1회차`,
          idempotencyKey: `sub-${subId}-c1`,
          pointsPort: deps.pointsPort ?? null,
        });
        if (!result.ok && result.pending) continue;
        if (!result.ok) {
          await drop(result.reason, result.customerReason);
          continue;
        }
      }
      const step = sql.raw(String(s.interval_unit) === "week" ? "interval '7 days'" : "interval '1 month'");
      const { rows: opened } = await db.execute(sql`
        UPDATE shop_subscriptions SET next_charge_at = now() + ${step}
        WHERE id = ${subId}::uuid AND status = 'active' AND next_charge_at IS NULL RETURNING id
      `);
      if (opened.length) {
        await db.execute(sql`
          INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, order_no, detail)
          VALUES (${uuidv7()}, ${subId}::uuid, 1, 'charged', ${String(s.order_no)},
                  ${`가입 · ${Number(s.total).toLocaleString("ko-KR")}원 (결제 확인 뒤)`})
          ON CONFLICT DO NOTHING
        `);
      }
    } catch (err) {
      deps.log(`정기결제 가입 ${subId} 첫 결제 확인 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 실패 기록 — 하루 뒤 재시도, MAX_FAILS 연속이면 멈추고 알린다 */
async function recordFailure(
  db: Db,
  deps: { notify: SubscriptionNotifier },
  params: { subId: string; cycleNo: number; userId: string; email: string; name: string; reason: string },
): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE shop_subscriptions
    SET fail_count = fail_count + 1,
        next_charge_at = now() + ${sql.raw(`interval '${RETRY_DELAY_HOURS} hours'`)}
    WHERE id = ${params.subId}::uuid
    RETURNING fail_count
  `);
  const fails = Number(rows[0]?.fail_count ?? 0);
  await db.execute(sql`
    INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
    VALUES (${uuidv7()}, ${params.subId}::uuid, ${params.cycleNo}, 'failed',
            ${`${params.reason} (${fails}회째)`})
  `);

  if (fails >= MAX_FAILS) {
    await db.execute(sql`
      UPDATE shop_subscriptions SET status = 'paused',
        pause_reason = ${`결제가 ${MAX_FAILS}회 연속 실패했습니다: ${params.reason}`}
      WHERE id = ${params.subId}::uuid AND status = 'active'
    `);
    await db.execute(sql`
      INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
      VALUES (${uuidv7()}, ${params.subId}::uuid, ${params.cycleNo}, 'paused',
              ${`${MAX_FAILS}회 연속 실패`})
    `);
    await deps.notify({
      userId: params.userId,
      email: params.email,
      subject: t("subsmail.pausedSubject", { name: params.name }),
      text: `${t("subsmail.pausedFailBody", { n: MAX_FAILS })}\n\n` +
            `${t("subsmail.product", { name: params.name })}\n${t("subsmail.reason", { reason: params.reason })}\n\n` +
            `${t("subsmail.pausedResume")}`,
    }).catch(() => false);
  } else {
    await deps.notify({
      userId: params.userId,
      email: params.email,
      subject: t("subsmail.failSubject", { name: params.name }),
      text: `${t("subsmail.failBody", { hours: RETRY_DELAY_HOURS })}\n\n` +
            `${t("subsmail.product", { name: params.name })}\n${t("subsmail.reason", { reason: params.reason })}\n` +
            `${t("subsmail.failNote", { n: MAX_FAILS })}`,
    }).catch(() => false);
  }
}

// ── 해지 · 재개 · 조회 ───────────────────────────────

/**
 * 해지 — 항상, 즉시, 조건 없이. 이미 결제된 회차는 그대로 배송되고
 * (환불은 별도의 반품 절차), 다음 청구가 없어질 뿐이다.
 */
export async function cancelSubscription(
  db: Db,
  params: { id: string; userId?: string | null; actor: "member" | "admin" },
): Promise<{ ok: true }> {
  const owner = params.userId
    ? sql` AND user_id = ${params.userId}::uuid`
    : sql``;
  const { rows } = await db.execute(sql`
    UPDATE shop_subscriptions
    SET status = 'cancelled', cancelled_at = now(), next_charge_at = NULL
    WHERE id = ${params.id}::uuid AND status <> 'cancelled' ${owner}
    RETURNING cycle_no
  `);
  if (!rows.length) {
    // 이미 해지된 경우는 성공으로 — 해지 버튼을 두 번 누른 회원에게 오류를 보여줄 이유가 없다
    const { rows: exists } = await db.execute(sql`
      SELECT 1 FROM shop_subscriptions WHERE id = ${params.id}::uuid AND status = 'cancelled' ${owner}
    `);
    if (exists.length) return { ok: true };
    throw new ShopError(404, "구독을 찾을 수 없습니다.");
  }
  await db.execute(sql`
    INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
    VALUES (${uuidv7()}, ${params.id}::uuid, ${Number(rows[0].cycle_no)}, 'cancelled',
            ${params.actor === "admin" ? "관리자 해지" : "회원 해지"})
  `);
  return { ok: true };
}

/** 재개 — 멈춘 구독만, 유효한 카드가 있어야. 다음 스윕에서 바로 청구된다 */
export async function resumeSubscription(
  db: Db,
  params: { id: string; userId: string; billingKeyId?: string | null },
): Promise<{ ok: true }> {
  const { rows } = await db.execute(sql`
    SELECT s.id, s.cycle_no, s.billing_key_id, k.revoked_at
    FROM shop_subscriptions s JOIN shop_billing_keys k ON k.id = s.billing_key_id
    WHERE s.id = ${params.id}::uuid AND s.user_id = ${params.userId}::uuid AND s.status = 'paused'
    LIMIT 1
  `);
  const sub = rows[0];
  if (!sub) throw new ShopError(404, "멈춰 있는 구독을 찾을 수 없습니다.");

  let keyId = String(sub.billing_key_id);
  if (params.billingKeyId) {
    const { rows: keys } = await db.execute(sql`
      SELECT id FROM shop_billing_keys
      WHERE id = ${params.billingKeyId}::uuid AND user_id = ${params.userId}::uuid AND revoked_at IS NULL
    `);
    if (!keys.length) throw new ShopError(404, "등록된 카드를 찾을 수 없습니다.");
    keyId = String(keys[0].id);
  } else if (sub.revoked_at) {
    throw new ShopError(400, "결제 카드가 삭제되었습니다. 카드를 새로 등록하고 그 카드로 재개해주세요.");
  }

  await db.execute(sql`
    UPDATE shop_subscriptions
    SET status = 'active', pause_reason = NULL, fail_count = 0,
        billing_key_id = ${keyId}::uuid, next_charge_at = now()
    WHERE id = ${params.id}::uuid
  `);
  await db.execute(sql`
    INSERT INTO shop_subscription_events (id, subscription_id, cycle_no, kind, detail)
    VALUES (${uuidv7()}, ${params.id}::uuid, ${Number(sub.cycle_no)}, 'resumed', '회원 재개')
  `);
  return { ok: true };
}

export async function listMySubscriptions(db: Db, userId: string) {
  const { rows } = await db.execute(sql`
    SELECT s.id, s.product_name, s.quantity, s.interval_unit, s.agreed_total,
           s.status, s.pause_reason, s.cycle_no, s.next_charge_at, s.created_at, s.cancelled_at,
           k.card_label
    FROM shop_subscriptions s JOIN shop_billing_keys k ON k.id = s.billing_key_id
    WHERE s.user_id = ${userId}::uuid
    ORDER BY s.created_at DESC
  `);
  return rows.map((r) => ({
    id: String(r.id),
    productName: String(r.product_name),
    quantity: Number(r.quantity),
    interval: String(r.interval_unit),
    intervalLabel: INTERVAL_LABEL[String(r.interval_unit)] ?? String(r.interval_unit),
    amount: Number(r.agreed_total),
    status: String(r.status),
    pauseReason: r.pause_reason ? String(r.pause_reason) : null,
    cycleNo: Number(r.cycle_no),
    nextChargeAt: r.next_charge_at,
    cardLabel: r.card_label ? String(r.card_label) : null,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
  }));
}

export async function subscriptionEvents(db: Db, subId: string, userId: string | null) {
  const owner = userId ? sql` AND s.user_id = ${userId}::uuid` : sql``;
  const { rows } = await db.execute(sql`
    SELECT e.cycle_no, e.kind, e.order_no, e.detail, e.created_at
    FROM shop_subscription_events e
    JOIN shop_subscriptions s ON s.id = e.subscription_id
    WHERE e.subscription_id = ${subId}::uuid ${owner}
    ORDER BY e.created_at DESC
    LIMIT 100
  `);
  return rows;
}

/** 관리자 목록 — 상태·회차·다음 결제일. 수정은 해지뿐(회원의 계약이다) */
export async function listSubscriptionsAdmin(db: Db, page = 1) {
  const p = Math.max(1, Math.floor(page));
  const { rows } = await db.execute(sql`
    SELECT s.id, s.product_name, s.quantity, s.interval_unit, s.agreed_total, s.status,
           s.pause_reason, s.cycle_no, s.next_charge_at, s.created_at,
           u.email AS user_email
    FROM shop_subscriptions s JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC
    LIMIT 30 OFFSET ${(p - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM shop_subscriptions`);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      user_email: String(r.user_email),
      product_name: String(r.product_name),
      quantity: Number(r.quantity),
      interval_label: INTERVAL_LABEL[String(r.interval_unit)] ?? String(r.interval_unit),
      amount: Number(r.agreed_total),
      status_label:
        r.status === "active" ? "진행 중"
        : r.status === "paused" ? `중지 (${r.pause_reason ?? ""})`
        : "해지됨",
      cycle_no: Number(r.cycle_no),
      next_charge_at: r.next_charge_at,
      created_at: r.created_at,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page: p,
    pageSize: 30,
  };
}
