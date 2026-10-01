/**
 * 관리자 대시보드 — 쇼핑몰이 운영자에게 아침마다 말하는 것.
 *
 * 카드("오늘 주문 3")는 숫자 하나다. 운영자가 관리자를 여는 이유는 **흐름**을 보려는 것이다:
 * 입금을 기다리는 주문, 보내야 할 주문, 배송중인 주문, 손님이 넣은 반품 신청. 카페24 관리자
 * 첫 화면이 주문 단계를 한 줄로 늘어놓는 까닭이다. 이 파일은 그 판 세 개를 만든다:
 *
 *  - 주문 현황 — 단계(입금전 → 결제완료 → 상품준비중 → 배송중 → 배송완료) · 취소/반품/교환 신청 · 답변 대기
 *  - 매출 추이 — 최근 14일 순매출 막대 (매출의 정의는 reports.ts 하나 — 여기서 다시 세지 않는다)
 *  - 최근 주문 — 다섯 건
 *
 * 숫자마다 그 건들만 보이는 목록으로 보낸다 — 눌렀을 때 전체 목록이 나오면 운영자는 눈으로 찾는다.
 */
import { sql } from "drizzle-orm";
import { SITE_TZ, siteToday } from "@brick/plugin-sdk";
import type { DashboardPanelData, PluginContext, PluginDb } from "@brick/plugin-sdk";
import { salesByPeriod } from "./reports.js";
import { STATUS_LABEL, won, type OrderStatus } from "./types.js";
import { KIND_LABEL, type ReturnKind } from "./returns.js";

const ORDERS = "/admin/x/brick-shop/orders";

/**
 * 답을 기다리는 후기·문의 수 — "처리 대기" 카드와 "주문 현황" 판이 같이 쓴다.
 * 두 화면이 서로 다른 숫자를 말하면 운영자는 어느 쪽도 믿지 않는다.
 */
export async function waitingReplies(db: PluginDb): Promise<{ reviews: number; inquiries: number }> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM shop_reviews WHERE admin_reply IS NULL AND is_visible = true) AS reviews,
      (SELECT count(*) FROM shop_inquiries WHERE admin_reply IS NULL) AS inquiries
  `);
  return { reviews: Number(rows[0]?.reviews ?? 0), inquiries: Number(rows[0]?.inquiries ?? 0) };
}

/** 주문 현황 — 단계별 건수 */
export async function orderFlowPanel(db: PluginDb, t: PluginContext["t"]): Promise<DashboardPanelData> {
  const { rows } = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')   AS pending,
      count(*) FILTER (WHERE status = 'paid')      AS paid,
      count(*) FILTER (WHERE status = 'preparing') AS preparing,
      count(*) FILTER (WHERE status = 'shipped')   AS shipped,
      -- 배송완료는 끝난 상태라 누적이 끝없이 커진다 — 최근 7일만 센다(목록은 전체로 보낸다)
      count(*) FILTER (WHERE status = 'delivered' AND delivered_at >= now() - interval '7 days') AS delivered
    FROM shop_orders
  `);
  const { rows: claims } = await db.execute(sql`
    SELECT kind, count(*) AS n FROM shop_returns WHERE status = 'requested' GROUP BY kind
  `);
  const replies = await waitingReplies(db);
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  const claim = (k: ReturnKind) => Number(claims.find((c) => c.kind === k)?.n ?? 0);
  const step = (s: OrderStatus, value: number, attention = false) => ({
    label: t(STATUS_LABEL[s]),
    value,
    link: `${ORDERS}?status=${s}`,
    tone: attention ? ("attention" as const) : ("default" as const),
  });
  return {
    kind: "steps",
    groups: [
      {
        label: t("dash.flow"),
        flow: true,
        steps: [
          // 손님이 기다리는 단계 — 입금 확인과 발송
          step("pending", n("pending"), true),
          step("paid", n("paid"), true),
          step("preparing", n("preparing"), true),
          step("shipped", n("shipped")),
          { ...step("delivered", n("delivered")), label: t("dash.deliveredWeek") },
        ],
      },
      {
        label: t("dash.claims"),
        steps: (["cancel", "return", "exchange"] as const).map((k) => ({
          label: t("dash.claimOf", { kind: t(KIND_LABEL[k]) }),
          value: claim(k),
          link: `/admin/x/brick-shop/returns?status=requested&kind=${k}`,
          tone: "attention" as const,
        })),
      },
      {
        label: t("dash.replies"),
        steps: [
          { label: t("상품 후기"), value: replies.reviews, link: "/admin/x/brick-shop/reviews?reply=waiting", tone: "attention" },
          { label: t("상품 문의"), value: replies.inquiries, link: "/admin/x/brick-shop/inquiries?reply=waiting", tone: "attention" },
        ],
      },
    ],
  };
}

/** 사이트 시간대의 날짜 하나를 n 일 옮긴다 (YYYY-MM-DD) */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 매출 추이 — 최근 14일 순매출.
 *
 * 매출의 정의(결제일 기준·사이트 시간대·환불 차감)는 판매 리포트와 **같은 함수**다.
 * 주문이 없던 날도 막대 자리를 둔다 — 빈 날을 빼면 막대 사이 간격이 날짜를 거짓말한다.
 */
export async function salesPanel(db: PluginDb, t: PluginContext["t"], days = 14): Promise<DashboardPanelData> {
  const to = siteToday(new Date());
  const from = shiftDay(to, -(days - 1));
  const report = await salesByPeriod(db, { period: { from, to }, groupBy: "day" });
  const byDay = new Map(report.buckets.map((b) => [b.bucket, b]));
  const points = Array.from({ length: days }, (_, i) => {
    const day = shiftDay(from, i);
    const b = byDay.get(day);
    return {
      label: `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`,
      value: b?.net ?? 0,
      sub: t("dash.ordersN", { n: b?.orders ?? 0 }),
    };
  });
  const today = byDay.get(to);
  return {
    kind: "chart",
    unit: "won",
    points,
    summary: [
      { label: t("dash.salesToday"), value: won(today?.net ?? 0) },
      { label: t("dash.salesDays", { n: days }), value: won(report.total.net) },
      { label: t("dash.paidOrders"), value: t("dash.ordersN", { n: report.total.orders }) },
      { label: t("dash.avgOrder"), value: won(report.total.avgOrderValue) },
    ],
  };
}

/** 최근 주문 다섯 건 */
export async function recentOrdersPanel(db: PluginDb, t: PluginContext["t"]): Promise<DashboardPanelData> {
  const { rows } = await db.execute(sql`
    SELECT o.order_no, o.orderer_name, o.total, o.status,
           to_char(o.created_at AT TIME ZONE ${SITE_TZ}, 'MM-DD HH24:MI') AS at,
           (SELECT i.product_name FROM shop_order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS first_item,
           (SELECT count(*) FROM shop_order_items i WHERE i.order_id = o.id) AS item_count
    FROM shop_orders o
    ORDER BY o.created_at DESC
    LIMIT 5
  `);
  return {
    kind: "list",
    empty: t("dash.noOrders"),
    rows: rows.map((o) => {
      const more = Number(o.item_count ?? 0) - 1;
      const item = String(o.first_item ?? "");
      return {
        title: `${String(o.orderer_name ?? "")} · ${more > 0 ? t("dash.itemAndMore", { item, n: more }) : item}`,
        meta: `${String(o.order_no)} · ${String(o.at)}`,
        value: won(Number(o.total ?? 0)),
        badge: t(STATUS_LABEL[o.status as OrderStatus] ?? String(o.status)),
        // 한 건을 여는 주소가 따로 없다 — 목록이 주소의 검색어를 읽으므로 주문번호로 좁힌다
        link: `${ORDERS}?q=${encodeURIComponent(String(o.order_no))}`,
      };
    }),
  };
}

export function registerShopDashboard(ctx: PluginContext, db: PluginDb): void {
  ctx.registerDashboardPanel({ title: "주문 현황", order: 10, link: ORDERS, load: () => orderFlowPanel(db, ctx.t) });
  ctx.registerDashboardPanel({ title: "매출 추이", order: 20, size: "half", load: () => salesPanel(db, ctx.t) });
  ctx.registerDashboardPanel({ title: "최근 주문", order: 21, size: "half", link: ORDERS, load: () => recentOrdersPanel(db, ctx.t) });
}
