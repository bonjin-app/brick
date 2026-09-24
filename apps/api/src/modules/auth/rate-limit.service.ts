import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * 요청 제한 — PostgreSQL 에 센다(창은 미끄러지는 창이다).
 *
 * 전에는 서버 메모리에 셌다. 그래서 두 가지가 한도를 무너뜨렸다:
 *   - 서버를 여러 대로 늘리면 **대수만큼** 한도가 늘었다(계정당 5회가 둘이면 10회).
 *   - 배포로 재시작할 때마다 **모든 잠금이 풀렸다.**
 * 운영 문서에 "알려진 한계" 로 적혀 있던 것이다. 두 서버에 번갈아 틀리게 하면 여섯 번째도
 * 통과했고, 재시작하면 막혔던 계정이 다시 열렸다.
 *
 * 메모리 판에는 버그도 하나 있었다: 오래된 기록 정리가 **호출한 쪽의 시간 창**으로 모든
 * 버킷을 판단해서, 15분 창의 로그인이 60분 창인 "비밀번호 재설정 제출" 한도를 21분 만에
 * 풀었다. 여기서는 질의마다 자기 창으로 세므로 그런 일이 구조적으로 없다.
 *
 * 비용: 제한이 걸린 요청마다 트랜잭션 하나. 로그인·재설정·비회원 비밀번호처럼 드문 경로에만
 * 쓴다. 대입이 쏟아질 때 DB 가 같이 두들겨 맞지 않도록, **막힌 키는 이 서버가 기억해 두고**
 * 그동안은 DB 에 묻지 않는다 — 막힘은 클러스터 전체에서 참이므로 안전한 쪽으로 틀린다.
 */
@Injectable()
export class RateLimitService {
  /** 이 서버가 알고 있는 "언제까지 막힘" — 대입이 쏟아질 때 DB 를 지킨다 */
  private readonly blockedUntil = new Map<string, number>();

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  /**
   * 한 번 세고 허용 여부를 돌려준다. **원자적이다** — 키마다 advisory lock 을 잡고
   * 세고 넣으므로, 동시에 쏟아진 요청도 정확히 한도만큼만 허용된다. 막히면 세지 않는다.
   */
  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const known = this.blockedUntil.get(key);
    if (known && known > Date.now()) {
      return { allowed: false, retryAfterSeconds: Math.ceil((known - Date.now()) / 1000) };
    }
    const w = window(windowMs);
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rl:${key}`}, 0))`);
      const verdict = await over(tx, key, limit, w);
      if (verdict) {
        this.blockedUntil.set(key, Date.now() + verdict.retryAfterSeconds * 1000);
        return verdict;
      }
      await tx.execute(sql`INSERT INTO rate_limit_hits (key) VALUES (${key})`);
      return { allowed: true, retryAfterSeconds: 0 };
    });
  }

  /** 세지 않고 막혔는지만 본다 */
  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    return (await over(this.db, key, limit, window(windowMs))) ?? { allowed: true, retryAfterSeconds: 0 };
  }

  /** 한 번 센다 (허용 여부와 무관하게) */
  async hit(key: string, _windowMs: number): Promise<void> {
    await this.db.execute(sql`INSERT INTO rate_limit_hits (key) VALUES (${key})`);
  }

  /** 가장 최근의 한 번을 되돌린다 — 먼저 세고 나중에 성공으로 판명된 시도에 쓴다 */
  async undo(key: string): Promise<void> {
    this.blockedUntil.delete(key);
    await this.db.execute(sql`
      DELETE FROM rate_limit_hits WHERE id = (
        SELECT id FROM rate_limit_hits WHERE key = ${key} ORDER BY hit_at DESC, id DESC LIMIT 1
      )
    `);
  }

  async reset(key: string): Promise<void> {
    this.blockedUntil.delete(key);
    await this.db.execute(sql`DELETE FROM rate_limit_hits WHERE key = ${key}`);
  }

  /** 하루 지난 기록을 지운다 — 가장 긴 창이 60분이다. 주기 정리가 부른다 */
  async prune(): Promise<number> {
    const now = Date.now();
    for (const [key, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(key);
    const { rows } = (await this.db.execute(sql`
      DELETE FROM rate_limit_hits WHERE hit_at < now() - interval '1 day' RETURNING id
    `)) as unknown as { rows: unknown[] };
    return rows?.length ?? 0;
  }
}

function window(windowMs: number) {
  return sql.raw(`interval '${Math.max(1, Math.round(windowMs / 1000))} seconds'`);
}

/** 창 안에서 한도에 닿았으면 언제 풀리는지와 함께, 아니면 null */
async function over(
  db: Pick<BrickDb, "execute">,
  key: string,
  limit: number,
  w: ReturnType<typeof window>,
): Promise<RateLimitResult | null> {
  const { rows } = (await db.execute(sql`
    SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = ${key} AND hit_at > now() - ${w}
  `)) as unknown as { rows: Array<{ n: number }> };
  const n = Number(rows[0]?.n ?? 0);
  if (n < limit) return null;
  // 한도 안으로 돌아오려면 (n - limit + 1) 번째로 오래된 기록이 창을 벗어나야 한다
  const { rows: at } = (await db.execute(sql`
    SELECT ceil(extract(epoch FROM (hit_at + ${w} - now())))::int AS s FROM rate_limit_hits
    WHERE key = ${key} AND hit_at > now() - ${w}
    ORDER BY hit_at ASC OFFSET ${n - limit} LIMIT 1
  `)) as unknown as { rows: Array<{ s: number }> };
  return { allowed: false, retryAfterSeconds: Math.max(1, Number(at[0]?.s ?? 1)) };
}
