import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { SITE_TZ } from "@brick/plugin-sdk";
import type { Db } from "./types.js";

/**
 * "오늘"(사이트 시간대)의 SQL 조각.
 *
 * 날짜는 반드시 DB 안에서 계산한다 — JS 시간으로 만들어 넣으면 서버와
 * DB 의 시계가 다를 때 자정 무렵 같은 사람이 두 번 세어진다. 다만 하루의
 * 경계는 DB 세션 시간대(current_date)가 아니라 **사이트 시간대**다 —
 * UTC PostgreSQL 배포에서 current_date 를 쓰면 '오늘 방문자'만 오전
 * 9시에 리셋되어, 대시보드의 다른 카드('오늘 주문'·'오늘 글')와 한 화면
 * 안에서 "오늘"의 정의가 갈라진다.
 */
const TODAY = sql`(now() AT TIME ZONE ${SITE_TZ})::date`;

/**
 * 방문자 집계.
 *
 * 그누보드의 접속자 집계(오늘·어제·최대·전체)를 대체한다.
 *
 * 설계상 중요한 두 가지:
 *
 * 1) **IP를 저장하지 않는다.** 같은 사람인지 판별하는 데 필요한 것은 동일성이지
 *    실제 주소가 아니다. 설치마다 다른 소금(salt)을 섞어 해시하므로, DB가
 *    유출되어도 접속자 IP 목록이 되지 않고 다른 설치본과 대조할 수도 없다.
 *    지역/대역 통계를 위해 앞 두 옥텟만(a.b.*) 따로 남긴다.
 *
 * 2) **원본은 하루치만 남긴다.** 화면에 보이는 것은 일별 합계뿐인데 원본이
 *    영구히 쌓이면 몇 년 뒤 가장 큰 테이블이 된다. 날짜가 바뀌면 정리한다.
 */

/** 설치마다 다른 소금 — 없으면 만들어 저장한다 */
export async function visitorSalt(settings: {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}): Promise<string> {
  const existing = await settings.get<string>("visitorSalt");
  if (existing) return existing;
  const salt = randomBytes(16).toString("hex");
  await settings.set("visitorSalt", salt);
  return salt;
}

/**
 * 같은 방문자를 식별하는 키.
 *
 * 날짜를 섞지 않는다 — 날짜 구분은 유니크 인덱스의 `visit_day` 가 하고,
 * 그 값은 DB 안에서 계산한 사이트 시간대의 오늘(TODAY)이다. JS 시간으로 만들면
 * 서버와 DB의 시간대가 다를 때 자정 무렵에 같은 사람이 두 번 세어진다.
 *
 * UA를 섞는 이유: 사무실·학교처럼 한 IP 뒤에 여러 사람이 있는 환경에서
 * 방문자가 1명으로 합쳐지는 것을 줄인다. 완벽하지 않지만 그누보드도 IP만 본다.
 */
export function visitorKey(salt: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex").slice(0, 64);
}

/** IP를 대역 수준으로 축약 — 지역 통계용, 개인 식별에는 쓸 수 없다 */
export function ipPrefix(ip: string): string {
  if (ip.includes(":")) {
    // IPv6은 앞 두 그룹만
    const parts = ip.split(":");
    return `${parts[0]}:${parts[1] ?? ""}:*`;
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.*` : "*";
}

/** 모바일 판별 — 통계 구분용이므로 대략적이면 충분하다 */
export function isMobileAgent(userAgent: string): boolean {
  return /Mobile|Android|iPhone|iPad|iPod|Windows Phone/i.test(userAgent);
}

function refererHost(referer: string): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).host.slice(0, 200) || null;
  } catch {
    return null;
  }
}

/**
 * 방문 1건 기록.
 *
 * 같은 방문자의 두 번째 요청은 유니크 인덱스가 막고, 그때는 일별 합계도
 * 건드리지 않는다 — 그래서 재방문 비용이 INSERT 한 번으로 끝난다.
 *
 * @returns 새 방문으로 집계되었는지
 */
export async function recordVisit(
  db: Db,
  params: {
    salt: string;
    ip: string;
    userAgent: string;
    referer: string;
    userId: string | null;
  },
): Promise<boolean> {
  const key = visitorKey(params.salt, params.ip, params.userAgent);
  const mobile = isMobileAgent(params.userAgent);

  const { rows } = await db.execute(sql`
    INSERT INTO site_visits
      (id, visit_day, visitor_key, ip_prefix, referer_host, user_agent, is_mobile, user_id)
    VALUES
      (${uuidv7()}, ${TODAY}, ${key}, ${ipPrefix(params.ip)},
       ${refererHost(params.referer)}, ${params.userAgent.slice(0, 300)}, ${mobile},
       ${params.userId})
    ON CONFLICT (visit_day, visitor_key) DO NOTHING
    RETURNING id
  `);
  if (!rows.length) return false;

  await db.execute(sql`
    INSERT INTO site_visit_daily (visit_day, total, members, mobile)
    VALUES (${TODAY}, 1, ${params.userId ? 1 : 0}, ${mobile ? 1 : 0})
    ON CONFLICT (visit_day) DO UPDATE SET
      total = site_visit_daily.total + 1,
      members = site_visit_daily.members + ${params.userId ? 1 : 0},
      mobile = site_visit_daily.mobile + ${mobile ? 1 : 0},
      updated_at = now()
  `);
  return true;
}

/**
 * 오래된 방문 원본 정리.
 *
 * 방문이 기록될 때 곧바로(같은 요청에서) 부르지 않는다 — 방문마다 DELETE를
 * 시도하면 아무 소득 없는 스캔이 계속 붙는다. 날짜가 바뀐 것을 감지한
 * 첫 방문에서만 한 번 돈다.
 */
export async function pruneVisits(db: Db, keepDailyDays: number): Promise<void> {
  await db.execute(sql`DELETE FROM site_visits WHERE visit_day < ${TODAY}`);
  if (keepDailyDays > 0) {
    await db.execute(sql`
      DELETE FROM site_visit_daily
      WHERE visit_day < ${TODAY} - ${keepDailyDays}::integer
    `);
  }
}

/** 그누보드식 집계 — 오늘 / 어제 / 이번 달 / 최고 / 전체 */
export async function visitStats(db: Db) {
  const [summary, best, recent] = await Promise.all([
    db.execute(sql`
      SELECT
        coalesce(sum(total) FILTER (WHERE visit_day = ${TODAY}), 0)            AS today,
        coalesce(sum(total) FILTER (WHERE visit_day = ${TODAY} - 1), 0)        AS yesterday,
        coalesce(sum(total) FILTER (WHERE visit_day >= date_trunc('month', ${TODAY})), 0) AS this_month,
        coalesce(sum(total), 0)                                                    AS total,
        coalesce(sum(members) FILTER (WHERE visit_day = ${TODAY}), 0)          AS today_members,
        coalesce(sum(mobile)  FILTER (WHERE visit_day = ${TODAY}), 0)          AS today_mobile
      FROM site_visit_daily
    `).then((r) => r.rows[0] ?? {}),
    db.execute(sql`
      SELECT visit_day, total FROM site_visit_daily ORDER BY total DESC, visit_day DESC LIMIT 1
    `).then((r) => r.rows[0] ?? null),
    db.execute(sql`
      SELECT visit_day, total, members, mobile FROM site_visit_daily
      WHERE visit_day >= ${TODAY} - 29 ORDER BY visit_day
    `).then((r) => r.rows),
  ]);

  const num = (v: unknown) => Number(v ?? 0);
  return {
    today: num(summary.today),
    yesterday: num(summary.yesterday),
    thisMonth: num(summary.this_month),
    total: num(summary.total),
    todayMembers: num(summary.today_members),
    todayMobile: num(summary.today_mobile),
    best: best ? { day: best.visit_day, total: num(best.total) } : null,
    daily: recent,
  };
}

/** 유입 경로 — 어디서 왔는지 (오늘) */
export async function todayReferers(db: Db) {
  const { rows } = await db.execute(sql`
    SELECT referer_host, count(*) AS n FROM site_visits
    WHERE visit_day = ${TODAY} AND referer_host IS NOT NULL
    GROUP BY referer_host ORDER BY n DESC LIMIT 20
  `);
  return rows;
}

/** 정리 작업을 하루 한 번만 돌리기 위한 날짜 표식 (DB 날짜와 정확히 같지 않아도 무해하다) */
export function localDayTag(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
