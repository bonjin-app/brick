/**
 * QueueProvider 추상화.
 * 기본 구현은 PostgreSQL SKIP LOCKED 기반 폴링 큐.
 * Redis(BullMQ)는 REDIS_URL이 설정된 경우에만 선택적으로 사용.
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
