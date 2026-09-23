/**
 * QueueProvider 추상화.
 * 구현은 PostgreSQL SKIP LOCKED 기반 폴링 큐 하나뿐이다. 이 인터페이스가 Redis 구현을
 * 끼울 자리지만 그 구현은 아직 없다 — `REDIS_URL` 을 설정해도 PostgreSQL 큐가 돈다.
 */
export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  payload: T;
  attempts: number;
}

export interface QueueProvider {
  enqueue<T>(name: string, payload: T, opts?: { delaySeconds?: number; maxAttempts?: number }): Promise<string>;
  /** 워커 등록. 반환된 함수를 호출하면 구독 해제 */
  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): () => void;
}
