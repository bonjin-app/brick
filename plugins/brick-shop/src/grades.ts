/**
 * 회원 등급 — 구매 실적에 따른 혜택.
 *
 * 역할(권한)과 별개다 (ADR-25). 등급은 할인 같은 **혜택**만 준다.
 *
 * 산정 기준은 판매 리포트와 같은 정의(ADR-51)의 최근 N개월 순매출이다 —
 * 결제 완료 금액에서 완료된 반품 환불액을 뺀다. 반품을 빼지 않으면
 * **사서 반품하기를 반복해 등급을 올릴 수 있다.**
 */
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { isUniqueViolation } from "@brick/plugin-sdk";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

export const GRADE_RECOMPUTE_JOB = "shop.grades.recompute";

/** 산정 기간(개월). 설정으로 뺄 수도 있지만, 흔들리지 않는 기본값이 먼저다 */
export const GRADE_WINDOW_MONTHS = 3;

export interface GradeInfo {
  id: string;
  name: string;
  minAmount: number;
  discountRate: number;
  description: string | null;
}

// ── 등급 CRUD ────────────────────────────────────────

export async function listGrades(db: Db): Promise<GradeInfo[]> {
  const { rows } = await db.execute(sql`
    SELECT id, name, min_amount, discount_rate, description
    FROM shop_grades ORDER BY min_amount
  `);
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    minAmount: Number(r.min_amount),
    discountRate: Number(r.discount_rate),
    description: r.description ? String(r.description) : null,
  }));
}

function validateGrade(b: Record<string, unknown>): {
  name: string; minAmount: number; discountRate: number; description: string | null;
} {
  const name = String(b.name ?? "").trim();
  if (!name) throw new ShopError(400, "등급 이름을 입력해주세요.");
  if (name.length > 50) throw new ShopError(400, "등급 이름이 너무 깁니다 (50자 이내).");

  const minAmount = Math.floor(Number(b.min_amount ?? b.minAmount ?? 0));
  if (!Number.isFinite(minAmount) || minAmount < 0) {
    throw new ShopError(400, "기준 금액은 0원 이상이어야 합니다.");
  }

  const discountRate = Number(b.discount_rate ?? b.discountRate ?? 0);
  // 50% 상한 — 그 이상은 5% 를 50% 로 적는 입력 실수일 가능성이 높고,
  // 반값 이상의 상시 할인은 등급이 아니라 가격 정책의 문제다
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 50) {
    throw new ShopError(400, "할인율은 0~50% 사이여야 합니다.");
  }

  return {
    name, minAmount,
    discountRate: Math.round(discountRate * 10) / 10,
    description: String(b.description ?? "").trim() || null,
  };
}

export async function createGrade(db: Db, body: Record<string, unknown>): Promise<{ id: string }> {
  const g = validateGrade(body);
  const id = uuidv7();
  try {
    await db.execute(sql`
      INSERT INTO shop_grades (id, name, min_amount, discount_rate, description)
      VALUES (${id}, ${g.name}, ${g.minAmount}, ${g.discountRate}, ${g.description})
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_grades_name")) {
      throw new ShopError(409, "같은 이름의 등급이 있습니다.");
    }
    if (isUniqueViolation(err, "shop_grades_min_amount")) {
      throw new ShopError(409, "같은 기준 금액의 등급이 있습니다 — 경계가 겹치면 어느 등급인지 정할 수 없습니다.");
    }
    throw err;
  }
  return { id };
}

export async function updateGrade(db: Db, id: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const g = validateGrade(body);
  try {
    const { rows } = await db.execute(sql`
      UPDATE shop_grades SET name = ${g.name}, min_amount = ${g.minAmount},
        discount_rate = ${g.discountRate}, description = ${g.description}
      WHERE id = ${id}::uuid RETURNING id
    `);
    if (!rows.length) throw new ShopError(404, "등급을 찾을 수 없습니다.");
  } catch (err) {
    if (isUniqueViolation(err, "shop_grades_name")) throw new ShopError(409, "같은 이름의 등급이 있습니다.");
    if (isUniqueViolation(err, "shop_grades_min_amount")) throw new ShopError(409, "같은 기준 금액의 등급이 있습니다.");
    throw err;
  }
  return { ok: true };
}

export async function deleteGrade(db: Db, id: string): Promise<{ ok: true }> {
  // 배정된 회원의 행은 FK CASCADE 로 함께 지워진다 — 등급 없음 = 할인 없음.
  // 다음 재계산에서 남은 등급 기준으로 다시 배정된다.
  await db.execute(sql`DELETE FROM shop_grades WHERE id = ${id}::uuid`);
  return { ok: true };
}

// ── 배정 ─────────────────────────────────────────────

/**
 * 전체 재계산.
 *
 * 최근 N개월 순매출로 각 회원의 등급을 정한다. 등급이 하나도 없으면
 * 아무것도 하지 않는다(배정 자체가 무의미하다).
 *
 * 구매가 없는 회원도 기본 등급(min_amount = 0)에 배정한다 — "등급 없음"과
 * "기본 등급"을 구분하지 않으면 마이페이지가 아무것도 보여줄 수 없다.
 */
export async function recomputeGrades(db: Db): Promise<{ assigned: number; changed: number }> {
  const { rows: grades } = await db.execute(sql`SELECT count(*) AS n FROM shop_grades`);
  if (Number(grades[0]?.n ?? 0) === 0) return { assigned: 0, changed: 0 };

  // 한 문장으로 처리한다 — 회원별 루프는 회원 수만큼 쿼리를 낸다.
  //
  // spend: 기간 내 결제된 주문의 총액 − 그 주문들에 대한 완료된 반품 환불액.
  // 반품 시점이 기간 밖이어도 뺀다 — 산 것이 기간 안이면 그 반품도 그 실적의
  // 차감이다 (사서 기간이 지난 뒤 반품하는 우회를 막는다).
  const { rows } = await db.execute(sql`
    WITH spend AS (
      SELECT o.user_id,
             sum(o.total) - coalesce(sum(r.refunded), 0) AS amount
      FROM shop_orders o
      LEFT JOIN (
        SELECT order_id, sum(refund_amount) AS refunded
        FROM shop_returns WHERE status = 'completed' GROUP BY order_id
      ) r ON r.order_id = o.id
      WHERE o.user_id IS NOT NULL
        AND o.paid_at IS NOT NULL
        AND o.paid_at >= now() - (${GRADE_WINDOW_MONTHS} || ' months')::interval
      GROUP BY o.user_id
    ),
    -- 모든 활성 회원 (구매가 없어도 기본 등급을 받는다)
    members AS (
      SELECT u.id AS user_id, greatest(coalesce(s.amount, 0), 0) AS amount
      FROM users u
      LEFT JOIN spend s ON s.user_id = u.id
      WHERE u.is_active = true AND u.withdrawn_at IS NULL
    ),
    -- 금액이 닿는 가장 높은 등급 하나
    target AS (
      SELECT m.user_id, m.amount,
             (SELECT g.id FROM shop_grades g
              WHERE g.min_amount <= m.amount
              ORDER BY g.min_amount DESC LIMIT 1) AS grade_id
      FROM members m
    )
    INSERT INTO shop_user_grades (user_id, grade_id, base_amount, computed_at)
    SELECT user_id, grade_id, amount, now() FROM target WHERE grade_id IS NOT NULL
    ON CONFLICT (user_id) DO UPDATE
      SET grade_id = excluded.grade_id,
          base_amount = excluded.base_amount,
          computed_at = now()
      -- 바뀐 것만 갱신하면 xmax 로 변경 수를 셀 수 없으므로 전부 갱신한다.
      -- 하루 한 번이라 비용이 문제되지 않는다.
    RETURNING (xmax = 0) AS inserted
  `);

  return {
    assigned: rows.length,
    changed: rows.filter((r) => r.inserted === true).length,
  };
}

/**
 * 회원의 현재 등급 — 견적(quote)이 호출자에게서 받는 값.
 *
 * pricing 은 회원 테이블을 모른다(관심사 분리 — 포인트와 같은 구조).
 * 라우트가 이 함수로 등급을 읽어 quote 옵션으로 넘긴다.
 */
export async function gradeOf(
  db: Db,
  userId: string | null,
): Promise<{ name: string; discountRate: number } | null> {
  if (!userId) return null; // 비회원에게는 등급 혜택이 없다
  const { rows } = await db.execute(sql`
    SELECT g.name, g.discount_rate
    FROM shop_user_grades ug
    JOIN shop_grades g ON g.id = ug.grade_id
    WHERE ug.user_id = ${userId}::uuid
    LIMIT 1
  `);
  if (!rows[0]) return null;
  const rate = Number(rows[0].discount_rate);
  return rate > 0
    ? { name: String(rows[0].name), discountRate: rate }
    // 할인 0% 등급이어도 이름은 화면에 필요하다 — 견적에는 영향이 없다
    : { name: String(rows[0].name), discountRate: 0 };
}

/**
 * 마이페이지용 — 내 등급과 다음 등급까지 남은 금액.
 *
 * "₩30,000 더 구매하면 GOLD" 가 이 기능의 존재 이유다. 등급만 보여주면
 * 아무 행동도 유도하지 않는다.
 */
export async function myGrade(db: Db, userId: string) {
  const { rows } = await db.execute(sql`
    SELECT g.name, g.discount_rate, g.description, ug.base_amount, ug.computed_at
    FROM shop_user_grades ug
    JOIN shop_grades g ON g.id = ug.grade_id
    WHERE ug.user_id = ${userId}::uuid LIMIT 1
  `);
  const current = rows[0] ?? null;
  const baseAmount = current ? Number(current.base_amount) : 0;

  const { rows: next } = await db.execute(sql`
    SELECT name, min_amount FROM shop_grades
    WHERE min_amount > ${baseAmount}
    ORDER BY min_amount LIMIT 1
  `);

  return {
    grade: current
      ? {
          name: String(current.name),
          discountRate: Number(current.discount_rate),
          description: current.description ? String(current.description) : null,
        }
      : null,
    /** 산정에 쓰인 금액 — "왜 이 등급인가" */
    baseAmount,
    windowMonths: GRADE_WINDOW_MONTHS,
    computedAt: current?.computed_at ?? null,
    nextGrade: next[0]
      ? {
          name: String(next[0].name),
          minAmount: Number(next[0].min_amount),
          remaining: Number(next[0].min_amount) - baseAmount,
        }
      : null,
  };
}

/** 탈퇴 시 삭제 — registerDataEraser 가 부른다 */
export async function eraseGrade(tx: Db, userId: string): Promise<string[]> {
  const { rows } = await tx.execute(sql`
    DELETE FROM shop_user_grades WHERE user_id = ${userId}::uuid RETURNING user_id
  `);
  return rows.length ? ["회원 등급 배정 삭제"] : [];
}
