/**
 * 판매 리포트 — 기간별 · 상품별 · 분류별.
 *
 * 이 파일에서 중요한 것은 SQL 이 아니라 **무엇을 매출로 셀 것인가**다.
 * 기존 /admin/stats 는 두 가지가 틀려 있었다:
 *
 *   1. `sum(total)` 로 집계해 **부분 환불을 빼지 않았다.** 주문 상태가
 *      cancelled/refunded 로 바뀌는 것은 전체 취소뿐이고, 두 개 중 하나를
 *      반품한 주문은 전액이 매출로 남았다.
 *   2. `created_at >= date_trunc('month', now())` — **주문일 기준이고
 *      서버 시간대**다. 한국에서 1일 오전 9시 이전 결제는 전달로 잡힌다.
 *
 * 그래서 정의를 먼저 못박는다.
 *
 * ── 매출의 정의 ──────────────────────────────────────
 *
 * **결제된 것만 매출이다.** `paid_at IS NOT NULL` 을 기준으로 하고, 시점도
 * 주문일이 아니라 **결제일**이다. 무통장 주문을 걸어놓고 입금하지 않는 것이
 * 흔한데, 그것을 매출로 세면 숫자를 믿을 수 없다.
 *
 * **순매출 = 받은 돈 − 돌려준 돈.**
 *   주문 기준: Σ orders.total − Σ (완료된 반품의 refund_amount)
 *   상품 기준: Σ (line_total − 할인안분) − Σ refunded_amount
 *
 * 반품의 `refund_amount` 는 전체 취소 시의 배송비 환불을 포함하고, 고객이
 * 부담하는 반송비는 이미 차감된 값이다(returns.ts). 그래서 그것을 그대로
 * 빼면 실제로 나간 현금과 일치한다.
 *
 * **신청만 한 반품은 빼지 않는다.** 물건을 받기 전에는 환불되지 않으므로
 * (ADR-44) 아직 나간 돈이 아니다. `completed` 인 것만 뺀다.
 *
 * ── 시간대 ───────────────────────────────────────────
 *
 * 일·주·월 구분은 **사이트 시간대 기준**이다(`BRICK_TIMEZONE`, 기본
 * `Asia/Seoul`). UTC 로 자르면 오전 9시 이전 주문이 전날로 밀려서, 운영자가
 * 결제 화면에서 보는 날짜와 리포트의 날짜가 다르다.
 *
 * 환경변수로 둔 이유: 시간대를 바꾸면 **과거 집계까지 달라진다.** 관리
 * 화면에서 클릭으로 바꿀 성질의 값이 아니다.
 */
import { sql } from "drizzle-orm";
import type { PluginDb } from "@brick/plugin-sdk";
import { ShopError } from "./types.js";

/** 사이트 시간대. 리포트의 날짜 경계를 정한다. */
export const SITE_TZ = process.env.BRICK_TIMEZONE?.trim() || "Asia/Seoul";

export type GroupBy = "day" | "week" | "month";
const GROUP_UNITS: Record<GroupBy, string> = { day: "day", week: "week", month: "month" };

export interface Period {
  /** 사이트 시간대의 날짜 (YYYY-MM-DD). 포함. */
  from: string;
  /** 사이트 시간대의 날짜 (YYYY-MM-DD). **이 날 끝까지 포함.** */
  to: string;
}

/**
 * 기간 파싱.
 *
 * `to` 를 그날 **끝까지** 포함시킨다. 운영자가 8월 1일 ~ 8월 31일을 넣으면
 * 8월 전체를 뜻하는 것이고, 31일이 빠지면 조용히 하루치가 사라진다.
 */
export function parsePeriod(query: Record<string, unknown>): Period {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const rawFrom = String(query.from ?? "").trim();
  const rawTo = String(query.to ?? "").trim();

  // 기본값: 최근 30일
  const defaultTo = iso(today);
  const defaultFrom = iso(new Date(today.getTime() - 29 * 86400_000));

  const from = rawFrom || defaultFrom;
  const to = rawTo || defaultTo;

  const shape = /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(from)) throw new ShopError(400, "from 은 YYYY-MM-DD 형식이어야 합니다.");
  if (!shape.test(to)) throw new ShopError(400, "to 은 YYYY-MM-DD 형식이어야 합니다.");
  // 형식이 맞아도 날짜가 아닐 수 있다 (2026-02-30).
  //
  // Date.parse 로는 못 잡는다 — **JS 는 넘치는 날짜를 다음 달로 굴린다.**
  // 2026-02-30 은 NaN 이 아니라 3월 2일이 되어 검증을 통과하고, 그 뒤 PG 가
  // 던져서 500 이 난다. 되돌려 찍어서 같은 문자열이 나오는지 확인한다.
  const isRealDate = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  };
  if (!isRealDate(from)) throw new ShopError(400, `없는 날짜입니다: ${from}`);
  if (!isRealDate(to)) throw new ShopError(400, `없는 날짜입니다: ${to}`);
  if (from > to) throw new ShopError(400, "from 이 to 보다 뒤입니다.");

  // 상한을 둔다 — 일별로 10년을 뽑으면 3천 행이 넘고 화면이 죽는다
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
  if (days > 366 * 5) throw new ShopError(400, "기간이 너무 깁니다 (최대 5년).");

  return { from, to };
}

export function parseGroupBy(value: unknown): GroupBy {
  const v = String(value ?? "day");
  if (v !== "day" && v !== "week" && v !== "month") {
    throw new ShopError(400, "groupBy 는 day · week · month 중 하나여야 합니다.");
  }
  return v;
}

/**
 * 기간 조건.
 *
 * 사이트 시간대의 벽시계 날짜를 timestamptz 로 바꾼다. `to` 는 다음 날
 * 0시 미만으로 비교해 그날 전체를 포함시킨다.
 */
function periodWhere(column: string, p: Period) {
  const col = sql.raw(column);
  return sql`
    ${col} >= (${p.from}::date::timestamp AT TIME ZONE ${SITE_TZ})
    AND ${col} < ((${p.to}::date + 1)::timestamp AT TIME ZONE ${SITE_TZ})
  `;
}

/**
 * 주문별 환불 합계 (완료된 것만).
 *
 * 서브쿼리로 두는 이유: 주문에 반품이 여러 건 붙을 수 있어서 그냥 조인하면
 * 주문 금액이 반품 건수만큼 곱해진다 — 매출이 부풀어 보이는 대표적인 실수다.
 */
const refundsByOrder = sql`
  SELECT order_id,
         sum(refund_amount) AS refunded,
         sum(return_shipping_fee) AS return_shipping
  FROM shop_returns
  WHERE status = 'completed'
  GROUP BY order_id
`;

// ════════════════════════════════════════════════════
//  기간별
// ════════════════════════════════════════════════════

export async function salesByPeriod(
  db: PluginDb,
  params: { period: Period; groupBy: GroupBy },
) {
  const { period, groupBy } = params;
  const unit = sql.raw(`'${GROUP_UNITS[groupBy]}'`);

  const { rows } = await db.execute(sql`
    WITH refunds AS (${refundsByOrder})
    SELECT
      to_char(date_trunc(${unit}, o.paid_at AT TIME ZONE ${SITE_TZ}), 'YYYY-MM-DD') AS bucket,
      count(*)                                        AS orders,
      coalesce(sum(o.total), 0)                       AS gross,
      coalesce(sum(o.discount + coalesce(o.point_used, 0)), 0) AS discount,
      coalesce(sum(o.shipping_fee), 0)                AS shipping,
      coalesce(sum(coalesce(r.refunded, 0)), 0)       AS refunded,
      coalesce(sum(coalesce(r.return_shipping, 0)), 0) AS return_shipping,
      coalesce(sum(o.total - coalesce(r.refunded, 0)), 0) AS net
    FROM shop_orders o
    LEFT JOIN refunds r ON r.order_id = o.id
    WHERE o.paid_at IS NOT NULL AND ${periodWhere("o.paid_at", period)}
    GROUP BY 1
    ORDER BY 1
  `);

  const buckets = rows.map((r) => ({
    bucket: String(r.bucket),
    orders: Number(r.orders),
    gross: Number(r.gross),
    discount: Number(r.discount),
    shipping: Number(r.shipping),
    refunded: Number(r.refunded),
    returnShipping: Number(r.return_shipping),
    net: Number(r.net),
  }));

  const sum = (pick: (b: (typeof buckets)[number]) => number) =>
    buckets.reduce((acc, b) => acc + pick(b), 0);

  const orders = sum((b) => b.orders);
  const net = sum((b) => b.net);

  return {
    period,
    groupBy,
    timezone: SITE_TZ,
    buckets,
    total: {
      orders,
      gross: sum((b) => b.gross),
      discount: sum((b) => b.discount),
      shipping: sum((b) => b.shipping),
      refunded: sum((b) => b.refunded),
      net,
      /** 평균 주문금액. 주문이 없으면 0 — 0으로 나누지 않는다 */
      avgOrderValue: orders > 0 ? Math.round(net / orders) : 0,
    },
  };
}

// ════════════════════════════════════════════════════
//  상품별
// ════════════════════════════════════════════════════

/**
 * 상품별 판매.
 *
 * 상품 기준 금액은 주문 항목에서 계산한다. 주문 단위 할인을 항목에 **안분**해야
 * 하는데, 반품 때 쓰는 것과 같은 규칙(항목 정가 비중, 내림)을 쓴다 —
 * 규칙이 다르면 "반품액 + 남은 매출 ≠ 받은 돈" 이 되어 아무도 못 맞춘다.
 *
 * `sold_count` 를 쓰지 않는 이유: 그것은 누적 카운터라 기간을 자를 수 없다.
 */
export async function salesByProduct(
  db: PluginDb,
  params: { period: Period; sort?: string; limit?: number },
) {
  const { period } = params;
  const sortKey = String(params.sort ?? "net");
  const orderBy = sql.raw(
    sortKey === "qty" ? "qty DESC, net DESC"
      : sortKey === "orders" ? "orders DESC, net DESC"
      : "net DESC, qty DESC",
  );
  const limit = Math.min(500, Math.max(1, Math.floor(Number(params.limit ?? 50) || 50)));

  const { rows } = await db.execute(sql`
    SELECT
      oi.product_id,
      -- 상품이 삭제되어도 이름은 주문 시점 스냅샷으로 남는다.
      -- 여러 이름이 섞이면 가장 최근 것을 쓴다 (상품명이 바뀌었을 수 있다)
      (array_agg(oi.product_name ORDER BY o.paid_at DESC))[1] AS product_name,
      p.slug,
      c.name AS category_name,
      sum(oi.quantity - oi.cancelled_qty)                    AS qty,
      sum(oi.cancelled_qty)                                  AS cancelled_qty,
      count(DISTINCT o.id)                                   AS orders,
      sum(oi.line_total)                                     AS gross,
      sum(oi.refunded_amount)                                AS refunded,
      -- 할인 안분: 주문 할인 × (항목 정가 / 주문 상품합계). subtotal 0 방어.
      sum(CASE WHEN o.subtotal > 0
               THEN floor(((o.discount + coalesce(o.point_used, 0))::numeric * oi.line_total) / o.subtotal)
               ELSE 0 END)                                   AS discount_share,
      sum(oi.line_total - oi.refunded_amount
          - CASE WHEN o.subtotal > 0
                 THEN floor(((o.discount + coalesce(o.point_used, 0))::numeric * oi.line_total) / o.subtotal)
                 ELSE 0 END)                                 AS net
    FROM shop_order_items oi
    JOIN shop_orders o ON o.id = oi.order_id
    LEFT JOIN shop_products p ON p.id = oi.product_id
    LEFT JOIN shop_categories c ON c.id = p.category_id
    WHERE o.paid_at IS NOT NULL AND ${periodWhere("o.paid_at", period)}
    GROUP BY oi.product_id, p.slug, c.name
    HAVING sum(oi.quantity - oi.cancelled_qty) > 0 OR sum(oi.cancelled_qty) > 0
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `);

  return {
    period,
    timezone: SITE_TZ,
    sort: sortKey,
    products: rows.map((r) => ({
      productId: r.product_id ? String(r.product_id) : null,
      productName: String(r.product_name ?? "(삭제된 상품)"),
      slug: r.slug ? String(r.slug) : null,
      categoryName: r.category_name ? String(r.category_name) : null,
      qty: Number(r.qty),
      cancelledQty: Number(r.cancelled_qty),
      orders: Number(r.orders),
      gross: Number(r.gross),
      discount: Number(r.discount_share),
      refunded: Number(r.refunded),
      net: Number(r.net),
    })),
  };
}

// ════════════════════════════════════════════════════
//  분류별
// ════════════════════════════════════════════════════

/**
 * 분류별 판매.
 *
 * `rollup` 이면 **최상위 분류로 합친다.** 분류를 3단으로 쓰는 사이트에서
 * 말단 분류별 숫자만 보면 "의류가 얼마나 팔렸는가"를 알 수 없다.
 * 재귀 CTE 로 조상을 찾는다.
 *
 * 분류가 없는 상품과 삭제된 상품은 버리지 않고 `(분류 없음)` 으로 묶는다 —
 * 합계가 기간별 리포트와 안 맞으면 운영자는 둘 다 믿지 않게 된다.
 */
export async function salesByCategory(
  db: PluginDb,
  params: { period: Period; rollup?: boolean },
) {
  const { period } = params;
  const rollup = params.rollup === true;

  const { rows } = await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT id, id AS root_id, name AS root_name, parent_id
      FROM shop_categories WHERE parent_id IS NULL
      UNION ALL
      SELECT c.id, t.root_id, t.root_name, c.parent_id
      FROM shop_categories c JOIN tree t ON c.parent_id = t.id
    )
    SELECT
      ${rollup ? sql`coalesce(t.root_id::text, 'none')` : sql`coalesce(c.id::text, 'none')`} AS category_id,
      ${rollup ? sql`coalesce(t.root_name, '(분류 없음)')` : sql`coalesce(c.name, '(분류 없음)')`} AS category_name,
      sum(oi.quantity - oi.cancelled_qty) AS qty,
      count(DISTINCT o.id)                AS orders,
      sum(oi.line_total)                  AS gross,
      sum(oi.refunded_amount)             AS refunded,
      sum(oi.line_total - oi.refunded_amount
          - CASE WHEN o.subtotal > 0
                 THEN floor(((o.discount + coalesce(o.point_used, 0))::numeric * oi.line_total) / o.subtotal)
                 ELSE 0 END)             AS net
    FROM shop_order_items oi
    JOIN shop_orders o ON o.id = oi.order_id
    LEFT JOIN shop_products p ON p.id = oi.product_id
    LEFT JOIN shop_categories c ON c.id = p.category_id
    LEFT JOIN tree t ON t.id = c.id
    WHERE o.paid_at IS NOT NULL AND ${periodWhere("o.paid_at", period)}
    GROUP BY 1, 2
    ORDER BY net DESC
  `);

  return {
    period,
    timezone: SITE_TZ,
    rollup,
    categories: rows.map((r) => ({
      categoryId: String(r.category_id) === "none" ? null : String(r.category_id),
      categoryName: String(r.category_name),
      qty: Number(r.qty),
      orders: Number(r.orders),
      gross: Number(r.gross),
      refunded: Number(r.refunded),
      net: Number(r.net),
    })),
  };
}

// ════════════════════════════════════════════════════
//  요약 (전 기간 대비)
// ════════════════════════════════════════════════════

/**
 * 요약 — 같은 길이의 직전 기간과 비교한다.
 *
 * "이번 달 1,200만원"만으로는 아무 판단을 할 수 없다. 지난달과 비교해야
 * 늘었는지 줄었는지 안다.
 */
export async function salesSummary(db: PluginDb, params: { period: Period }) {
  const { period } = params;
  const fromMs = Date.parse(`${period.from}T00:00:00Z`);
  const toMs = Date.parse(`${period.to}T00:00:00Z`);
  const lenDays = Math.round((toMs - fromMs) / 86400_000) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const prev: Period = {
    from: iso(fromMs - lenDays * 86400_000),
    to: iso(fromMs - 86400_000),
  };

  const one = async (p: Period) => {
    const { rows } = await db.execute(sql`
      WITH refunds AS (${refundsByOrder})
      SELECT
        count(*)                                            AS orders,
        coalesce(sum(o.total), 0)                           AS gross,
        coalesce(sum(coalesce(r.refunded, 0)), 0)           AS refunded,
        coalesce(sum(o.total - coalesce(r.refunded, 0)), 0)  AS net,
        count(DISTINCT o.user_id)                           AS buyers
      FROM shop_orders o
      LEFT JOIN refunds r ON r.order_id = o.id
      WHERE o.paid_at IS NOT NULL AND ${periodWhere("o.paid_at", p)}
    `);
    const row = rows[0] ?? {};
    const orders = Number(row.orders ?? 0);
    const net = Number(row.net ?? 0);
    return {
      period: p,
      orders,
      gross: Number(row.gross ?? 0),
      refunded: Number(row.refunded ?? 0),
      net,
      buyers: Number(row.buyers ?? 0),
      avgOrderValue: orders > 0 ? Math.round(net / orders) : 0,
    };
  };

  const [current, previous] = await Promise.all([one(period), one(prev)]);

  /**
   * 증감률.
   *
   * 직전 기간이 0이면 비율을 만들지 않고 null 을 준다. 0 → 100만원을
   * "무한 증가" 나 "100% 증가"로 표시하면 둘 다 거짓이다.
   */
  const change = (now: number, before: number) =>
    before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10;

  return {
    timezone: SITE_TZ,
    current,
    previous,
    change: {
      net: change(current.net, previous.net),
      orders: change(current.orders, previous.orders),
      avgOrderValue: change(current.avgOrderValue, previous.avgOrderValue),
    },
  };
}

// ════════════════════════════════════════════════════
//  CSV 내보내기
// ════════════════════════════════════════════════════

/**
 * CSV 로 내보낸다.
 *
 * 운영자는 결국 엑셀에서 본다. 두 가지를 지켜야 실제로 열린다:
 *
 *   1. **BOM** — 없으면 엑셀이 한글을 깨진 글자로 읽는다(UTF-8 로
 *      추정하지 않고 시스템 코드페이지로 읽기 때문이다).
 *   2. **필드 escape** — 상품명에 콤마·따옴표·줄바꿈이 들어간다.
 *      `"` 를 `""` 로 바꾸고 전체를 따옴표로 감싼다.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
  // CRLF — 엑셀이 LF 만으로도 열지만, 다른 윈도우 도구는 한 줄로 붙여 읽는다
  return `﻿${lines.join("\r\n")}\r\n`;
}
