import { createHash } from "node:crypto";
import type { BrickDb } from "@brick/database";
import type { LockProvider } from "@brick/core";

/** pg Pool 중 우리가 쓰는 부분만 — 드라이버 타입에 묶이지 않게 한다 */
interface PoolLike {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    release(err?: Error | boolean): void;
  }>;
}

/**
 * PostgreSQL advisory lock — **전용 연결 하나**에서 잡고 푼다.
 *
 * advisory lock 은 **세션(연결) 단위**다. 풀에 대고 `pg_try_advisory_lock` 과
 * `pg_advisory_unlock` 을 따로 보내면, 둘 사이에 다른 쿼리가 하나만 끼어도 해제가
 * 다른 연결로 간다 — 해제는 false 를 돌려주고 잠금은 원래 연결에 남는다. 실제로 재
 * 보니 그랬다(잠금 pid 23021, 해제 pid 23022, 해제 뒤에도 잠금 1건). 그 연결이
 * 풀에서 살아 있는 동안 아무도 그 잠금을 얻지 못한다.
 *
 * 그래서 풀에서 연결 하나를 빌려 잠금·해제를 거기서만 하고, fn 은 평소처럼 풀을
 * 쓴다. 프로세스가 죽거나 연결이 끊기면 PostgreSQL 이 세션과 함께 잠금을 푼다 —
 * 죽은 워커가 잠금을 쥔 채 남지 않는다.
 */
export class PostgresLockProvider implements LockProvider {
  constructor(private readonly db: BrickDb) {}

  async withLock<T>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T | null> {
    const id = lockId(key);
    const pool = (this.db as unknown as { $client: PoolLike }).$client;
    const client = await pool.connect();
    let held = false;
    try {
      const deadline = Date.now() + Math.max(0, opts?.waitMs ?? 0);
      for (;;) {
        const r = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [id]);
        if (r.rows[0]?.ok === true) { held = true; break; }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return await fn();
    } finally {
      if (held) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [id]).catch(() => undefined);
      }
      client.release();
    }
  }
}

/**
 * 문자열 키 → bigint. `hashtext()` 는 PostgreSQL 내부 함수라 버전 사이에 값이 바뀔 수
 * 있다 — 두 버전이 섞여 도는 롤링 배포에서 같은 키가 다른 잠금이 되면 안 된다.
 */
export function lockId(key: string): string {
  const hex = createHash("sha256").update(`brick:${key}`).digest("hex").slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}
