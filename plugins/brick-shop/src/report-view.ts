/**
 * 관리자 → 통계 → 매출 통계 화면이 부르는 것 (`kind: "report"` 의 응답).
 *
 * 판매 리포트 API(기간별·상품별·분류별·요약, CSV)는 처음부터 있었는데 **그것을 그리는 화면이
 * 없었다** — 운영자는 "이번 달 얼마 팔았나" 를 curl 없이는 볼 수 없었다. 여기서는 새로 세지
 * 않는다: 매출의 정의(결제일 기준 · 사이트 시간대 · 환불 차감)는 reports.ts 의 함수 하나이고,
 * 이 파일은 그 결과를 화면 모양(요약 · 막대 · 표)으로 옮겨 담기만 한다.
 */
import type { AdminReport, PluginContext, PluginDb } from "@brick/plugin-sdk";
import {
  parseGroupBy, parsePeriod, salesByCategory, salesByPeriod, salesByProduct, salesSummary, type Period,
} from "./reports.js";
import { won } from "./types.js";

type T = PluginContext["t"];

/** 막대에 날짜 칸을 빠짐없이 둘 상한 — 그보다 길면 리포트가 준 칸만 그린다 */
const FILL_DAYS_MAX = 92;

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 같은 쿼리로 CSV 를 받는 경로 — 화면이 내려받기 단추로 쓴다 */
function csvPath(route: string, period: Period, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams({ from: period.from, to: period.to, ...extra, format: "csv" });
  return `${route}?${qs.toString()}`;
}

export async function buildReport(db: PluginDb, query: Record<string, unknown>, t: T): Promise<AdminReport> {
  const period = parsePeriod(query);
  const view = String(query.view ?? "sales");

  // 요약은 보기와 상관없이 같다 — 직전 같은 길이의 기간과 견준다
  const s = await salesSummary(db, { period });
  const summary: AdminReport["summary"] = [
    { label: t("순매출"), value: won(s.current.net), delta: s.change.net },
    { label: t("주문수"), value: t("dash.ordersN", { n: s.current.orders }), delta: s.change.orders },
    { label: t("평균 주문금액"), value: won(s.current.avgOrderValue), delta: s.change.avgOrderValue },
    // 환불은 견주지 않는다 — delta 를 빼야 "직전 기간 없음" 이라는 거짓 문구가 붙지 않는다(null 은 "직전이 0")
    { label: t("환불"), value: won(s.current.refunded) },
  ];
  const note = t("report.basis");

  if (view === "products") {
    const r = await salesByProduct(db, { period, sort: String(query.sort ?? "net"), limit: 50 });
    return {
      summary, note,
      csv: csvPath("/admin/reports/products", period),
      columns: [
        { name: "name", label: t("상품명") },
        { name: "category", label: t("분류") },
        { name: "qty", label: t("판매수량"), type: "number" },
        { name: "orders", label: t("주문수"), type: "number" },
        { name: "refunded", label: t("환불"), type: "money" },
        { name: "net", label: t("순매출"), type: "money" },
      ],
      rows: r.products.map((p) => ({
        name: p.productName, category: p.categoryName ?? "-", qty: p.qty, orders: p.orders, refunded: p.refunded, net: p.net,
      })),
    };
  }

  if (view === "categories") {
    const r = await salesByCategory(db, { period, rollup: String(query.rollup ?? "") === "true" });
    return {
      summary, note,
      csv: csvPath("/admin/reports/categories", period),
      columns: [
        { name: "category", label: t("분류") },
        { name: "qty", label: t("판매수량"), type: "number" },
        { name: "orders", label: t("주문수"), type: "number" },
        { name: "refunded", label: t("환불"), type: "money" },
        { name: "net", label: t("순매출"), type: "money" },
      ],
      rows: r.categories.map((c) => ({ category: c.categoryName, qty: c.qty, orders: c.orders, refunded: c.refunded, net: c.net })),
    };
  }

  // 기간별 (기본)
  const groupBy = parseGroupBy(query.groupBy);
  const r = await salesByPeriod(db, { period, groupBy });
  /*
   * 일별 막대는 주문이 없던 날도 자리를 둔다 — 빈 날을 빼면 막대 사이 간격이 날짜를 거짓말한다.
   * 표는 리포트가 준 칸만 싣는다(0 원짜리 줄 서른 개는 읽을 것이 없다).
   */
  const days = (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86400_000 + 1;
  const byBucket = new Map(r.buckets.map((b) => [b.bucket, b]));
  const chartBuckets = groupBy === "day" && days <= FILL_DAYS_MAX
    ? Array.from({ length: days }, (_, i) => {
        const day = shiftDay(period.from, i);
        return { bucket: day, net: byBucket.get(day)?.net ?? 0, orders: byBucket.get(day)?.orders ?? 0 };
      })
    : r.buckets.map((b) => ({ bucket: b.bucket, net: b.net, orders: b.orders }));
  const short = (bucket: string) =>
    groupBy === "month" ? `${Number(bucket.slice(0, 4))}.${Number(bucket.slice(5, 7))}` : `${Number(bucket.slice(5, 7))}/${Number(bucket.slice(8, 10))}`;
  return {
    summary, note,
    csv: csvPath("/admin/reports/sales", period, { groupBy }),
    chart: {
      unit: "won",
      points: chartBuckets.map((b) => ({ label: short(b.bucket), value: b.net, sub: t("dash.ordersN", { n: b.orders }) })),
    },
    columns: [
      { name: "bucket", label: t("기간") },
      { name: "orders", label: t("주문수"), type: "number" },
      { name: "gross", label: t("총매출"), type: "money" },
      { name: "discount", label: t("할인"), type: "money" },
      { name: "shipping", label: t("배송비"), type: "money" },
      { name: "refunded", label: t("환불"), type: "money" },
      { name: "net", label: t("순매출"), type: "money" },
    ],
    rows: r.buckets.slice().reverse().map((b) => ({
      bucket: b.bucket, orders: b.orders, gross: b.gross, discount: b.discount, shipping: b.shipping, refunded: b.refunded, net: b.net,
    })),
  };
}
