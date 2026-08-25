/**
 * LockProvider 추상화.
 * 기본 구현은 PostgreSQL advisory lock. (마이그레이션 동시 실행 방지 등)
 */
export interface LockProvider {
  /** 락을 잡고 fn을 실행. 이미 잡혀 있으면 대기 또는 즉시 null 반환 */
  withLock<T>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T | null>;
}
