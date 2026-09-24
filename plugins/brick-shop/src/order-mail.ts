import { sql } from "drizzle-orm";
import { ShopError, won, type Db, type OrderStatus } from "./types.js";
import { localeTag, t } from "./i18n.js";
import { SITE_TZ, fillTemplate, normalizePhone, type NotificationEvent } from "@brick/plugin-sdk";
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

/**
 * 주문 알림 종류와 변수 — 알림톡 템플릿은 **이 이름으로** `#{…}` 를 쓴다.
 *
 * 변수 이름을 한국어로 둔 이유: 카카오 알림톡 템플릿은 운영자가 카카오 쪽 화면에서 직접 쓰고
 * 심사받는다. `#{고객명}` 이 `#{orderer_name}` 보다 틀리기 어렵다.
 */
const COMMON_VARS: NotificationEvent["vars"] = [
  { name: "고객명", description: "주문자 이름", sample: "홍길동" },
  { name: "주문번호", description: "주문번호", sample: "20260924-000001" },
  { name: "상품명", description: "첫 상품 이름 (여러 개면 \"외 N건\")", sample: "머그컵 외 1건" },
  { name: "상품목록", description: "주문한 상품 전부 (한 줄에 하나 — 메일용)", sample: "  · 머그컵 × 1 — 12,000원\n  · 컵받침 × 2 — 6,000원" },
  { name: "결제금액", description: "주문 총액", sample: "25,000원" },
  { name: "쇼핑몰명", description: "사이트 이름", sample: "브릭 상점" },
  { name: "주문조회", description: "주문 조회 주소 (비회원은 조회 토큰 포함)", sample: "https://shop.example/shop/orders/20260924-000001" },
];
const PAYMENT_VARS: NotificationEvent["vars"] = [
  { name: "입금계좌", description: "무통장입금 계좌 (다른 결제 수단이면 빈칸)", sample: "국민은행 000-00-0000 (브릭)" },
  { name: "입금기한", description: "무통장입금 기한 (없으면 빈칸)", sample: "9월 27일 (토) 오후 2:30" },
  { name: "결제안내", description: "무통장입금이면 계좌·기한 안내 여러 줄 (아니면 빈칸)", sample: "입금 계좌: 국민은행 000-00-0000 (브릭)\n입금이 확인되면 다시 알려드립니다." },
];
const SHIPPING_VARS: NotificationEvent["vars"] = [
  { name: "송장번호", description: "운송장 번호 (없으면 빈칸)", sample: "123456789012" },
  { name: "배송안내", description: "송장번호가 있으면 그 한 줄 (없으면 빈칸)", sample: "송장번호: 123456789012" },
];
const CANCEL_VARS: NotificationEvent["vars"] = [
  { name: "취소안내", description: "자동 취소였다면 그 이유 (아니면 빈칸)", sample: "입금 기한이 지나 주문이 자동으로 취소되었습니다." },
];

/** 알림 종류 → 기본 문구에 넣을 안내 변수 (그 알림에서만 값이 있는 것) */
type OrderMailKey = "pending" | "paid" | "shipped" | "trackingAdded" | "cancelled" | "refunded" | "virtualAccount";
const EXTRA: Record<OrderMailKey, string> = {
  pending: "#{결제안내}",
  virtualAccount: "#{결제안내}",
  paid: "",
  shipped: "#{배송안내}",
  trackingAdded: "#{배송안내}",
  cancelled: "#{취소안내}",
  refunded: "",
};

/**
 * 주문 안내의 기본 문구 — `#{변수}` 로 쓴다. **실제로 나가는 문구가 이것을 채운 것이다**
 * (`fillTemplate`). 그래서 운영자가 알림 문구 화면에서 "기본 문구 불러오기" 로 가져온 문장과
 * 지금 나가는 문장이 글자까지 같다 — 둘을 따로 만들면 반드시 어긋난다.
 */
export function orderMailTemplate(key: OrderMailKey): { subject: string; body: string } {
  const extra = EXTRA[key];
  return {
    subject: `[#{쇼핑몰명}] ${t(`ordermail.${key}.subject`)} (#{주문번호})`,
    body: [
      t("ordermail.greeting", { name: "#{고객명}", lead: t(`ordermail.${key}.lead`) }),
      "",
      t("ordermail.orderNo", { orderNo: "#{주문번호}" }),
      "#{상품목록}",
      t("ordermail.total", { amount: "#{결제금액}" }),
      ...(extra ? ["", extra] : []),
      "",
      t("ordermail.lookup", { url: "#{주문조회}" }),
      "",
      "─────────────────────────────────────",
      t("ordermail.footer", { site: "#{쇼핑몰명}" }),
    ].join("\n"),
  };
}

const eventOf = (key: OrderMailKey) =>
  `shop.order.${key === "trackingAdded" ? "tracking" : key === "virtualAccount" ? "deposit" : key}`;
const ev = (key: OrderMailKey, label: string, vars: NotificationEvent["vars"]): NotificationEvent => ({
  event: eventOf(key), label, vars, defaults: () => orderMailTemplate(key),
});
export const ORDER_EVENTS: NotificationEvent[] = [
  ev("pending", "주문 — 접수", [...COMMON_VARS, ...PAYMENT_VARS]),
  ev("virtualAccount", "주문 — 가상계좌 입금 안내", [...COMMON_VARS, ...PAYMENT_VARS]),
  ev("paid", "주문 — 결제 확인", COMMON_VARS),
  ev("shipped", "주문 — 발송", [...COMMON_VARS, ...SHIPPING_VARS]),
  ev("trackingAdded", "주문 — 운송장 번호 등록", [...COMMON_VARS, ...SHIPPING_VARS]),
  ev("cancelled", "주문 — 취소", [...COMMON_VARS, ...CANCEL_VARS]),
  ev("refunded", "주문 — 환불 완료", COMMON_VARS),
];

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
    /** 알림 종류와 템플릿 변수 — 알림톡처럼 승인된 템플릿으로 보내는 통로가 쓴다 */
    event?: string;
    vars?: Record<string, string>;
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
  params: { orderId: string; status: OrderStatus; kind?: "trackingAdded" | "virtualAccount" },
): Promise<boolean> {
  if (!params.kind && !MAILED.includes(params.status)) return false;
  const key = (params.kind ?? params.status) as OrderMailKey;

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
   *
   * 단, 문자(알림톡)를 켠 가게에서 **전화번호만 적은 비회원**에게는 문자가 유일한 통로다.
   * 전에는 여기서 끝나서, 이메일을 비운 비회원 손님은 문자 알림을 켜 둔 가게에서도 접수·
   * 발송 안내를 한 통도 받지 못했다(주문서는 전화번호를 필수로 받는다).
   */
  const phone = normalizePhone(order.orderer_phone);
  if (!to && !order.user_id && !(port.sms && phone)) return false;

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

  const first = items[0];
  const vars: Record<string, string> = {
    고객명: String(order.orderer_name ?? ""),
    주문번호: String(order.order_no),
    상품명: first
      ? items.length > 1
        ? t("ordermail.itemsMore", { name: String(first.product_name), n: items.length - 1 })
        : String(first.product_name)
      : "",
    상품목록: items.map((it) => {
      const name = it.option_name
        ? `${String(it.product_name)} (${String(it.option_name)})`
        : String(it.product_name);
      return `  · ${name} × ${Number(it.quantity)} — ${won(Number(it.line_total))}`;
    }).join("\n"),
    결제금액: won(Number(order.total)),
    쇼핑몰명: port.siteName,
    주문조회: lookup,
    입금계좌: "",
    입금기한: "",
    결제안내: "",
    송장번호: order.tracking_no ? String(order.tracking_no) : "",
    배송안내: "",
    취소안내: "",
  };
  // 무통장입금은 **입금할 곳**을 알려주는 것이 이 메일의 본체다
  if (params.status === "pending" && order.payment_method === "bank_transfer" && port.bankAccount) {
    vars.입금계좌 = port.bankAccount;
    const lines = [t("ordermail.bankAccount", { account: port.bankAccount }), t("ordermail.bankNotice")];
    const due = depositDeadline(order.created_at as Date, port.depositDays ?? 0);
    if (due) {
      vars.입금기한 = formatDue(due);
      lines.push(t("ordermail.depositDue", { date: vars.입금기한 }));
    }
    vars.결제안내 = lines.join("\n");
  }
  /*
   * 가상계좌 — 발급된 계좌와 기한이 이 안내의 본체다. 주문 접수 안내에는 계좌가 없었다(카드처럼
   * 결제창으로 넘어가는 수단이라 접수 시점에는 계좌가 없다).
   */
  if (params.kind === "virtualAccount") {
    const { rows: va } = await db.execute(sql`
      SELECT va_bank, va_account, va_holder, va_expires_at FROM shop_payments
      WHERE order_id = ${params.orderId}::uuid AND status = 'waiting' ORDER BY created_at DESC LIMIT 1
    `);
    if (!va[0]) return false;
    vars.입금계좌 = virtualAccountText(String(va[0].va_bank ?? ""), String(va[0].va_account ?? ""), va[0].va_holder ? String(va[0].va_holder) : null);
    const lines = [t("ordermail.bankAccount", { account: vars.입금계좌 }), t("ordermail.bankNotice")];
    if (va[0].va_expires_at) {
      vars.입금기한 = formatDue(new Date(String(va[0].va_expires_at)));
      lines.push(t("ordermail.vaDue", { date: vars.입금기한 }));
    }
    vars.결제안내 = lines.join("\n");
  }
  if ((params.status === "shipped" || params.kind === "trackingAdded") && order.tracking_no) {
    vars.배송안내 = t("ordermail.tracking", { trackingNo: String(order.tracking_no) });
  }
  // 자동 취소였다면 왜 취소됐는지 말한다 — 손님은 "내가 취소하지 않았는데" 로 읽는다
  if (params.status === "cancelled" && typeof order.cancelled_reason === "string" && order.cancelled_reason.includes("자동 취소")) {
    vars.취소안내 = t(order.payment_method === "bank_transfer" ? "ordermail.autoCancelledDeposit" : "ordermail.autoCancelledUnpaid");
  }

  // 운영자가 문구를 고쳤다면 코어가 그 문구로 바꿔 보낸다(event·vars) — 여기서는 기본 문구를 채운다
  const tpl = orderMailTemplate(key);
  try {
    return await port.send({
      to,
      subject: fillTemplate(tpl.subject, vars),
      text: fillTemplate(tpl.body, vars),
      userId: order.user_id ? String(order.user_id) : null,
      // 회원은 주문 내역에서 바로 본다 (비회원 조회 주소는 본문의 링크가 안내한다)
      url: order.user_id ? "/shop/orders" : "",
      phone: String(order.orderer_phone ?? ""),
      ...(port.sms ? { sms: true as const } : {}),
      event: eventOf(key),
      vars,
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

/**
 * 가상계좌 표기 — "신한은행 56211234567890 (예금주 브릭상점)".
 *
 * PG 는 은행을 코드로 준다(`SHINHAN`). 손님이 은행 앱에서 고르는 것은 이름이므로 바꿔 적는다.
 * 모르는 코드는 그대로 둔다 — 틀린 은행 이름보다 코드가 낫다.
 */
const BANK_NAMES: Record<string, string> = {
  KOOKMIN: "국민은행", SHINHAN: "신한은행", WOORI: "우리은행", HANA: "하나은행", NONGHYUP: "농협은행",
  IBK: "기업은행", KAKAO: "카카오뱅크", TOSS: "토스뱅크", K_BANK: "케이뱅크", SC: "SC제일은행",
  CITI: "한국씨티은행", SUHYUP: "수협은행", POST: "우체국", SAEMAUL: "새마을금고", SHINHYEOP: "신협",
  BUSAN: "부산은행", DAEGU: "대구은행", KWANGJU: "광주은행", JEONBUK: "전북은행", KYONGNAM: "경남은행",
  JEJU: "제주은행", KDB: "산업은행",
};
/** 환불 계좌로 받을 수 있는 은행 코드 (관리 화면의 선택지와 같다) */
export const BANK_CODES = Object.keys(BANK_NAMES);
export const BANK_OPTIONS = Object.entries(BANK_NAMES).map(([value, label]) => ({ value, label }));
/**
 * 환불 받을 계좌 — 셋 다 비었으면 없음, 하나라도 있으면 셋 다 올바라야 한다(반쯤 적은 계좌로 PG 에
 * 보내면 PG 의 말로 거절된다). 은행은 PG 의 은행 코드다. 운영자 폼과 손님의 반품 신청서가 같이 쓴다.
 */
export function parseRefundAccount(b: { refund_bank?: unknown; refund_account_no?: unknown; refund_holder?: unknown }):
  { bank: string; number: string; holder: string } | null {
  const bank = String(b.refund_bank ?? "").trim().toUpperCase();
  const number = String(b.refund_account_no ?? "").replace(/[\s-]/g, "");
  const holder = String(b.refund_holder ?? "").trim();
  if (!bank && !number && !holder) return null;
  if (!BANK_CODES.includes(bank)) throw new ShopError(400, "환불 받을 은행을 골라주세요.", "refund_bank");
  if (!/^\d{6,20}$/.test(number)) throw new ShopError(400, "환불 받을 계좌번호는 숫자 6~20자리여야 합니다.", "refund_account_no");
  if (!holder || holder.length > 30) throw new ShopError(400, "환불 받을 계좌의 예금주를 입력해주세요.", "refund_holder");
  return { bank, number, holder };
}

export function virtualAccountText(bank: string, account: string, holder: string | null): string {
  // 은행 이름도 사이트 언어로 (원문이 번역 키다)
  const known = BANK_NAMES[bank.toUpperCase()];
  const name = known ? t(known) : bank;
  return `${name} ${account}${holder ? ` (${t("ordermail.vaHolder", { holder })})` : ""}`.trim();
}

