/**
 * LockProvider 추상화.
 * 구현은 PostgreSQL advisory lock (apps/api/src/providers/postgres-lock.provider.ts).
 * 잠금과 해제가 **같은 연결**에서 일어나야 한다 — 그 파일의 주석 참고.
 */
export interface LockProvider {
  /**
   * 락을 잡고 fn 을 실행한다. 이미 잡혀 있으면 waitMs 동안 기다리고(기본 0 — 즉시),
   * 그래도 못 잡으면 fn 을 부르지 않고 **null** 을 돌려준다. fn 이 null 을 돌려주는
   * 경우와 구별해야 하면 fn 이 객체를 돌려주게 하라.
   */
  withLock<T>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T | null>;
}
