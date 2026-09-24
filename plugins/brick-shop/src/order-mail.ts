import { sql } from "drizzle-orm";
import { won, type Db, type OrderStatus } from "./types.js";
import { localeTag, t } from "./i18n.js";
import { SITE_TZ } from "@brick/plugin-sdk";
import { depositDeadline } from "./unpaid.js";

/**
 * 주문 안내 메일.
 *
 * 왜 만들었는가: 주문서의 이메일 칸에는 **"이메일 (선택 — 주문 안내를 받습니다)"**
 * 라고 적혀 있었다. 그런데 그 주소로 나가는 메일이 하나도 없었다 — 주문을 받고,
 * 입금을 확인하고, 송장을 넣고 발송해도 손님은 아무 소식을 듣지 못했다.
 * 화면이 약속한 것을 서버가 하지 않고 있었다.
 *
 * 특히 비회원이 곤란하다. 주문번호를 화면에서 옮겨 적지 않으면 다시 찾을 길이 없다.
 * 그래서 메일에 **조회 링크(주문번호 + 토큰)** 를 넣는다.
 *
 * 어느 상태에서 보내는가:
 *   pending   주문 접수 — 무통장입금이면 입금할 계좌를 함께
 *   paid      결제(입금) 확인
 *   shipped   발송 (송장번호)
 *   cancelled 취소
 *   refunded  환불 완료
 *
 * 보내지 않는 것: preparing(내부 준비 상태 — 손님에게는 결제 완료와 구분이 없다),
 * delivered(택배사가 아는 사실을 우리가 다시 알릴 이유가 없고, 운영자가 일괄로
 * 바꾸는 순간 수십 통이 한꺼번에 나간다).
 */

/**
 * 메일을 보내는 상태. 여기 없는 상태는 보내지 않는다.
 *
 * 문구는 번역 카탈로그에서 가져온다 — 금액은 언어를 따라가는데 문장은 한국어로
 * 남으면 반쪽이 되고, 그것은 둘 중 하나로 통일된 것보다 나쁘다.
 */
const MAILED: readonly OrderStatus[] = ["pending", "paid", "shipped", "cancelled", "refunded"];

export interface OrderMailPort {
  /**
   * 한 통 보낸다.
   *
   * `userId` 는 **사이트 안 알림함**을 위한 것이다 — 회원 주문이면 메일과 함께
   * 알림함에도 남는다. 메일만 보내던 시절에는 SMTP 가 없는 사이트에서(기본값이다)
   * 결제·배송 안내가 통째로 사라졌다.
   */
  send: (msg: {
    to: string;
    subject: string;
    text: string;
    userId?: string | null;
    url?: string;
    /** 주문서에 적힌 연락처 — 문자로도 보낼 때 쓴다 */
    phone?: string | null;
    /** 문자로도 보낼까 (설정이 켜져 있고 이 상태가 손님이 기다리는 것일 때) */
    sms?: true;
  }) => Promise<boolean>;
  siteUrl: string;
  siteName: string;
  /** 무통장입금 안내 계좌 (비어 있으면 안내 문구를 넣지 않는다) */
  bankAccount: string;
  /** 무통장입금 입금 기한(일) — 0 이면 기한 없음. 알리지 않은 기한으로 취소하지 않는다 */
  depositDays?: number;
  /** 주문 안내를 문자로도 보낼까 (설정) */
  sms?: boolean;
  log?: (message: string) => void;
}

/**
 * 한 주문에 대해 상태 안내를 보낸다.
 *
 * 받는 주소가 없으면(비회원이 이메일을 비웠고 회원도 아니면) 조용히 지나간다 —
 * 이메일은 선택 입력이다.
 */
export async function sendOrderMail(
  db: Db,
  port: OrderMailPort,
  /*
   * kind 는 상태 전이가 아닌 알림을 위한 것이다 — 지금은 "송장이 나중에 붙었다" 하나.
   *
   * 한국 쇼핑몰의 실제 흐름이 그렇다: 오전에 택배사에 넘기고 발송 처리, 송장은
   * 저녁에 일괄 등록. 관리 화면의 일괄 작업도 "발송 처리" 와 "송장번호 입력 + 발송"
   * 을 따로 두고 있다. 그런데 나중에 붙인 송장은 손님에게 아무것도 알리지 않아서,
   * 손님은 송장 없는 발송 메일만 받고 주문 조회를 새로고침하게 된다.
   */
  params: { orderId: string; status: OrderStatus; kind?: "trackingAdded" },
): Promise<boolean> {
  if (!params.kind && !MAILED.includes(params.status)) return false;
  const key = params.kind ?? params.status;
  const subject = t(`ordermail.${key}.subject`);
  const lead = t(`ordermail.${key}.lead`);

  const { rows } = await db.execute(sql`
    SELECT o.order_no, o.total, o.status, o.tracking_no, o.guest_token, o.payment_method,
           o.orderer_name, o.user_id, o.orderer_phone, o.created_at, o.cancelled_reason,
           coalesce(nullif(o.orderer_email, ''), u.email) AS email
    FROM shop_orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ${params.orderId}::uuid
    LIMIT 1
  `);
  const order = rows[0];
  if (!order) return false;

  const to = String(order.email ?? "").trim();
  /*
   * 주소도 없고 회원도 아니면 보낼 곳이 없다 — 이메일은 선택 입력이다.
   * 회원이면 주소가 없어도 알림함에는 남는다. 주소를 안 적었다는 것이
   * "아무 소식도 받지 않겠다" 는 뜻은 아니다.
   */
  if (!to && !order.user_id) return false;

  const { rows: items } = await db.execute(sql`
    SELECT product_name, option_name, quantity, line_total
    FROM shop_order_items WHERE order_id = ${params.orderId}::uuid
    ORDER BY id
  `);

  const base = port.siteUrl.replace(/\/$/, "");
  /*
   * 조회 링크에 토큰을 붙인다.
   *
   * 비회원은 이 링크가 유일한 조회 수단이다. 회원 주문에는 붙이지 않는다 —
   * 메일이 전달되는 과정에 남는 주소에 조회 권한을 실을 이유가 없고, 회원은
   * 로그인해서 본다.
   */
  const lookup = order.guest_token
    ? `${base}/shop/orders/${String(order.order_no)}?token=${encodeURIComponent(String(order.guest_token))}`
    : `${base}/shop/orders/${String(order.order_no)}`;

  const body = [
    t("ordermail.greeting", { name: String(order.orderer_name), lead }),
    "",
    t("ordermail.orderNo", { orderNo: String(order.order_no) }),
    ...items.map((it) => {
      const name = it.option_name
        ? `${String(it.product_name)} (${String(it.option_name)})`
        : String(it.product_name);
      return `  · ${name} × ${Number(it.quantity)} — ${won(Number(it.line_total))}`;
    }),
    t("ordermail.total", { amount: won(Number(order.total)) }),
  ];

  // 무통장입금은 **입금할 곳**을 알려주는 것이 이 메일의 본체다
  if (params.status === "pending" && order.payment_method === "bank_transfer" && port.bankAccount) {
    body.push("", t("ordermail.bankAccount", { account: port.bankAccount }), t("ordermail.bankNotice"));
    const due = depositDeadline(order.created_at as Date, port.depositDays ?? 0);
    if (due) body.push(t("ordermail.depositDue", { date: formatDue(due) }));
  }
  if ((params.status === "shipped" || params.kind === "trackingAdded") && order.tracking_no) {
    body.push("", t("ordermail.tracking", { trackingNo: String(order.tracking_no) }));
  }

  // 자동 취소였다면 왜 취소됐는지 말한다 — 손님은 "내가 취소하지 않았는데" 로 읽는다
  if (params.status === "cancelled" && typeof order.cancelled_reason === "string" && order.cancelled_reason.includes("자동 취소")) {
    body.push("", t(order.payment_method === "bank_transfer" ? "ordermail.autoCancelledDeposit" : "ordermail.autoCancelledUnpaid"));
  }
  body.push(
    "",
    t("ordermail.lookup", { url: lookup }),
    "",
    "─────────────────────────────────────",
    t("ordermail.footer", { site: port.siteName }),
  );

  try {
    return await port.send({
      to,
      subject: `[${port.siteName}] ${subject} (${String(order.order_no)})`,
      text: body.join("\n"),
      userId: order.user_id ? String(order.user_id) : null,
      // 회원은 주문 내역에서 바로 본다 (비회원 조회 주소는 본문의 링크가 안내한다)
      url: order.user_id ? "/shop/orders" : "",
      phone: String(order.orderer_phone ?? ""),
      ...(port.sms ? { sms: true as const } : {}),
    });
  } catch (err) {
    // 메일 실패가 주문 흐름을 막아서는 안 된다 — 기록만 남기고 넘어간다
    port.log?.(`주문 안내 메일 실패 (${String(order.order_no)}): ${(err as Error).message}`);
    return false;
  }
}

/** 입금 기한 표기 — 사이트 시간대와 언어로 ("9월 27일 오후 2:30") */
export function formatDue(d: Date): string {
  return new Intl.DateTimeFormat(localeTag(), {
    timeZone: SITE_TZ, month: "long", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(d);
}
