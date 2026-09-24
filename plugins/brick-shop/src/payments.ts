import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db, OrderStatus } from "./types.js";
import { ShopError, STATUS_LABEL } from "./types.js";
import { changeOrderStatus, type PointsPort } from "./orders.js";
import { isUniqueViolation } from "@brick/plugin-sdk";
import { t, money, label } from "./i18n.js";
import { gateways, registerGateway } from "./gateway-registry.js";

/**
 * 결제 게이트웨이 추상화.
 *
 * Brick은 특정 PG에 묶이지 않는다. PG별 구현은 별도 플러그인이 등록하고,
 * brick-shop은 이 인터페이스만 안다.
 */
export interface PaymentGateway {
  /** "toss", "inicis", "kcp" 등 */
  readonly provider: string;
  readonly displayName: string;
  /**
   * PG에 승인을 요청한다.
   * 반드시 PG가 실제로 받은 금액을 반환해야 한다 — brick-shop이 주문 금액과 대조한다.
   */
  confirm(params: {
    orderNo: string;
    /** PG가 발급한 거래 키 */
    providerTid: string;
    /** 클라이언트가 주장하는 금액 (검증용으로만 쓰고 신뢰하지 않는다) */
    claimedAmount: number;
  }): Promise<{
    ok: boolean;
    /** PG가 확인한 실제 승인 금액 */
    approvedAmount?: number;
    method?: string;
    raw?: unknown;
    /**
     * 실패 이유 — **기록과 운영자용**이다. 그대로 저장하고 로그에 남긴다.
     * 손님에게 그대로 보이지 않는다(아래 customerReason 참고).
     */
    failureReason?: string;
    /**
     * 손님에게 **보여도 되는** 실패 이유.
     *
     * PG 가 "카드 한도를 초과하였습니다" 처럼 손님이 고칠 수 있는 사유를 준
     * 경우에만 채운다. 네트워크 오류·타임아웃·설정 누락·PG 장애처럼 손님이
     * 어쩔 수 없는 것은 **비워 둔다** — 그러면 호출자가 일반 안내를 보여준다.
     *
     * 비워 두는 것이 기본이다. 예전에는 failureReason 이 그대로 402 의 문장이
     * 되어 `TypeError: fetch failed` 나 PG 서버 주소가 손님 화면에 떴다.
     */
    customerReason?: string;
  }>;
  /** 취소/환불. amount를 주면 부분 환불 */
  /**
   * 취소/환불. amount를 주면 부분 환불.
   *
   * `idempotencyKey` 는 **이 취소 동작 하나를 가리키는 값**이다. 게이트웨이는
   * 그것을 PG 의 멱등키로 넘겨야 한다 — 네트워크 재시도로 같은 취소가 두 번
   * 처리되는 것을 PG 쪽에서도 막는다.
   *
   * 게이트웨이가 자기 마음대로 키를 만들면 안 된다. 금액만으로 만들면
   * **같은 금액의 서로 다른 취소가 하나로 합쳐진다** — 같은 가격 상품 두 개를
   * 따로 반품하면 두 번째 환불이 PG 에서 재생되고, 우리는 환불했다고 기록한다.
   * 돌려줘야 할 돈이 사업자에게 남는다.
   */
  /**
   * 결제수단으로 노출해도 되는 상태인가.
   *
   * 없으면 항상 준비된 것으로 본다(무통장입금 등).
   *
   * 이것이 없어서 **키를 넣지 않은 PG 가 주문서에 결제수단으로 떴다.**
   * 손님이 그것을 고르면 "설정되지 않았습니다"로 실패한다 — 사이트가 고장난
   * 것처럼 보이고, 그 손님은 다시 오지 않는다.
   */
  isReady?(): Promise<boolean>;
  /**
   * 주문을 만든 **뒤** 손님을 PG 로 넘기는 클라이언트 단계.
   *
   * 없으면 주문만 만들고 끝난다 — 무통장입금처럼 **나중에 돈이 들어오는**
   * 결제수단이다. 카드처럼 그 자리에서 승인이 나야 하는 수단은 반드시 이것을
   * 선언해야 한다. 선언하지 않으면 주문서는 그 수단을 **내놓지 않는다**:
   * 고를 수는 있는데 승인으로 가는 길이 없으면, 손님은 결제했다고 믿고
   * 사업자는 받지 못한 주문을 배송하게 된다. 키를 넣지 않은 PG 를 감추는
   * `isReady` 와 같은 원칙이다.
   *
   * `script` 는 주문서에 함께 실린다. 그 안에서 전역 함수 하나를 정의한다:
   *
   * ```js
   * window.brickPay["toss"] = async function (order) {
   *   // order: { orderNo, amount, orderName, returnUrl }
   *   // PG 화면으로 보낸다(리다이렉트해도 된다). 돌아온 뒤의 승인은
   *   // 주문서가 returnUrl 의 조회 문자열을 보고 /payments/confirm 으로 마친다.
   * };
   * window.brickPay["toss"].readReturn = (query) => ({ providerTid, amount }) | null;
   * ```
   *
   * 정기결제까지 지원한다면 카드 등록 단계도 같은 자리에 붙인다 — 이것이 없으면
   * 회원은 카드를 등록할 수 없고, 카드가 없으면 정기배송에 가입할 수 없다:
   *
   * ```js
   * window.brickPay["toss"].registerCard = async ({ customerKey, returnUrl }) => { … };
   * window.brickPay["toss"].readCardReturn = (query) => ({ authKey, customerKey }) | null;
   * ```
   */
  checkout?: {
    /** 주문서에 함께 실을 `<script>` 문자열 */
    script: string;
  };
  /**
   * 정기결제 — 빌링키 발급 (선택 구현).
   *
   * 카드 등록은 PG 의 화면에서 일어난다. 우리는 그 결과(authKey)를 받아
   * PG 에 빌링키 발급을 요청할 뿐 — **카드번호는 이 시스템을 지나가지 않는다.**
   * 두 메서드를 모두 구현한 게이트웨이만 정기결제를 지원한다.
   */
  issueBillingKey?(params: {
    /** PG 카드 등록 화면이 돌려준 1회용 키 */
    authKey: string;
    /** 우리가 회원에게 발급한 PG용 고객 식별자 */
    customerKey: string;
  }): Promise<{
    ok: boolean;
    billingKey?: string;
    /** "신한 ****1234" — 회원에게 보여줄 표시 */
    cardLabel?: string;
    failureReason?: string;
  }>;
  /**
   * 빌링키로 청구한다. 반드시 PG 가 실제로 승인한 금액을 반환해야 한다 —
   * 호출자가 주문 금액과 대조한다.
   *
   * `idempotencyKey` 는 회차 하나를 가리킨다 — 네트워크 재시도로 같은 회차가
   * 두 번 청구되는 것을 PG 쪽에서도 막는다.
   */
  chargeBillingKey?(params: {
    billingKey: string;
    customerKey: string;
    orderNo: string;
    amount: number;
    orderName: string;
    idempotencyKey: string;
  }): Promise<{
    ok: boolean;
    /** PG 가 발급한 거래 키 — 환불에 필요하다 */
    providerTid?: string;
    approvedAmount?: number;
    method?: string;
    raw?: unknown;
    /** 기록·운영자용 (confirm 과 같은 규칙) */
    failureReason?: string;
    /** 손님에게 보여도 되는 이유 — 없으면 호출자가 일반 안내를 쓴다 */
    customerReason?: string;
    /**
     * PG 가 **같은 멱등키의 요청을 아직 처리 중**이라며 거절했다. 성공도 실패도 아니다.
     *
     * 이 세 번째 경우가 계약에 없어서 실패로 뭉뚱그려졌고, 겹쳐 돈 청구 중 늦은 쪽이
     * 그 회차 주문을 취소했다 — 먼저 간 쪽의 청구는 그 뒤에 승인되었으므로 **카드는
     * 긁혔는데 주문은 취소되고 환불도 없었다.** 호출자는 이것을 받으면 아무것도
     * 건드리지 말고 물러나야 한다(먼저 간 쪽이 끝낸다).
     */
    pending?: boolean;
  }>;
  cancel(params: {
    providerTid: string;
    amount?: number;
    reason: string;
    idempotencyKey?: string;
    /**
     * 이 취소 **전에** 남아 있던 취소 가능 금액(결제액 − 누적 환불액). 모를 때는 비운다.
     *
     * PG 가 지원하면(포트원의 currentCancellableAmount) 실제 잔액과 다를 때 취소를 거절한다
     * — 커밋되지 않은 재시도로 같은 부분환불이 두 번 나가는 것을 PG 쪽에서도 막는다.
     * 멱등키를 지원하지 않는 PG 에게는 이것이 그 역할을 한다.
     */
    currentCancellable?: number;
  }): Promise<{
    ok: boolean;
    raw?: unknown;
    failureReason?: string;
  }>;
}

/* 보관소는 gateway-registry.ts 에 있다(순환 참조를 피하려고) — 여기서는 그대로 다시 낸다 */
export { gateways, registerGateway };

/**
 * 결제 승인 처리 — 커머스에서 가장 위험한 코드 경로.
 *
 * 방어하는 것:
 *  1. **금액 위조** — PG가 확인한 금액과 주문 총액이 정확히 일치해야 승인한다.
 *     일치하지 않으면 즉시 취소를 시도하고 실패로 기록한다.
 *     (클라이언트가 보낸 금액은 절대 신뢰하지 않는다)
 *  2. **중복 승인** — (provider, provider_tid) unique 로 DB가 막는다.
 *     같은 웹훅이 두 번 와도 재고·매출이 이중 계상되지 않는다.
 *  3. **경합** — 주문 행을 FOR UPDATE로 잠근 뒤 상태를 바꾼다.
 *  4. **이미 결제된 주문** — pending이 아니면 거부한다.
 */
export async function confirmPayment(
  db: Db,
  params: {
    orderNo: string;
    provider: string;
    providerTid: string;
    claimedAmount?: number;
    actorId?: string | null;
    pointsPort?: PointsPort | null;
    /** 결제 완료를 알린다 (포인트 적립 등이 구독한다) */
    onPaid?: (info: { orderNo: string; userId: string | null; amount: number }) => Promise<void>;
  },
): Promise<{ ok: boolean; orderNo: string; amount: number }> {
  const gateway = gateways.get(params.provider);
  if (!gateway) throw new ShopError(400, t("err.unknownProvider", { provider: params.provider }));

  // ── 1. 주문 확인 (금액의 기준은 언제나 DB) ──────────
  const { rows: orderRows } = await db.execute(sql`
    SELECT id, order_no, status, total, payment_status, user_id
    FROM shop_orders WHERE order_no = ${params.orderNo} LIMIT 1
  `);
  const order = orderRows[0];
  if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");

  const orderTotal = Number(order.total);

  // 이미 결제된 주문에 다시 승인이 들어오면 멱등하게 성공 반환 (웹훅 재전송 대응)
  if (order.payment_status === "paid") {
    const { rows: existing } = await db.execute(sql`
      SELECT provider_tid FROM shop_payments
      WHERE order_id = ${String(order.id)}::uuid AND status = 'paid' LIMIT 1
    `);
    if (existing[0]?.provider_tid === params.providerTid) {
      return { ok: true, orderNo: params.orderNo, amount: orderTotal };
    }
    // 다른 거래로 같은 주문을 또 결제하려는 시도 — 즉시 취소해야 한다
    await gateway
      .cancel({ providerTid: params.providerTid, reason: "이미 결제 완료된 주문" })
      .catch(() => undefined);
    throw new ShopError(409, "이미 결제가 완료된 주문입니다.");
  }
  if (order.status !== "pending") {
    throw new ShopError(400, t("err.notPayableStatus", { status: label(STATUS_LABEL[order.status as OrderStatus] ?? String(order.status)) }));
  }

  // ── 2. 결제 시도 기록 (중복은 unique 인덱스가 막는다) ──
  const paymentId = uuidv7();
  try {
    await db.execute(sql`
      INSERT INTO shop_payments (id, order_id, provider, provider_tid, status, amount)
      VALUES (${paymentId}, ${String(order.id)}::uuid, ${params.provider}, ${params.providerTid},
              'requested', ${orderTotal})
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_payments_tid_uniq")) {
      // 같은 PG 거래가 이미 처리 중이거나 처리되었다 — 재고 이중 차감을 막는다
      throw new ShopError(409, "이미 처리된 결제입니다.");
    }
    throw err;
  }

  // ── 3. PG 승인 ─────────────────────────────────────
  const result = await gateway.confirm({
    orderNo: params.orderNo,
    providerTid: params.providerTid,
    claimedAmount: params.claimedAmount ?? orderTotal,
  });

  if (!result.ok) {
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed', failure_reason = ${(result.failureReason ?? "승인 실패").slice(0, 500)},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    /*
     * 손님에게는 **보여도 되는 것만** 보낸다.
     *
     * 예전에는 failureReason 이 그대로 402 의 문장이 되어, PG 가 닿지 않을 때
     * `TypeError: fetch failed` 가 결제 화면에 떴다 — 손님은 자기가 무엇을
     * 잘못했는지 알 수 없고, 우리는 서버 사정(주소·라이브러리)을 밖으로 흘린다.
     * 자세한 이유는 위에서 `shop_payments.failure_reason` 에 남겼다(운영자가 본다).
     */
    throw new ShopError(402, result.customerReason?.trim() || t("pay.failed"));
  }

  // ── 4. 금액 검증 — 위조 방어의 핵심 ─────────────────
  const approved = Number(result.approvedAmount);
  if (!Number.isFinite(approved) || approved !== orderTotal) {
    // 금액이 다르면 결제를 되돌린다. 이 상황은 공격이거나 심각한 버그다.
    await gateway
      .cancel({ providerTid: params.providerTid, reason: "주문 금액 불일치" })
      .catch(() => undefined);
    await db.execute(sql`
      UPDATE shop_payments SET status = 'failed',
        failure_reason = ${`금액 불일치: 주문 ${orderTotal}원 / 승인 ${approved}원`},
        raw = ${JSON.stringify(result.raw ?? null)}::jsonb, updated_at = now()
      WHERE id = ${paymentId}
    `);
    throw new ShopError(400, "결제 금액이 주문 금액과 일치하지 않습니다. 결제를 취소했습니다.");
  }

  // ── 5. 승인 확정 ───────────────────────────────────
  await db.execute(sql`
    UPDATE shop_payments SET status = 'paid', method = ${result.method ?? null},
      raw = ${JSON.stringify(result.raw ?? null)}::jsonb, approved_at = now(), updated_at = now()
    WHERE id = ${paymentId}
  `);
  await db.execute(sql`
    UPDATE shop_orders SET payment_method = ${params.provider}, updated_at = now()
    WHERE id = ${String(order.id)}::uuid
  `);
  // 상태 머신을 통해 전이한다 (이력이 남고 규칙이 검증된다)
  //
  // 결제창에 머무는 사이 주문이 취소됐을 수 있다(운영자의 수동 취소). 그러면 PG 는
  // 승인했는데 주문은 결제 상태가 될 수 없다 — 그대로 두면 손님은 결제되고 받을 것이
  // 없으며, 어느 화면도 "결제됨" 이라고 말하지 않아 아무도 환불하지 않는다. 정기결제가
  // 이 모양으로 사고를 냈다(subscriptions.ts). 받을 수 없는 주문의 돈은 돌려준다.
  const settled = await changeOrderStatus(db, String(order.id), "paid", {
    /*
     * 이력 note 는 **저장되는 데이터**다 — 화면 문구가 아니다.
     *
     * 그래서 번역하지 않는다. 쓰인 시점의 값으로 DB 에 남고, 나중에 사이트 언어를
     * 바꿔도 과거 이력이 함께 바뀌면 안 된다(그것은 기록의 개조다). 운영자가 읽는
     * 감사 기록이므로 한국어로 고정한다.
     */
    note: `${gateway.displayName} 결제 승인 (${approved.toLocaleString("ko-KR")}원)`,
    actorId: params.actorId ?? null,
    pointsPort: params.pointsPort ?? null,
    // onlyFrom 을 쓰지 않는다 — 그것은 조건이 안 맞으면 **조용히** false 를 돌려주는데,
    // 여기서 알아야 하는 것은 바로 그 경우(취소됨)다. 취소→결제완료는 허용되지 않은
    // 전이라 예외가 나고, 그 예외로 판단한다.
  }).then(() => true, async (err) => {
    const { rows: now } = await db.execute(sql`SELECT status FROM shop_orders WHERE id = ${String(order.id)}::uuid`);
    if (now[0]?.status !== "cancelled") throw err;
    return false;
  });
  if (!settled) {
    const refund = await gateway
      .cancel({ providerTid: params.providerTid, reason: "주문이 취소된 뒤 승인된 결제",
                idempotencyKey: `${params.providerTid}-orphan` })
      .catch(() => ({ ok: false as const }));
    await db.execute(sql`
      UPDATE shop_payments SET
        status = ${refund.ok ? "refunded" : "paid"},
        refunded_amount = ${refund.ok ? approved : 0},
        failure_reason = ${refund.ok ? "주문이 취소된 뒤 승인되어 전액 환불" : "주문이 취소된 뒤 승인됨 — 환불 실패, 수동 환불 필요"},
        updated_at = now()
      WHERE id = ${paymentId}
    `);
    throw new ShopError(409, refund.ok
      ? "결제하는 사이 주문이 취소되어 결제를 취소했습니다. 다시 주문해 주세요."
      : "결제하는 사이 주문이 취소되었습니다. 결제 취소가 처리되지 않아 판매자가 확인 후 환불합니다.");
  }

  // 결제 완료 통지 — 포인트 적립 등이 구독한다.
  // 실패해도 결제는 유효하므로 예외를 삼킨다 (적립은 나중에 보정할 수 있다).
  if (params.onPaid) {
    await params
      .onPaid({
        orderNo: params.orderNo,
        userId: order.user_id ? String(order.user_id) : null,
        amount: approved,
      })
      .catch(() => undefined);
  }

  return { ok: true, orderNo: params.orderNo, amount: approved };
}

/**
 * 환불.
 * 부분 환불을 지원하되 누적 환불액이 결제액을 넘지 못하게 한다 (DB CHECK + 코드 이중 방어).
 */
export async function refundPayment(
  db: Db,
  params: {
    orderNo: string;
    amount?: number;
    reason: string;
    actorId?: string | null;
    pointsPort?: PointsPort | null;
  },
): Promise<{
  ok: boolean;
  /**
   * 누적 환불액.
   *
   * `refundedNow` 와 구분해서 준다 — 하나만 주면 운영자가 "이번에 얼마가
   * 나갔는가"와 "지금까지 얼마가 나갔는가"를 구분할 수 없다.
   */
  refunded: number;
  /** 이번 요청으로 실제로 환불한 금액 */
  refundedNow: number;
  remaining: number;
}> {
  const { rows } = await db.execute(sql`
    SELECT p.id, p.provider, p.provider_tid, p.amount, p.refunded_amount, o.id AS order_id, o.status
    FROM shop_payments p JOIN shop_orders o ON o.id = p.order_id
    WHERE o.order_no = ${params.orderNo} AND p.status IN ('paid', 'partial_refunded')
    ORDER BY p.created_at DESC LIMIT 1
  `);
  const payment = rows[0];
  if (!payment) throw new ShopError(404, "환불할 결제 내역이 없습니다.");

  const gateway = gateways.get(String(payment.provider));
  if (!gateway) throw new ShopError(400, t("err.gatewayOff", { provider: String(payment.provider) }));

  const paid = Number(payment.amount);
  const already = Number(payment.refunded_amount);
  const remaining = paid - already;
  const amount = params.amount === undefined ? remaining : Math.floor(Number(params.amount));

  if (!Number.isFinite(amount) || amount <= 0) throw new ShopError(400, "환불 금액이 올바르지 않습니다.");
  if (amount > remaining) {
    throw new ShopError(400, t("refund.overLimit", { amount: money(remaining) }));
  }

  // 이 취소 동작을 가리키는 멱등키.
  //
  // `already`(지금까지 환불한 누적액)를 넣는 것이 핵심이다. 같은 금액을 두 번
  // 환불하는 경우(같은 가격 상품을 따로 반품)에도 누적액이 다르므로 키가
  // 달라진다. 반대로 **커밋되지 않은 재시도**는 누적액이 그대로이므로 같은 키가
  // 되어 PG 가 한 번만 처리한다 — 멱등성의 목적이 정확히 그것이다.
  const idempotencyKey = `cancel-${String(payment.id)}-${already}-${amount}`;

  const result = await gateway.cancel({
    providerTid: String(payment.provider_tid),
    ...(amount < remaining ? { amount } : {}),
    reason: params.reason,
    idempotencyKey,
    currentCancellable: remaining,
  });
  if (!result.ok) throw new ShopError(402, result.failureReason ?? "환불 처리에 실패했습니다.");

  const totalRefunded = already + amount;
  const fullyRefunded = totalRefunded >= paid;
  await db.execute(sql`
    UPDATE shop_payments SET refunded_amount = ${totalRefunded},
      status = ${fullyRefunded ? "refunded" : "partial_refunded"}, updated_at = now()
    WHERE id = ${String(payment.id)}
  `);

  // 전액 환불이면 주문도 환불 상태로 전이 → 재고가 복원된다
  if (fullyRefunded) {
    await changeOrderStatus(db, String(payment.order_id), "refunded", {
      note: `전액 환불: ${params.reason}`,
      actorId: params.actorId ?? null,
      pointsPort: params.pointsPort ?? null,
    });
  } else {
    await db.execute(sql`
      INSERT INTO shop_order_events (id, order_id, from_status, to_status, note, actor_id)
      VALUES (${uuidv7()}, ${String(payment.order_id)}::uuid, ${String(payment.status)}, ${String(payment.status)},
              ${`부분 환불 ${amount.toLocaleString("ko-KR")}원: ${params.reason}`}, ${params.actorId ?? null}::uuid)
    `);
  }

  return {
    ok: true,
    refunded: totalRefunded,
    refundedNow: amount,
    remaining: paid - totalRefunded,
  };
}

/**
 * 무통장입금 게이트웨이 — 기본 내장.
 * 실제 입금 확인은 관리자가 수동으로 하므로 confirm은 관리자 승인 시점에 호출된다.
 */
export const bankTransferGateway: PaymentGateway = {
  provider: "bank_transfer",
  displayName: "무통장입금",
  async confirm({ claimedAmount }) {
    // 관리자가 입금을 확인하고 승인하는 흐름이므로 요청 금액을 그대로 승인한다.
    // (주문 금액과의 대조는 confirmPayment가 수행한다)
    return { ok: true, approvedAmount: claimedAmount, method: "무통장입금" };
  },
  async cancel() {
    // 계좌 환불은 사람이 처리한다. 기록만 남기고 성공으로 본다.
    return { ok: true };
  },
};
