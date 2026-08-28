/**
 * 세금 증빙 — 현금영수증 · 세금계산서 · 부가세 신고 자료.
 *
 * 부가가치세법 제32조의2·제46조: 최종소비자가 요청하면 현금영수증을
 * **발급해야 하고**, 미발급은 미발급액의 20% 가산세다.
 *
 * ── 카드 결제에는 발급하지 않는다 ────────────────────
 *
 * 카드는 PG 가 국세청에 자동 통보한다. 현금영수증을 또 발급하면 **같은
 * 매출을 두 번 신고**하는 것이고, 손님도 이중 공제를 받게 된다. 그래서
 * 무통장·현금 결제에만 발급을 허용한다 — 옵션이 아니라 거부한다.
 *
 * ── 발급 수단 ────────────────────────────────────────
 *
 * 국세청 직접 연동은 사업자 인증서가 필요해서 대부분 PG 사 API 를 경유한다.
 * PG 마다 다르므로 게이트웨이로 추상화하고, 기본값은 **수동 발급**이다 —
 * 운영자가 홈택스에서 발급하고 승인번호를 Brick 에 적는다.
 *
 * 수동을 기본으로 두는 이유는 `LogMailProvider`·`bankTransferGateway` 와
 * 같다. PG 계약이 없는 사이트에서 "발급됨"이라고 표시되고 실제로는 아무
 * 일도 없는 것이 최악이다. 수동 모드는 **발급되지 않았음을 화면에 남긴다.**
 */
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { isUniqueViolation } from "@brick/plugin-sdk";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

export const RECEIPT_KINDS = ["income_deduction", "expense_proof"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_KIND_LABEL: Record<ReceiptKind, string> = {
  income_deduction: "소득공제용 (개인)",
  expense_proof: "지출증빙용 (사업자)",
};

/** 현금으로 받은 것만 발급 대상이다 */
const CASH_METHODS = ["bank_transfer", "cash", "vbank", "virtual_account"];

/**
 * 금액 분해.
 *
 * 총액을 공급가액 · 부가세 · 면세금액으로 나눈다.
 *
 * 반드시 **셋을 합치면 총액**이어야 한다. 반올림을 각각 하면 1원이 어긋나고,
 * 국세청 검증에서 반려된다. 그래서 공급가액을 먼저 정하고 **부가세를 차액으로
 * 구한다.**
 *
 * 면세 금액은 부가세를 매기지 않으므로 총액에서 먼저 떼어낸다.
 */
export function splitTax(params: { total: number; taxFreeAmount?: number }): {
  total: number;
  supplyAmount: number;
  vatAmount: number;
  taxFreeAmount: number;
} {
  const total = Math.max(0, Math.floor(params.total));
  const taxFree = Math.min(total, Math.max(0, Math.floor(params.taxFreeAmount ?? 0)));
  const taxable = total - taxFree;
  // 공급가액 = 과세분 / 1.1 (원 단위 절사), 부가세 = 차액
  const supply = Math.floor(taxable / 1.1);
  return {
    total,
    supplyAmount: supply,
    vatAmount: taxable - supply,
    taxFreeAmount: taxFree,
  };
}

/** 개인정보를 가려서 보여준다 (목록·로그) */
export function maskIdentifier(raw: string): string {
  const s = String(raw ?? "");
  const digits = s.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  // 뒤 4자리만 남긴다 — 손님이 자기 것인지 알아볼 수 있는 최소한
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * 식별번호 검증.
 *
 * 소득공제용은 휴대폰 번호(또는 현금영수증카드 13~19자리),
 * 지출증빙용은 사업자등록번호 10자리다. **용도와 번호 형태가 맞지 않으면
 * 국세청이 반려하고, 반려 사실을 운영자가 늦게 알면 미발급 가산세를 맞는다.**
 */
export function validateIdentifier(kind: ReceiptKind, raw: string, isValidBusinessNo: (v: string) => boolean): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) throw new ShopError(400, "식별번호를 입력해주세요.");

  if (kind === "expense_proof") {
    if (digits.length !== 10) {
      throw new ShopError(400, "지출증빙용은 사업자등록번호 10자리를 입력해주세요.");
    }
    if (!isValidBusinessNo(digits)) {
      throw new ShopError(400, "사업자등록번호가 올바르지 않습니다.");
    }
    return digits;
  }

  // 소득공제용: 휴대폰(10~11) 또는 현금영수증카드(13~19)
  const isPhone = digits.length === 10 || digits.length === 11;
  const isCard = digits.length >= 13 && digits.length <= 19;
  if (!isPhone && !isCard) {
    throw new ShopError(400, "휴대폰 번호 또는 현금영수증카드 번호를 입력해주세요.");
  }
  return digits;
}

// ════════════════════════════════════════════════════
//  발급 게이트웨이
// ════════════════════════════════════════════════════

export interface CashReceiptGateway {
  /** "manual", "toss", "inicis" 등 */
  readonly provider: string;
  readonly displayName: string;
  /**
   * 발급을 요청한다.
   *
   * `pending: true` 를 반환하면 **아직 발급되지 않았다는 뜻**이다
   * (수동 발급 모드). 그때 상태는 `requested` 로 남고, 화면은 운영자에게
   * 처리해야 함을 보여준다.
   */
  issue(params: {
    orderNo: string;
    kind: ReceiptKind;
    identifier: string;
    total: number;
    supplyAmount: number;
    vatAmount: number;
    taxFreeAmount: number;
  }): Promise<{
    ok: boolean;
    pending?: boolean;
    approvalNo?: string;
    receiptUrl?: string;
    failureReason?: string;
  }>;
  /** 취소. 부분 취소는 지원하지 않는다 — 전액 취소 후 재발급이 실무다 */
  cancel(params: { approvalNo: string; reason: string }): Promise<{
    ok: boolean;
    failureReason?: string;
  }>;
}

/**
 * 수동 발급 — 기본 게이트웨이.
 *
 * 아무것도 자동으로 하지 않고, 운영자가 홈택스에서 발급한 뒤 승인번호를
 * 적도록 `requested` 로 남긴다. **거짓으로 "발급됨"을 표시하지 않는 것**이
 * 이 게이트웨이의 목적이다.
 */
export const manualCashReceiptGateway: CashReceiptGateway = {
  provider: "manual",
  displayName: "수동 발급 (홈택스에서 직접)",
  async issue() {
    return { ok: true, pending: true };
  },
  async cancel() {
    // 취소도 운영자가 홈택스에서 한다. 기록만 남긴다.
    return { ok: true };
  },
};

const gateways = new Map<string, CashReceiptGateway>([
  [manualCashReceiptGateway.provider, manualCashReceiptGateway],
]);

export function registerCashReceiptGateway(gw: CashReceiptGateway): void {
  gateways.set(gw.provider, gw);
}

export function listCashReceiptGateways(): CashReceiptGateway[] {
  return [...gateways.values()];
}

function resolveGateway(name: string): CashReceiptGateway {
  const gw = gateways.get(name);
  if (!gw) throw new ShopError(400, `현금영수증 발급 수단을 찾을 수 없습니다: ${name}`);
  return gw;
}

// ════════════════════════════════════════════════════
//  현금영수증
// ════════════════════════════════════════════════════

/** 주문의 면세 금액 — 항목 스냅샷 기준 (상품 설정이 바뀌어도 흔들리지 않는다) */
async function taxFreeAmountOf(db: Db, orderId: string): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT coalesce(sum(
      -- 취소된 수량은 뺀다. 남은 것에 대해서만 증빙한다
      oi.unit_price * (oi.quantity - oi.cancelled_qty)
    ), 0) AS amount
    FROM shop_order_items oi
    WHERE oi.order_id = ${orderId}::uuid AND oi.tax_free = true
  `);
  return Number(rows[0]?.amount ?? 0);
}

/**
 * 증빙할 금액 — 실제로 받은 돈.
 *
 * 총 결제액에서 **완료된 반품의 환불액을 뺀다.** 반품한 만큼 증빙하면
 * 세금을 더 낸다. 판매 리포트와 같은 정의를 쓴다 (ADR-51).
 */
async function receivableAmount(db: Db, orderId: string): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT o.total - coalesce((
      SELECT sum(r.refund_amount) FROM shop_returns r
      WHERE r.order_id = o.id AND r.status = 'completed'
    ), 0) AS amount
    FROM shop_orders o WHERE o.id = ${orderId}::uuid
  `);
  return Math.max(0, Number(rows[0]?.amount ?? 0));
}

export async function requestCashReceipt(
  db: Db,
  params: {
    orderNo: string;
    kind: string;
    identifier: string;
    /** 회원 본인 또는 관리자 */
    userId: string | null;
    isManager: boolean;
    gateway?: string;
    isValidBusinessNo: (v: string) => boolean;
  },
): Promise<{
  id: string;
  status: string;
  kind: ReceiptKind;
  identifier: string;
  total: number;
  supplyAmount: number;
  vatAmount: number;
  taxFreeAmount: number;
  approvalNo: string | null;
  pending: boolean;
}> {
  const kind = String(params.kind) as ReceiptKind;
  if (!RECEIPT_KINDS.includes(kind)) {
    throw new ShopError(400, "발급 용도를 선택해주세요 (소득공제용 · 지출증빙용).");
  }
  const identifier = validateIdentifier(kind, params.identifier, params.isValidBusinessNo);

  const { rows } = await db.execute(sql`
    SELECT id, order_no, user_id, total, payment_method, payment_status, paid_at
    FROM shop_orders WHERE order_no = ${params.orderNo} LIMIT 1
  `);
  const order = rows[0];
  // 남의 주문이 존재하는지 알려주지 않는다 (주문번호는 순차적이다)
  if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");
  if (!params.isManager) {
    if (!params.userId || String(order.user_id ?? "") !== params.userId) {
      throw new ShopError(404, "주문을 찾을 수 없습니다.");
    }
  }

  if (!order.paid_at) {
    throw new ShopError(400, "결제가 확인된 뒤에 발급할 수 있습니다.");
  }

  // 카드는 PG 가 국세청에 자동 통보한다. 또 발급하면 이중 신고다.
  const method = String(order.payment_method ?? "");
  if (!CASH_METHODS.includes(method)) {
    throw new ShopError(
      400,
      "카드 결제는 카드사가 국세청에 자동 통보하므로 현금영수증을 발급하지 않습니다 (이중 신고가 됩니다).",
    );
  }

  const orderId = String(order.id);
  const total = await receivableAmount(db, orderId);
  if (total <= 0) throw new ShopError(400, "전액 환불된 주문입니다.");

  const taxFree = Math.min(total, await taxFreeAmountOf(db, orderId));
  const amounts = splitTax({ total, taxFreeAmount: taxFree });

  const gwName = String(params.gateway ?? "manual");
  const gw = resolveGateway(gwName);

  const id = uuidv7();
  // 먼저 행을 만든다 — 중복 발급을 DB 제약으로 막는다.
  // 게이트웨이를 먼저 부르면 두 창에서 동시에 눌렀을 때 국세청에 두 번 간다.
  try {
    await db.execute(sql`
      INSERT INTO shop_cash_receipts
        (id, order_id, kind, identifier, status, total_amount, supply_amount,
         vat_amount, tax_free_amount, gateway, requested_by)
      VALUES
        (${id}, ${orderId}::uuid, ${kind}, ${identifier}, 'requested',
         ${amounts.total}, ${amounts.supplyAmount}, ${amounts.vatAmount},
         ${amounts.taxFreeAmount}, ${gwName}, ${params.userId}::uuid)
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_cash_receipts_once_idx")) {
      throw new ShopError(409, "이미 현금영수증이 발급되었거나 발급 대기 중입니다.");
    }
    throw err;
  }

  // 게이트웨이 호출은 트랜잭션 밖이다 — 외부 호출을 트랜잭션에 넣으면
  // 응답이 늦을 때 커넥션과 잠금을 붙잡는다 (결제와 같은 이유).
  let result: Awaited<ReturnType<CashReceiptGateway["issue"]>>;
  try {
    result = await gw.issue({
      orderNo: String(order.order_no),
      kind,
      identifier,
      total: amounts.total,
      supplyAmount: amounts.supplyAmount,
      vatAmount: amounts.vatAmount,
      taxFreeAmount: amounts.taxFreeAmount,
    });
  } catch (err) {
    await db.execute(sql`
      UPDATE shop_cash_receipts SET status = 'failed', error = ${String(err).slice(0, 500)}
      WHERE id = ${id}::uuid
    `);
    throw new ShopError(502, "현금영수증 발급에 실패했습니다. 잠시 후 다시 시도해주세요.");
  }

  if (!result.ok) {
    await db.execute(sql`
      UPDATE shop_cash_receipts SET status = 'failed', error = ${result.failureReason ?? "발급 실패"}
      WHERE id = ${id}::uuid
    `);
    throw new ShopError(502, result.failureReason ?? "현금영수증 발급에 실패했습니다.");
  }

  // pending 이면 requested 로 남긴다 — 발급되지 않았음을 감추지 않는다
  if (!result.pending) {
    await db.execute(sql`
      UPDATE shop_cash_receipts SET status = 'issued', issued_at = now(),
        approval_no = ${result.approvalNo ?? null}, receipt_url = ${result.receiptUrl ?? null}
      WHERE id = ${id}::uuid
    `);
  }

  return {
    id,
    status: result.pending ? "requested" : "issued",
    kind,
    identifier: maskIdentifier(identifier),
    total: amounts.total,
    supplyAmount: amounts.supplyAmount,
    vatAmount: amounts.vatAmount,
    taxFreeAmount: amounts.taxFreeAmount,
    approvalNo: result.approvalNo ?? null,
    pending: result.pending === true,
  };
}

/**
 * 수동 발급 완료 처리 — 운영자가 홈택스에서 발급한 뒤 승인번호를 적는다.
 *
 * 승인번호를 필수로 받는다. 없으면 "발급했다"는 기록만 남고 나중에
 * 국세청 자료와 대조할 수 없다.
 */
export async function markCashReceiptIssued(
  db: Db,
  params: { id: string; approvalNo: string; receiptUrl?: string },
): Promise<{ ok: true }> {
  const approvalNo = String(params.approvalNo ?? "").trim();
  if (!approvalNo) throw new ShopError(400, "국세청 승인번호를 입력해주세요.");

  const { rows } = await db.execute(sql`
    UPDATE shop_cash_receipts SET status = 'issued', issued_at = now(),
      approval_no = ${approvalNo}, receipt_url = ${params.receiptUrl ?? null}, error = NULL
    WHERE id = ${params.id}::uuid AND status IN ('requested', 'failed')
    RETURNING id
  `);
  if (!rows.length) {
    throw new ShopError(400, "발급 대기 중인 현금영수증이 아닙니다.");
  }
  return { ok: true };
}

/**
 * 취소.
 *
 * **환불했는데 현금영수증이 살아 있으면 세금을 더 낸다.** 반품 완료에
 * 연결되어 자동으로 불린다.
 *
 * 부분 취소는 지원하지 않는다 — 국세청 API 가 부분 취소를 지원하지 않는
 * 경우가 많아, 전액 취소 후 잔액으로 재발급하는 것이 실무다. 부분 반품이면
 * 취소만 하고, 재발급은 손님이 다시 신청하거나 운영자가 발급한다.
 */
export async function cancelCashReceipt(
  db: Db,
  params: { id: string; reason: string },
): Promise<{ ok: true; wasIssued: boolean }> {
  const { rows } = await db.execute(sql`
    SELECT id, status, gateway, approval_no FROM shop_cash_receipts
    WHERE id = ${params.id}::uuid LIMIT 1
  `);
  const receipt = rows[0];
  if (!receipt) throw new ShopError(404, "현금영수증을 찾을 수 없습니다.");
  if (String(receipt.status) === "cancelled") {
    throw new ShopError(400, "이미 취소되었습니다.");
  }

  const wasIssued = String(receipt.status) === "issued";
  const approvalNo = receipt.approval_no ? String(receipt.approval_no) : "";

  // 발급된 것만 게이트웨이에 취소를 알린다.
  // 아직 requested 면 국세청에 간 것이 없으므로 기록만 지운다.
  if (wasIssued && approvalNo) {
    const gw = resolveGateway(String(receipt.gateway));
    const result = await gw.cancel({ approvalNo, reason: params.reason }).catch((err) => ({
      ok: false,
      failureReason: String(err),
    }));
    if (!result.ok) {
      // 취소 실패를 조용히 넘기면 세금을 더 낸다. 운영자가 알아야 한다.
      await db.execute(sql`
        UPDATE shop_cash_receipts SET error = ${`취소 실패: ${result.failureReason ?? ""}`.slice(0, 500)}
        WHERE id = ${params.id}::uuid
      `);
      throw new ShopError(502, "현금영수증 취소에 실패했습니다. 홈택스에서 직접 취소해주세요.");
    }
  }

  await db.execute(sql`
    UPDATE shop_cash_receipts SET status = 'cancelled', cancelled_at = now(),
      cancel_reason = ${String(params.reason ?? "").slice(0, 500)}
    WHERE id = ${params.id}::uuid
  `);
  return { ok: true, wasIssued };
}

/**
 * 반품·환불이 완료되면 살아 있는 현금영수증을 취소한다.
 *
 * 실패해도 반품 처리를 막지 않는다 — 물건은 이미 돌려받았고 환불도 나갔다.
 * 대신 `error` 에 남겨 운영자가 홈택스에서 직접 취소하도록 한다.
 * (반품이 안 끝나는 것보다, 증빙 취소가 밀리는 것이 낫다)
 */
export async function cancelReceiptsForOrder(
  db: Db,
  params: { orderId: string; reason: string },
): Promise<{ cancelled: number }> {
  const { rows } = await db.execute(sql`
    SELECT id FROM shop_cash_receipts
    WHERE order_id = ${params.orderId}::uuid AND status IN ('requested', 'issued')
  `);
  let cancelled = 0;
  for (const r of rows) {
    try {
      await cancelCashReceipt(db, { id: String(r.id), reason: params.reason });
      cancelled += 1;
    } catch {
      // 위 함수가 error 를 기록한다. 반품을 막지 않는다.
    }
  }
  return { cancelled };
}

export async function listCashReceipts(
  db: Db,
  params: { orderId?: string; status?: string; page?: number },
) {
  const page = Math.max(1, Math.floor(Number(params.page ?? 1)));
  const conds = [sql`true`];
  if (params.orderId) conds.push(sql`cr.order_id = ${params.orderId}::uuid`);
  if (params.status) conds.push(sql`cr.status = ${params.status}`);
  const where = sql.join(conds, sql` AND `);

  const { rows } = await db.execute(sql`
    SELECT cr.id, cr.kind, cr.identifier, cr.status, cr.total_amount, cr.supply_amount,
           cr.vat_amount, cr.tax_free_amount, cr.gateway, cr.approval_no, cr.receipt_url,
           cr.error, cr.requested_at, cr.issued_at, cr.cancelled_at, cr.cancel_reason,
           o.order_no, o.orderer_name
    FROM shop_cash_receipts cr
    JOIN shop_orders o ON o.id = cr.order_id
    WHERE ${where}
    ORDER BY cr.requested_at DESC
    LIMIT 30 OFFSET ${(page - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_cash_receipts cr WHERE ${where}
  `);

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      orderNo: String(r.order_no),
      ordererName: String(r.orderer_name),
      kind: String(r.kind),
      kindLabel: RECEIPT_KIND_LABEL[String(r.kind) as ReceiptKind] ?? String(r.kind),
      // 개인정보는 가려서 내보낸다
      identifier: maskIdentifier(String(r.identifier)),
      status: String(r.status),
      totalAmount: Number(r.total_amount),
      supplyAmount: Number(r.supply_amount),
      vatAmount: Number(r.vat_amount),
      taxFreeAmount: Number(r.tax_free_amount),
      gateway: String(r.gateway),
      approvalNo: r.approval_no ? String(r.approval_no) : null,
      receiptUrl: r.receipt_url ? String(r.receipt_url) : null,
      error: r.error ? String(r.error) : null,
      requestedAt: r.requested_at,
      issuedAt: r.issued_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason ? String(r.cancel_reason) : null,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page,
    pageSize: 30,
  };
}

// ════════════════════════════════════════════════════
//  세금계산서
// ════════════════════════════════════════════════════

export async function requestTaxInvoice(
  db: Db,
  params: {
    orderNo: string;
    userId: string | null;
    isManager: boolean;
    body: Record<string, unknown>;
    isValidBusinessNo: (v: string) => boolean;
  },
): Promise<{ id: string; status: string; total: number; supplyAmount: number; vatAmount: number }> {
  const b = params.body;
  const businessNo = String(b.businessNo ?? "").replace(/\D/g, "");
  if (!params.isValidBusinessNo(businessNo)) {
    throw new ShopError(400, "사업자등록번호가 올바르지 않습니다.");
  }
  const companyName = String(b.companyName ?? "").trim();
  const ceoName = String(b.ceoName ?? "").trim();
  const contactEmail = String(b.contactEmail ?? "").trim();
  if (!companyName) throw new ShopError(400, "상호를 입력해주세요.");
  if (!ceoName) throw new ShopError(400, "대표자명을 입력해주세요.");
  // 이메일이 없으면 발급한 계산서를 보낼 곳이 없다
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    throw new ShopError(400, "계산서를 받을 이메일을 입력해주세요.");
  }

  const { rows } = await db.execute(sql`
    SELECT id, user_id, paid_at FROM shop_orders WHERE order_no = ${params.orderNo} LIMIT 1
  `);
  const order = rows[0];
  if (!order) throw new ShopError(404, "주문을 찾을 수 없습니다.");
  if (!params.isManager) {
    if (!params.userId || String(order.user_id ?? "") !== params.userId) {
      throw new ShopError(404, "주문을 찾을 수 없습니다.");
    }
  }
  if (!order.paid_at) throw new ShopError(400, "결제가 확인된 뒤에 요청할 수 있습니다.");

  const orderId = String(order.id);
  const total = await receivableAmount(db, orderId);
  if (total <= 0) throw new ShopError(400, "전액 환불된 주문입니다.");
  const taxFree = Math.min(total, await taxFreeAmountOf(db, orderId));
  const amounts = splitTax({ total, taxFreeAmount: taxFree });

  const id = uuidv7();
  try {
    await db.execute(sql`
      INSERT INTO shop_tax_invoices
        (id, order_id, business_no, company_name, ceo_name, address, business_type,
         business_item, contact_name, contact_email, contact_phone, status,
         total_amount, supply_amount, vat_amount, tax_free_amount, requested_by)
      VALUES
        (${id}, ${orderId}::uuid, ${businessNo}, ${companyName}, ${ceoName},
         ${String(b.address ?? "").trim() || null}, ${String(b.businessType ?? "").trim() || null},
         ${String(b.businessItem ?? "").trim() || null}, ${String(b.contactName ?? "").trim() || null},
         ${contactEmail}, ${String(b.contactPhone ?? "").trim() || null}, 'requested',
         ${amounts.total}, ${amounts.supplyAmount}, ${amounts.vatAmount},
         ${amounts.taxFreeAmount}, ${params.userId}::uuid)
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_tax_invoices_once_idx")) {
      throw new ShopError(409, "이미 세금계산서를 요청했거나 발급되었습니다.");
    }
    throw err;
  }

  return {
    id,
    status: "requested",
    total: amounts.total,
    supplyAmount: amounts.supplyAmount,
    vatAmount: amounts.vatAmount,
  };
}

export async function updateTaxInvoice(
  db: Db,
  params: { id: string; status: string; invoiceNo?: string; invoiceUrl?: string; reason?: string },
): Promise<{ ok: true }> {
  const status = String(params.status);
  if (status === "issued") {
    const invoiceNo = String(params.invoiceNo ?? "").trim();
    // 승인번호 없이 발급 처리하면 나중에 국세청 자료와 대조할 수 없다
    if (!invoiceNo) throw new ShopError(400, "국세청 승인번호를 입력해주세요.");
    const { rows } = await db.execute(sql`
      UPDATE shop_tax_invoices SET status = 'issued', issued_at = now(),
        invoice_no = ${invoiceNo}, invoice_url = ${params.invoiceUrl ?? null}
      WHERE id = ${params.id}::uuid AND status = 'requested'
      RETURNING id
    `);
    if (!rows.length) throw new ShopError(400, "요청 상태인 세금계산서가 아닙니다.");
    return { ok: true };
  }

  if (status === "rejected") {
    const reason = String(params.reason ?? "").trim();
    // 사유 없이 거부하면 손님은 왜 못 받는지 알 수 없다
    if (!reason) throw new ShopError(400, "거부 사유를 입력해주세요.");
    const { rows } = await db.execute(sql`
      UPDATE shop_tax_invoices SET status = 'rejected', rejected_at = now(), reject_reason = ${reason}
      WHERE id = ${params.id}::uuid AND status = 'requested'
      RETURNING id
    `);
    if (!rows.length) throw new ShopError(400, "요청 상태인 세금계산서가 아닙니다.");
    return { ok: true };
  }

  throw new ShopError(400, "상태는 issued 또는 rejected 여야 합니다.");
}

export async function listTaxInvoices(db: Db, params: { status?: string; page?: number }) {
  const page = Math.max(1, Math.floor(Number(params.page ?? 1)));
  const conds = [sql`true`];
  if (params.status) conds.push(sql`ti.status = ${params.status}`);
  const where = sql.join(conds, sql` AND `);

  const { rows } = await db.execute(sql`
    SELECT ti.id, ti.business_no, ti.company_name, ti.ceo_name, ti.address,
           ti.business_type, ti.business_item, ti.contact_name, ti.contact_email,
           ti.contact_phone, ti.status, ti.total_amount, ti.supply_amount, ti.vat_amount,
           ti.tax_free_amount, ti.invoice_no, ti.invoice_url, ti.requested_at,
           ti.issued_at, ti.rejected_at, ti.reject_reason, o.order_no
    FROM shop_tax_invoices ti
    JOIN shop_orders o ON o.id = ti.order_id
    WHERE ${where}
    ORDER BY ti.requested_at DESC
    LIMIT 30 OFFSET ${(page - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_tax_invoices ti WHERE ${where}
  `);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      orderNo: String(r.order_no),
      businessNo: String(r.business_no),
      companyName: String(r.company_name),
      ceoName: String(r.ceo_name),
      address: r.address ? String(r.address) : null,
      businessType: r.business_type ? String(r.business_type) : null,
      businessItem: r.business_item ? String(r.business_item) : null,
      contactName: r.contact_name ? String(r.contact_name) : null,
      contactEmail: String(r.contact_email),
      contactPhone: r.contact_phone ? String(r.contact_phone) : null,
      status: String(r.status),
      totalAmount: Number(r.total_amount),
      supplyAmount: Number(r.supply_amount),
      vatAmount: Number(r.vat_amount),
      taxFreeAmount: Number(r.tax_free_amount),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      invoiceUrl: r.invoice_url ? String(r.invoice_url) : null,
      requestedAt: r.requested_at,
      issuedAt: r.issued_at,
      rejectedAt: r.rejected_at,
      rejectReason: r.reject_reason ? String(r.reject_reason) : null,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page,
    pageSize: 30,
  };
}

// ════════════════════════════════════════════════════
//  부가세 신고 자료
// ════════════════════════════════════════════════════

/**
 * 과세기간.
 *
 * 부가가치세법: 1기는 1~6월, 2기는 7~12월. 각각 예정(1~3월, 7~9월)과
 * 확정(4~6월, 10~12월) 신고가 있다. 법인은 예정 신고를 하고 개인
 * 일반과세자는 예정 고지를 받는다.
 *
 * 운영자가 날짜를 직접 계산하지 않게 기간 코드로 고른다 — "1기 확정이
 * 언제부터인지"를 매번 찾아보게 하면 틀린 기간으로 신고한다.
 */
export const VAT_PERIODS = [
  { code: "1-preliminary", label: "제1기 예정 (1~3월)", startMonth: 1, endMonth: 3 },
  { code: "1-final", label: "제1기 확정 (4~6월)", startMonth: 4, endMonth: 6 },
  { code: "1-full", label: "제1기 전체 (1~6월)", startMonth: 1, endMonth: 6 },
  { code: "2-preliminary", label: "제2기 예정 (7~9월)", startMonth: 7, endMonth: 9 },
  { code: "2-final", label: "제2기 확정 (10~12월)", startMonth: 10, endMonth: 12 },
  { code: "2-full", label: "제2기 전체 (7~12월)", startMonth: 7, endMonth: 12 },
] as const;

export function vatPeriodRange(year: number, code: string): { from: string; to: string; label: string } {
  const found = VAT_PERIODS.find((p) => p.code === code);
  if (!found) throw new ShopError(400, "과세기간이 올바르지 않습니다.");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ShopError(400, "연도가 올바르지 않습니다.");
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  // 말일은 다음 달 0일로 구한다 (윤년·30/31일을 직접 다루지 않는다)
  const lastDay = new Date(Date.UTC(year, found.endMonth, 0)).getUTCDate();
  return {
    from: `${year}-${pad(found.startMonth)}-01`,
    to: `${year}-${pad(found.endMonth)}-${pad(lastDay)}`,
    label: `${year}년 ${found.label}`,
  };
}

/**
 * 부가세 신고용 매출 집계.
 *
 * 판매 리포트(ADR-51)와 **같은 정의**를 쓴다 — 결제일 기준, 완료된 반품
 * 차감. 신고 숫자와 화면 숫자가 다르면 운영자는 둘 다 믿지 않는다.
 *
 * 증빙 종류로 나눈다. 신고서가 그렇게 요구한다:
 *   - 신용카드·현금영수증 발행분
 *   - 세금계산서 발급분
 *   - 기타 (증빙 없는 현금 매출)
 */
export async function vatReport(
  db: Db,
  params: { year: number; period: string; timezone: string },
) {
  const range = vatPeriodRange(params.year, params.period);
  const tz = params.timezone;

  const { rows } = await db.execute(sql`
    WITH refunds AS (
      SELECT order_id, sum(refund_amount) AS refunded
      FROM shop_returns WHERE status = 'completed' GROUP BY order_id
    ),
    paid AS (
      SELECT o.id, o.payment_method,
             o.total - coalesce(r.refunded, 0) AS net,
             -- 면세 금액은 항목 스냅샷에서 (상품 설정이 바뀌어도 흔들리지 않는다).
             -- 취소된 수량은 뺀다.
             coalesce((
               SELECT sum(oi.unit_price * (oi.quantity - oi.cancelled_qty))
               FROM shop_order_items oi
               WHERE oi.order_id = o.id AND oi.tax_free = true
             ), 0) AS tax_free,
             EXISTS (SELECT 1 FROM shop_cash_receipts cr
                     WHERE cr.order_id = o.id AND cr.status = 'issued') AS has_receipt,
             EXISTS (SELECT 1 FROM shop_tax_invoices ti
                     WHERE ti.order_id = o.id AND ti.status = 'issued') AS has_invoice
      FROM shop_orders o
      LEFT JOIN refunds r ON r.order_id = o.id
      WHERE o.paid_at IS NOT NULL
        AND o.paid_at >= (${range.from}::date::timestamp AT TIME ZONE ${tz})
        AND o.paid_at <  ((${range.to}::date + 1)::timestamp AT TIME ZONE ${tz})
    )
    SELECT
      /* 증빙 구분 — 신고서 항목 순서대로 */
      CASE
        WHEN payment_method NOT IN ('bank_transfer','cash','vbank','virtual_account') THEN 'card'
        WHEN has_invoice THEN 'tax_invoice'
        WHEN has_receipt THEN 'cash_receipt'
        ELSE 'other'
      END AS proof,
      count(*)                                        AS orders,
      coalesce(sum(net), 0)                           AS total,
      coalesce(sum(least(tax_free, net)), 0)          AS tax_free,
      coalesce(sum(net - least(tax_free, net)), 0)    AS taxable
    FROM paid
    WHERE net > 0
    GROUP BY 1
  `);

  const PROOF_LABEL: Record<string, string> = {
    card: "신용카드 (카드사가 국세청에 통보)",
    cash_receipt: "현금영수증 발행분",
    tax_invoice: "세금계산서 발급분",
    other: "기타 (증빙 없는 현금 매출)",
  };

  const groups = rows.map((r) => {
    const taxable = Number(r.taxable);
    // 과세분에서 공급가액과 부가세를 분해한다. 리포트와 같은 규칙(내림).
    const supply = Math.floor(taxable / 1.1);
    return {
      proof: String(r.proof),
      label: PROOF_LABEL[String(r.proof)] ?? String(r.proof),
      orders: Number(r.orders),
      total: Number(r.total),
      taxable,
      supplyAmount: supply,
      vatAmount: taxable - supply,
      taxFreeAmount: Number(r.tax_free),
    };
  });

  const sum = (pick: (g: (typeof groups)[number]) => number) =>
    groups.reduce((acc, g) => acc + pick(g), 0);

  return {
    year: params.year,
    period: params.period,
    periodLabel: range.label,
    from: range.from,
    to: range.to,
    timezone: tz,
    basis: "결제일 기준. 완료된 반품의 환불액을 차감한 금액입니다 (판매 리포트와 같은 정의).",
    caution:
      "신고 전 세무 담당자와 확인하세요. 이 집계는 쇼핑몰 주문만 포함하며, " +
      "다른 경로의 매출·매입은 들어 있지 않습니다.",
    groups,
    total: {
      orders: sum((g) => g.orders),
      total: sum((g) => g.total),
      supplyAmount: sum((g) => g.supplyAmount),
      vatAmount: sum((g) => g.vatAmount),
      taxFreeAmount: sum((g) => g.taxFreeAmount),
    },
    /** 증빙이 없는 현금 매출 — 발급 누락일 수 있으므로 눈에 띄게 준다 */
    missingProof: groups.find((g) => g.proof === "other") ?? null,
  };
}
