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
import type { Db, ShopSettings } from "./types.js";
import { ShopError } from "./types.js";
import { createOrder, changeOrderStatus, type OrdererInput, type PointsPort } from "./orders.js";
import { gateways, type PaymentGateway } from "./payments.js";

export const SUBSCRIPTION_QUEUE_JOB = "shop.subscription.charge";

const MAX_FAILS = 3;
const RETRY_DELAY_HOURS = 24;

const INTERVAL_LABEL: Record<string, string> = { week: "매주", month: "매월" };

export interface SubscriptionNotifier {
  (params: { email: string; subject: string; text: string }): Promise<boolean>;
}

/** 두 메서드를 모두 구현한 게이트웨이만 정기결제를 지원한다 */
function billingGateway(provider: string): PaymentGateway | null {
  const g = gateways.get(provider);
  if (!g || !g.issueBillingKey || !g.chargeBillingKey) return null;
  return g;
}

export function listBillingProviders(): Array<{ provider: string; displayName: string }> {
  return [...gateways.values()]
    .filter((g) => g.issueBillingKey && g.chargeBillingKey)
    .map((g) => ({ provider: g.provider, displayName: g.displayName }));
}

// ── 빌링키 ──────────────────────────────────────────

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

  const result = await gateway.issueBillingKey!({ authKey, customerKey });
  if (!result.ok || !result.billingKey) {
    throw new ShopError(402, result.failureReason ?? "카드 등록에 실패했습니다.");
  }

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
): Promise<{ ok: true } | { ok: false; reason: string }> {
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

  if (!result.ok || !result.providerTid) {
    const reason = (result.failureReason ?? "청구 실패").slice(0, 500);
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed', failure_reason = ${reason},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    return { ok: false, reason };
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
    return { ok: false, reason: "승인 금액이 청구 금액과 일치하지 않습니다." };
  }

  await db.execute(sql`
    UPDATE shop_payments SET status = 'paid', provider_tid = ${result.providerTid},
      method = ${result.method ?? "카드"},
      raw = ${JSON.stringify(result.raw ?? null)}::jsonb, approved_at = now(), updated_at = now()
    WHERE id = ${paymentId}
  `);
  await db.execute(sql`
    UPDATE shop_orders SET payment_method = ${params.gateway.provider}, updated_at = now()
    WHERE id = ${params.orderId}::uuid
  `);
  await changeOrderStatus(db, params.orderId, "paid", {
    note: `정기결제 승인 (${approved.toLocaleString("ko-KR")}원)`,
    pointsPort: params.pointsPort ?? null,
  });
  return { ok: true };
}

// ── 가입 ────────────────────────────────────────────

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
  },
): Promise<{ id: string; orderNo: string; total: number; nextChargeAt: unknown }> {
  const quantity = Math.max(1, Math.floor(Number(params.quantity ?? 1)));

  const { rows: products } = await db.execute(sql`
    SELECT id, name, status, sub_interval FROM shop_products
    WHERE slug = ${String(params.productSlug ?? "")} LIMIT 1
  `);
  const product = products[0];
  if (!product) throw new ShopError(404, "상품을 찾을 수 없습니다.");
  if (!product.sub_interval) throw new ShopError(400, "정기배송 상품이 아닙니다.");
  if (product.status !== "selling") throw new ShopError(400, "지금은 판매하지 않는 상품입니다.");
  const interval = String(product.sub_interval);

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

  if (!charged.ok) {
    // 첫 결제 실패 = 가입 실패. 주문을 취소해 재고를 되돌리고 구독을 지운다.
    await abandonCycleOrder(db, order.id, `정기결제 가입 실패: ${charged.reason}`);
    await db.execute(sql`DELETE FROM shop_subscriptions WHERE id = ${subId}`);
    throw new ShopError(402, `결제에 실패했습니다: ${charged.reason}`);
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
 * 결제일이 된 구독을 청구한다. 큐 워커 한 곳에서만 돈다.
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
    ORDER BY s.next_charge_at
    LIMIT 50
  `);

  let charged = 0; let failed = 0; let paused = 0;

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
          email,
          subject: `[정기배송 중지] ${name}`,
          text: `정기배송이 중지되었습니다.\n\n상품: ${name}\n사유: ${reason}\n\n` +
                `마이페이지 > 정기배송에서 확인하실 수 있습니다. 결제된 금액은 없습니다.`,
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
        });
      } catch (err) {
        const reason = err instanceof ShopError ? err.message : "주문 생성 실패";
        await recordFailure(db, deps, { subId, cycleNo, email, name, reason });
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
          `청구 금액이 달라졌습니다 (가입 시 ${Number(sub.agreed_total).toLocaleString("ko-KR")}원 → ` +
          `현재 ${order.total.toLocaleString("ko-KR")}원). 변경된 금액으로 계속하려면 다시 가입해주세요.`,
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

        if (!result.ok) {
          await abandonCycleOrder(db, order.id, `정기결제 실패: ${result.reason}`);
          await recordFailure(db, deps, { subId, cycleNo, email, name, reason: result.reason });
          failed += 1;
          continue;
        }
      }

      // 성공 — 다음 예정일로 전진. 밀린 회차는 몰아 청구하지 않는다:
      // 예정일+주기가 이미 지났으면 지금부터 한 주기 뒤로 잡는다.
      const step = sql.raw(String(sub.interval_unit) === "week" ? "interval '7 days'" : "interval '1 month'");
      await db.execute(sql`
        UPDATE shop_subscriptions
        SET cycle_no = ${nextCycle}, fail_count = 0,
            next_charge_at = CASE
              WHEN next_charge_at + ${step} > now() THEN next_charge_at + ${step}
              ELSE now() + ${step}
            END
        WHERE id = ${subId}::uuid
      `);
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

/** 실패 기록 — 하루 뒤 재시도, MAX_FAILS 연속이면 멈추고 알린다 */
async function recordFailure(
  db: Db,
  deps: { notify: SubscriptionNotifier },
  params: { subId: string; cycleNo: number; email: string; name: string; reason: string },
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
      email: params.email,
      subject: `[정기배송 중지] ${params.name}`,
      text: `결제가 ${MAX_FAILS}회 연속 실패하여 정기배송이 중지되었습니다.\n\n` +
            `상품: ${params.name}\n사유: ${params.reason}\n\n` +
            `카드를 확인하신 뒤 마이페이지 > 정기배송에서 재개할 수 있습니다.`,
    }).catch(() => false);
  } else {
    await deps.notify({
      email: params.email,
      subject: `[정기배송 결제 실패] ${params.name}`,
      text: `정기배송 결제에 실패했습니다. ${RETRY_DELAY_HOURS}시간 뒤 다시 시도합니다.\n\n` +
            `상품: ${params.name}\n사유: ${params.reason}\n` +
            `(${MAX_FAILS}회 연속 실패하면 정기배송이 중지됩니다)`,
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
