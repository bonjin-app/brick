/**
 * 생일 쿠폰 자동 지급.
 *
 * 생일 쿠폰 = 발급형 쿠폰 + birthday_auto. 스윕이 "오늘(사이트 시간대)이
 * 생일인 회원"에게 쿠폰함 지급을 한다. 지급은 멱등하다 — 같은 쿠폰은
 * 회원당 평생 1회(unique 인덱스)이고, 스윕이 하루에 몇 번 돌아도 두 장이
 * 가지 않는다. 매년 주려면 해마다 쿠폰을 새로 만든다(ADR-69 재지급 규칙).
 *
 * 2월 29일 생일: 평년에는 2월 28일에 지급한다 — 4년에 한 번만 혜택을
 * 받는 회원을 만들지 않는다.
 *
 * 메일은 보내지 않는다. 쿠폰함에 담기는 것은 발송이 아니고, 생일 축하
 * 메일은 광고성 정보라 수신 동의·(광고) 표기 문제가 함께 온다 — 원하면
 * 단체메일(수신 동의자 대상)로 따로 보낸다.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./types.js";

export const BIRTHDAY_QUEUE_JOB = "shop.coupon.birthday";

export async function issueBirthdayCoupons(
  db: Db,
  timezone = "Asia/Seoul",
): Promise<{ coupons: number; issued: number }> {
  const { rows: coupons } = await db.execute(sql`
    SELECT id FROM shop_coupons
    WHERE birthday_auto = true AND requires_issue = true AND is_active = true
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at IS NULL OR ends_at >= now())
  `);
  if (!coupons.length) return { coupons: 0, issued: 0 };

  let issued = 0;
  for (const c of coupons) {
    // 오늘(사이트 시간대) 월·일 매칭. 평년 2/28 에는 2/29 생일자도 포함.
    const { rows } = await db.execute(sql`
      WITH today AS (
        SELECT EXTRACT(MONTH FROM now() AT TIME ZONE ${timezone})::int AS m,
               EXTRACT(DAY   FROM now() AT TIME ZONE ${timezone})::int AS d,
               (EXTRACT(YEAR FROM now() AT TIME ZONE ${timezone})::int % 4 = 0
                AND (EXTRACT(YEAR FROM now() AT TIME ZONE ${timezone})::int % 100 <> 0
                     OR EXTRACT(YEAR FROM now() AT TIME ZONE ${timezone})::int % 400 = 0)) AS leap
      )
      INSERT INTO shop_user_coupons (id, coupon_id, user_id)
      SELECT gen_random_uuid(), ${String(c.id)}::uuid, u.id
      FROM users u, today t
      WHERE u.is_active = true
        AND u.birth_month IS NOT NULL AND u.birth_day IS NOT NULL
        AND (
          (u.birth_month = t.m AND u.birth_day = t.d)
          OR (t.m = 2 AND t.d = 28 AND NOT t.leap AND u.birth_month = 2 AND u.birth_day = 29)
        )
      ON CONFLICT (coupon_id, user_id) DO NOTHING
      RETURNING id
    `);
    issued += rows.length;
  }
  return { coupons: coupons.length, issued };
}
