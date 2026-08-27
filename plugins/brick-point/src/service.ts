import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { PluginDb } from "@brick/plugin-sdk";

/**
 * 포인트 서비스 — 다른 플러그인이 `ctx.useService("points")` 로 가져다 쓴다.
 *
 * 모든 쓰기 메서드가 `tx`(트랜잭션 핸들)를 받는다.
 * 쇼핑몰이 "주문 생성 + 포인트 차감"을 원자적으로 처리해야 하기 때문이다 —
 * 하나만 성공하면 잔액이 어긋난다.
 */
export interface PointsService {
  readonly version: 1;
  /** 사용 가능한 잔액 (만료되지 않은 적립의 합) */
  balance(userId: string, tx?: PluginDb): Promise<number>;
  /**
   * 적립. 같은 (kind, refType, refId)로 이미 적립되었으면 아무 일도 하지 않는다(멱등).
   * @returns 실제로 적립되었는지
   */
  grant(params: GrantParams, tx?: PluginDb): Promise<boolean>;
  /**
   * 사용. 잔액이 부족하면 **false를 반환하고 아무것도 바꾸지 않는다.**
   * (예외를 던지지 않는 이유: 호출자가 "포인트 없이 계속"을 선택할 수 있어야 한다)
   */
  spend(params: SpendParams, tx?: PluginDb): Promise<boolean>;
  /**
   * 사용 취소 — 주문 취소·환불 시. 사용한 만큼 새로 적립한다.
   * 같은 참조로 이미 취소했으면 아무 일도 하지 않는다(멱등).
   */
  refund(params: { userId: string; refType: string; refId: string; reason: string }, tx?: PluginDb): Promise<number>;
  /** 적립 예정액 계산 (주문서에 "구매 시 N점 적립" 표시용) */
  previewEarn(amount: number): Promise<number>;
}

export interface GrantParams {
  userId: string;
  amount: number;
  reason: string;
  refType?: string;
  refId?: string;
  /** 유효기간(일). 미지정 시 설정값, 0이면 무기한 */
  expireDays?: number;
  actorId?: string | null;
}

export interface SpendParams {
  userId: string;
  amount: number;
  reason: string;
  refType?: string;
  refId?: string;
  actorId?: string | null;
}

export interface PointSettings {
  /** 적립 유효기간(일). 0이면 무기한 */
  expireDays: number;
  /** 회원가입 적립 */
  signupPoint: number;
  /** 게시글 작성 적립 */
  postPoint: number;
  /** 댓글 작성 적립 */
  commentPoint: number;
  /** 상품 후기 작성 적립 — 구매 검증을 통과한 후기만 대상이다 */
  reviewPoint: number;
  /** 로그인 적립 (1일 1회) */
  loginPoint: number;
  /** 구매 적립률(%) — 결제 완료 시 결제금액의 이 비율만큼 적립 */
  purchaseRate: number;
  /** 주문 시 사용 가능한 최대 비율(%) — 100이면 전액 사용 가능 */
  maxUseRate: number;
  /** 한 번에 사용할 수 있는 최소 포인트 */
  minUse: number;
}

export const DEFAULT_SETTINGS: PointSettings = {
  expireDays: 365,
  signupPoint: 1000,
  postPoint: 10,
  commentPoint: 5,
  reviewPoint: 100,
  loginPoint: 0,
  purchaseRate: 1,
  maxUseRate: 50,
  minUse: 100,
};

/** 중복 키 위반인지 (멱등 처리에 쓴다) */
function isDuplicate(err: unknown): boolean {
  const s = String(err);
  return s.includes("point_ledger_once_idx") || s.includes("duplicate key");
}

export function createPointsService(
  db: PluginDb,
  loadSettings: () => Promise<PointSettings>,
): PointsService {
  /** tx가 주어지면 그 트랜잭션에서, 없으면 새로 연다 */
  async function run<T>(tx: PluginDb | undefined, fn: (h: PluginDb) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : db.transaction(fn);
  }

  async function balanceOn(handle: PluginDb, userId: string): Promise<number> {
    const { rows } = await handle.execute(sql`
      SELECT coalesce(sum(remaining), 0) AS total
      FROM point_ledger
      WHERE user_id = ${userId}::uuid AND amount > 0 AND remaining > 0
        AND (expires_at IS NULL OR expires_at > now())
    `);
    return Number(rows[0]?.total ?? 0);
  }

  return {
    version: 1,

    async balance(userId, tx) {
      return balanceOn(tx ?? db, userId);
    },

    async grant(params, tx) {
      const amount = Math.floor(Number(params.amount));
      if (!Number.isFinite(amount) || amount <= 0) return false;

      const settings = await loadSettings();
      const days = params.expireDays ?? settings.expireDays;
      const expiresAt = days > 0 ? sql`now() + (${days} || ' days')::interval` : sql`NULL`;

      try {
        await (tx ?? db).execute(sql`
          INSERT INTO point_ledger
            (id, user_id, amount, remaining, kind, reason, ref_type, ref_id, expires_at, actor_id)
          VALUES
            (${uuidv7()}, ${params.userId}::uuid, ${amount}, ${amount}, 'earn',
             ${params.reason.slice(0, 200)}, ${params.refType ?? null}, ${params.refId ?? null},
             ${expiresAt}, ${params.actorId ?? null}::uuid)
        `);
        return true;
      } catch (err) {
        // 같은 원인으로 이미 적립됨 — 훅 재실행이나 웹훅 재전송에서 정상적인 상황이다
        if (isDuplicate(err)) return false;
        throw err;
      }
    },

    async spend(params, tx) {
      const amount = Math.floor(Number(params.amount));
      if (!Number.isFinite(amount) || amount <= 0) return false;

      return run(tx, async (h) => {
        /**
         * FIFO 소비 — 만료가 임박한 것부터 쓴다.
         *
         * FOR UPDATE로 적립 행을 잠근다. 잠그지 않으면 동시 사용에서
         * 같은 포인트를 두 번 쓸 수 있다(잔액 초과 사용).
         */
        const { rows: grants } = await h.execute(sql`
          SELECT id, remaining FROM point_ledger
          WHERE user_id = ${params.userId}::uuid AND amount > 0 AND remaining > 0
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY expires_at ASC NULLS LAST, created_at ASC
          FOR UPDATE
        `);

        const available = grants.reduce((sum, g) => sum + Number(g.remaining), 0);
        if (available < amount) return false; // 잔액 부족 — 아무것도 바꾸지 않는다

        let left = amount;
        for (const g of grants) {
          if (left <= 0) break;
          const take = Math.min(left, Number(g.remaining));
          await h.execute(sql`
            UPDATE point_ledger SET remaining = remaining - ${take} WHERE id = ${String(g.id)}::uuid
          `);
          left -= take;
        }

        try {
          await h.execute(sql`
            INSERT INTO point_ledger
              (id, user_id, amount, remaining, kind, reason, ref_type, ref_id, actor_id)
            VALUES
              (${uuidv7()}, ${params.userId}::uuid, ${-amount}, 0, 'spend',
               ${params.reason.slice(0, 200)}, ${params.refType ?? null}, ${params.refId ?? null},
               ${params.actorId ?? null}::uuid)
          `);
        } catch (err) {
          // 같은 참조로 이미 사용 기록이 있으면 트랜잭션을 되돌린다.
          // (호출자가 재시도한 경우 — 이중 차감을 막는다)
          if (isDuplicate(err)) throw new Error("이미 처리된 포인트 사용입니다.");
          throw err;
        }
        return true;
      });
    },

    async refund(params, tx) {
      return run(tx, async (h) => {
        // 사용 기록을 찾는다
        const { rows } = await h.execute(sql`
          SELECT amount FROM point_ledger
          WHERE user_id = ${params.userId}::uuid AND kind = 'spend'
            AND ref_type = ${params.refType} AND ref_id = ${params.refId}
          LIMIT 1
        `);
        if (!rows[0]) return 0;
        const spent = Math.abs(Number(rows[0].amount));
        if (spent <= 0) return 0;

        const settings = await loadSettings();
        const days = settings.expireDays;
        const expiresAt = days > 0 ? sql`now() + (${days} || ' days')::interval` : sql`NULL`;

        try {
          await h.execute(sql`
            INSERT INTO point_ledger
              (id, user_id, amount, remaining, kind, reason, ref_type, ref_id, expires_at)
            VALUES
              (${uuidv7()}, ${params.userId}::uuid, ${spent}, ${spent}, 'refund',
               ${params.reason.slice(0, 200)}, ${params.refType}, ${params.refId}, ${expiresAt})
          `);
        } catch (err) {
          // 이미 환급했다 — 멱등
          if (isDuplicate(err)) return 0;
          throw err;
        }
        return spent;
      });
    },

    async previewEarn(amount) {
      const settings = await loadSettings();
      return Math.floor((Number(amount) * settings.purchaseRate) / 100);
    },
  };
}

/**
 * 만료 처리.
 *
 * remaining 이 남아 있는데 유효기간이 지난 적립을 0으로 만들고 만료 기록을 남긴다.
 * 잔액 계산은 이미 expires_at 을 보므로 만료 처리를 하지 않아도 잔액은 정확하다 —
 * 이 작업은 **사용자에게 만료 내역을 보여주기 위한** 것이다.
 */
export async function expirePoints(db: PluginDb): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      SELECT id, user_id, remaining FROM point_ledger
      WHERE amount > 0 AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY expires_at
      LIMIT 500
      FOR UPDATE
    `);
    let total = 0;
    for (const row of rows) {
      const amount = Number(row.remaining);
      await tx.execute(sql`UPDATE point_ledger SET remaining = 0 WHERE id = ${String(row.id)}::uuid`);
      await tx.execute(sql`
        INSERT INTO point_ledger (id, user_id, amount, remaining, kind, reason, ref_type, ref_id)
        VALUES (${uuidv7()}, ${String(row.user_id)}::uuid, ${-amount}, 0, 'expire',
                '유효기간 만료', 'point.expire', ${String(row.id)})
      `);
      total += amount;
    }
    return total;
  });
}
