"use client";

import { useAdminT } from "../../../../lib/i18n-admin";
import { useLocaleTag } from "../../../../lib/i18n";

/** 막대 하나 = 한 칸 (예: 하루). 대시보드 판과 매출 통계가 같은 모양을 쓴다 */
export interface BarPoint { label: string; value: number; sub?: string }

/**
 * 막대 — 라이브러리 없이 CSS 높이로 그린다(관리 화면에 차트 꾸러미를 들이지 않는다).
 * 값은 막대의 title 과 숨긴 글자로도 읽힌다 — 막대 길이만으로는 화면 낭독기가 아무것도 모른다.
 * 칸이 많으면(한 달 일별) 이름표를 건너뛰며 단다 — 서른 개를 다 달면 겹쳐서 하나도 못 읽는다.
 */
export function BarChart({ unit, points }: { unit: "won" | "count"; points: BarPoint[] }) {
  const t = useAdminT();
  const localeTag = useLocaleTag();
  const fmt = (v: number) => unit === "won"
    ? new Intl.NumberFormat(localeTag, { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(v)
    : v.toLocaleString(localeTag);
  const compact = (v: number) => unit === "won"
    ? new Intl.NumberFormat(localeTag, { style: "currency", currency: "KRW", notation: "compact", maximumFractionDigits: 1 }).format(v)
    : v.toLocaleString(localeTag);
  const max = Math.max(0, ...points.map((x) => x.value));
  // 이름표 간격 — 열 개 남짓만 단다. 마지막 칸(오늘)은 늘 단다
  const every = Math.max(1, Math.ceil(points.length / 10));
  return (
    <>
      <div className="brick-chart" role="list">
        <span className="brick-chart-max" aria-hidden="true">{max > 0 ? compact(max) : ""}</span>
        {points.map((x, i) => {
          const labelled = (points.length - 1 - i) % every === 0;
          return (
            <div key={i} className="brick-bar" role="listitem" title={`${x.label} · ${fmt(x.value)}${x.sub ? ` · ${x.sub}` : ""}`}>
              <span className="brick-bar-fill" style={{ height: max > 0 ? `${Math.max(2, (x.value / max) * 100)}%` : "2px" }} />
              {labelled ? <span className="brick-bar-label" aria-hidden="true">{x.label}</span> : null}
              <span className="sr-only">{x.label} {fmt(x.value)}{x.sub ? `, ${x.sub}` : ""}</span>
            </div>
          );
        })}
      </div>
      {max === 0 ? <p className="brick-panel-empty" style={{ marginTop: 8 }}>{t("dash.chartEmpty")}</p> : null}
    </>
  );
}
