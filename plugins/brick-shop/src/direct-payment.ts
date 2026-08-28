/**
 * 개인결제 (주문서 없는 청구).
 *
 * 전화·상담·SNS 로 주문을 받고 금액만 청구하는 방식. 그누보드 쇼핑몰이
 * 실제로 많이 쓴다 — 맞춤 제작, 견적 후 결제, 추가 배송비 청구, 오프라인
 * 주문의 온라인 수납.
 *
 * ── 결제되면 주문을 만든다 ───────────────────────────
 *
 * 결제만 따로 만들면 **매출 집계가 샌다.** 판매 리포트(ADR-51)와 부가세
 * 신고 자료(ADR-54)는 `shop_orders` 를 기준으로 세므로, 주문 없는 결제는
 * 세금 신고에서 빠진다.
 *
 * 그래서 청구 제목을 상품명으로 하는 항목 하나를 가진 주문을 만든다.
 * `product_id` 는 NULL 이므로 재고를 건드리지 않는다.
 *
 * ── 링크만으로 결제된다 ──────────────────────────────
 *
 * 비회원도 결제해야 한다(전화 주문 손님이 회원일 이유가 없다). 그래서
 * 토큰은 **추측 불가능해야** 한다 — 청구번호는 순차적이라 쓸 수 없다.
 */
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";
// 주문번호는 기존 함수를 쓴다 — 형식과 시퀀스가 갈라지면 안 된다
import { nextOrderNo } from "./orders.js";

/** 기본 만료 — 7일. 금액을 고쳐 다시 청구하는 일이 흔하다 */
const DEFAULT_EXPIRE_DAYS = 7;

export interface PaymentRequestInput {
  title: string;
  description?: string;
  amount: number;
  expireDays?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  memo?: string;
}

async function nextRequestNo(db: Db): Promise<string> {
  const { rows } = await db.execute(sql`SELECT nextval('shop_payment_request_seq') AS n`);
  const n = Number(rows[0]?.n ?? 1);
  // 주문번호와 형식을 다르게 한다 — 손님이 주문 조회에 넣으면 "없다"고 나온다
  return `PR-${String(n).padStart(6, "0")}`;
}

export async function createPaymentRequest(
  db: Db,
  params: PaymentRequestInput & { createdBy: string },
): Promise<{ id: string; requestNo: string; token: string; amount: number; expiresAt: Date | null }> {
  const title = String(params.title ?? "").trim();
  if (!title) throw new ShopError(400, "청구 제목을 입력해주세요.");
  if (title.length > 200) throw new ShopError(400, "청구 제목이 너무 깁니다 (200자 이내).");

  const amount = Math.floor(Number(params.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ShopError(400, "청구 금액은 1원 이상이어야 합니다.");
  }
  // 상한을 둔다 — 0을 하나 더 붙이는 실수가 실제로 일어나고,
  // PG 한도를 넘으면 손님 화면에서 실패한다
  if (amount > 100_000_000) throw new ShopError(400, "청구 금액이 너무 큽니다 (1억원 이내).");

  const expireDays = params.expireDays === undefined ? DEFAULT_EXPIRE_DAYS : Math.floor(Number(params.expireDays));
  if (!Number.isFinite(expireDays) || expireDays < 1 || expireDays > 365) {
    throw new ShopError(400, "유효 기간은 1~365일이어야 합니다.");
  }

  const email = String(params.customerEmail ?? "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ShopError(400, "이메일 형식이 올바르지 않습니다.");
  }

  const id = uuidv7();
  const requestNo = await nextRequestNo(db);
  // 링크만으로 결제되므로 추측 불가능해야 한다
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + expireDays * 86400_000);

  await db.execute(sql`
    INSERT INTO shop_payment_requests
      (id, request_no, title, description, amount, token, status, expires_at,
       customer_name, customer_phone, customer_email, created_by, memo)
    VALUES
      (${id}, ${requestNo}, ${title}, ${String(params.description ?? "").trim() || null},
       ${amount}, ${token}, 'pending', ${expiresAt},
       ${String(params.customerName ?? "").trim() || null},
       ${String(params.customerPhone ?? "").trim() || null},
       ${email || null}, ${params.createdBy}::uuid,
       ${String(params.memo ?? "").trim() || null})
  `);

  return { id, requestNo, token, amount, expiresAt };
}

/**
 * 손님이 보는 청구서 — 토큰으로만 조회한다.
 *
 * 만료·취소·이미 결제된 것도 **이유를 붙여 보여준다.** 그냥 404 를 주면
 * 손님은 링크가 잘못된 줄 알고 사업자에게 문의한다.
 */
export async function viewPaymentRequest(
  db: Db,
  token: string,
): Promise<{
  requestNo: string;
  title: string;
  description: string | null;
  amount: number;
  status: string;
  payable: boolean;
  reason: string | null;
  customerName: string | null;
  expiresAt: Date | null;
  orderNo: string | null;
}> {
  const { rows } = await db.execute(sql`
    SELECT pr.request_no, pr.title, pr.description, pr.amount, pr.status, pr.expires_at,
           pr.customer_name, o.order_no
    FROM shop_payment_requests pr
    LEFT JOIN shop_orders o ON o.id = pr.order_id
    WHERE pr.token = ${String(token ?? "")} LIMIT 1
  `);
  const r = rows[0];
  if (!r) throw new ShopError(404, "청구서를 찾을 수 없습니다. 링크를 다시 확인해주세요.");

  const status = String(r.status);
  const expired =
    status === "pending" && r.expires_at !== null && new Date(r.expires_at as Date) < new Date();

  const reason =
    status === "paid" ? "이미 결제가 완료되었습니다."
    : status === "cancelled" ? "판매자가 취소한 청구서입니다."
    : expired ? "유효 기간이 지났습니다. 판매자에게 다시 요청해주세요."
    : null;

  return {
    requestNo: String(r.request_no),
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    amount: Number(r.amount),
    status: expired ? "expired" : status,
    payable: status === "pending" && !expired,
    reason,
    customerName: r.customer_name ? String(r.customer_name) : null,
    expiresAt: (r.expires_at as Date | null) ?? null,
    orderNo: r.order_no ? String(r.order_no) : null,
  };
}

/**
 * 청구서를 결제 가능한 주문으로 바꾼다.
 *
 * 결제 승인 **전에** 주문을 만든다 — 기존 결제 흐름(`/payments/confirm`)이
 * 주문번호를 기준으로 동작하고, 금액 검증도 주문 금액과 대조하기 때문이다.
 * 개인결제라고 다른 경로를 만들면 금액 위조 방어를 두 번 구현해야 한다.
 *
 * 이미 주문이 만들어져 있으면 그것을 돌려준다 — 손님이 결제 화면을 새로
 * 고쳐도 주문이 여러 개 생기지 않는다.
 */
export async function prepareOrderForRequest(
  db: Db,
  params: {
    token: string;
    userId: string | null;
    ordererName?: string;
    ordererPhone?: string;
    ordererEmail?: string;
  },
): Promise<{ orderNo: string; amount: number; title: string }> {
  const { rows } = await db.execute(sql`
    SELECT id, request_no, title, amount, status, expires_at, order_id,
           customer_name, customer_phone, customer_email
    FROM shop_payment_requests WHERE token = ${String(params.token ?? "")} LIMIT 1
  `);
  const r = rows[0];
  if (!r) throw new ShopError(404, "청구서를 찾을 수 없습니다.");

  const status = String(r.status);
  if (status === "paid") throw new ShopError(409, "이미 결제가 완료되었습니다.");
  if (status === "cancelled") throw new ShopError(400, "판매자가 취소한 청구서입니다.");
  if (r.expires_at !== null && new Date(r.expires_at as Date) < new Date()) {
    throw new ShopError(400, "유효 기간이 지났습니다. 판매자에게 다시 요청해주세요.");
  }

  // 이미 만든 주문이 있으면 재사용한다 (새로고침으로 주문이 늘어나지 않게)
  if (r.order_id) {
    const { rows: existing } = await db.execute(sql`
      SELECT order_no, total, payment_status FROM shop_orders WHERE id = ${String(r.order_id)}::uuid LIMIT 1
    `);
    if (existing[0]) {
      if (String(existing[0].payment_status) === "paid") {
        throw new ShopError(409, "이미 결제가 완료되었습니다.");
      }
      return {
        orderNo: String(existing[0].order_no),
        amount: Number(existing[0].total),
        title: String(r.title),
      };
    }
  }

  const amount = Number(r.amount);
  const name = String(params.ordererName ?? r.customer_name ?? "").trim();
  const phone = String(params.ordererPhone ?? r.customer_phone ?? "").trim();
  // 이름과 연락처는 있어야 한다 — 문제가 생겼을 때 연락할 방법이 없으면
  // 사업자도 손님도 곤란해진다 (전자상거래법상 거래 기록에도 필요하다)
  if (!name) throw new ShopError(400, "결제자 이름을 입력해주세요.");
  if (!phone) throw new ShopError(400, "연락처를 입력해주세요.");

  const orderId = uuidv7();
  const orderNo = await nextOrderNo(db);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO shop_orders (
        id, order_no, user_id, status,
        subtotal, discount, shipping_fee, total,
        payment_method, payment_status,
        orderer_name, orderer_phone, orderer_email,
        receiver_name, receiver_phone, postcode, address1,
        is_direct_payment
      ) VALUES (
        ${orderId}, ${orderNo}, ${params.userId}::uuid, 'pending',
        ${amount}, 0, 0, ${amount},
        'card', 'unpaid',
        ${name}, ${phone}, ${String(params.ordererEmail ?? r.customer_email ?? "").trim() || null},
        ${name}, ${phone},
        -- 배송이 없는 주문이다. 주소 컬럼이 NOT NULL 이므로 빈 값을 넣는다.
        -- "-" 로 두는 이유: 빈 문자열은 화면에서 누락처럼 보이고, 운영자가
        -- 주소를 못 받은 것인지 배송이 없는 것인지 구분할 수 없다.
        '-', '개인결제 (배송 없음)',
        true
      )
    `);

    // 항목 하나를 만든다 — 상품별 리포트와 증빙 금액 분해가 그대로 동작한다.
    // product_id 가 NULL 이므로 재고는 건드리지 않는다.
    await tx.execute(sql`
      INSERT INTO shop_order_items
        (id, order_id, product_id, option_id, product_name, option_name,
         unit_price, quantity, line_total, tax_free)
      VALUES
        (${uuidv7()}, ${orderId}::uuid, NULL, NULL,
         ${String(r.title).slice(0, 300)}, NULL,
         ${amount}, 1, ${amount},
         -- 개인결제는 과세로 본다. 면세 품목을 청구할 일이 있으면 정상 주문으로
         -- 받아야 한다 — 청구 제목만으로는 면세 여부를 판단할 수 없다.
         false)
    `);

    await tx.execute(sql`
      UPDATE shop_payment_requests SET order_id = ${orderId}::uuid
      WHERE id = ${String(r.id)}::uuid
    `);
  });

  return { orderNo, amount, title: String(r.title) };
}

/**
 * 결제 완료를 청구서에 반영한다.
 *
 * `shop.order.paid` 훅에서 부른다 — 결제 승인 경로를 하나로 유지하기 위해
 * 개인결제도 같은 `/payments/confirm` 을 쓰고, 그 결과를 여기서 받는다.
 */
export async function markRequestPaid(db: Db, orderNo: string): Promise<{ updated: boolean }> {
  const { rows } = await db.execute(sql`
    UPDATE shop_payment_requests SET status = 'paid', paid_at = now()
    WHERE order_id = (SELECT id FROM shop_orders WHERE order_no = ${orderNo})
      AND status = 'pending'
    RETURNING id
  `);
  return { updated: rows.length > 0 };
}

/**
 * 청구 취소.
 *
 * 이미 결제된 것은 취소할 수 없다 — 환불은 결제 관리에서 해야 한다.
 * 여기서 "취소"로 바꿔주면 운영자가 환불했다고 착각한다.
 */
export async function cancelPaymentRequest(
  db: Db,
  params: { id: string; reason?: string },
): Promise<{ ok: true }> {
  const { rows } = await db.execute(sql`
    SELECT status FROM shop_payment_requests WHERE id = ${params.id}::uuid LIMIT 1
  `);
  if (!rows[0]) throw new ShopError(404, "청구서를 찾을 수 없습니다.");
  if (String(rows[0].status) === "paid") {
    throw new ShopError(400, "이미 결제된 청구서입니다. 환불은 결제 관리에서 처리해주세요.");
  }

  await db.execute(sql`
    UPDATE shop_payment_requests SET status = 'cancelled', cancelled_at = now(),
      memo = coalesce(memo || E'\\n', '') || ${`취소: ${String(params.reason ?? "").slice(0, 200)}`}
    WHERE id = ${params.id}::uuid
  `);
  return { ok: true };
}

export async function listPaymentRequests(
  db: Db,
  params: { status?: string; page?: number },
) {
  const page = Math.max(1, Math.floor(Number(params.page ?? 1)));
  const conds = [sql`true`];
  if (params.status) conds.push(sql`pr.status = ${params.status}`);
  const where = sql.join(conds, sql` AND `);

  const { rows } = await db.execute(sql`
    SELECT pr.id, pr.request_no, pr.title, pr.description, pr.amount, pr.status,
           pr.expires_at, pr.customer_name, pr.customer_phone, pr.customer_email,
           pr.created_at, pr.paid_at, pr.cancelled_at, pr.memo, pr.token,
           o.order_no,
           -- 만료 여부는 계산해서 준다 (배치로 상태를 바꾸지 않는다 —
           -- 배치가 안 돌면 만료된 링크가 살아 있게 된다)
           (pr.status = 'pending' AND pr.expires_at IS NOT NULL AND pr.expires_at < now()) AS is_expired
    FROM shop_payment_requests pr
    LEFT JOIN shop_orders o ON o.id = pr.order_id
    WHERE ${where}
    ORDER BY pr.created_at DESC
    LIMIT 30 OFFSET ${(page - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_payment_requests pr WHERE ${where}
  `);

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      request_no: String(r.request_no),
      title: String(r.title),
      description: r.description ? String(r.description) : null,
      amount: Number(r.amount),
      status: r.is_expired === true ? "expired" : String(r.status),
      status_label:
        r.is_expired === true ? "기한 지남"
        : String(r.status) === "paid" ? "결제완료"
        : String(r.status) === "cancelled" ? "취소"
        : "결제대기",
      expires_at: r.expires_at,
      customer_name: r.customer_name ? String(r.customer_name) : null,
      customer_phone: r.customer_phone ? String(r.customer_phone) : null,
      customer_email: r.customer_email ? String(r.customer_email) : null,
      created_at: r.created_at,
      paid_at: r.paid_at,
      order_no: r.order_no ? String(r.order_no) : null,
      memo: r.memo ? String(r.memo) : null,
      /** 손님에게 보낼 링크 — 관리자만 본다 */
      pay_path: `/shop/pay/${String(r.token)}`,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page,
    pageSize: 30,
  };
}
