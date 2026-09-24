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
  /** 이 작업의 시도 한도 — attempts 가 여기 닿은 실패가 마지막이다 */
  maxAttempts: number;
}

export interface EnqueueOptions {
  delaySeconds?: number;
  maxAttempts?: number;
  /**
   * 같은 키로 **대기 중인** 작업은 하나만 둔다. 이미 있으면 새로 넣지 않고 그 작업의
   * id 를 돌려준다.
   *
   * 스스로 다음 차례를 예약하는 주기 작업에 쓴다. 플러그인은 부팅할 때마다 사슬의 첫
   * 작업을 다시 심는데, 이것이 없으면 재시작한 횟수만큼 사슬이 겹쳐 같은 일을 되풀이한다
   * (개발 DB 에 넷이 겹쳐 있었다). 실행 중인 작업은 세지 않는다 — 실행 중인 작업이
   * 끝에서 자기 다음 차례를 예약할 수 있어야 사슬이 이어진다.
   */
  dedupeKey?: string;
}

export interface ProcessOptions<T = unknown> {
  /**
   * 작업이 **끝내** 실패했을 때 — 시도를 다 쓴 예외, 또는 마지막 시도 중에 워커가 죽어
   * 임대가 끊긴 경우. 뒤의 것은 핸들러 안의 try/catch 로는 알 수 없으므로 여기서 받는다.
   *
   * 작업이 무언가를 "진행 중" 으로 표시해 두는 기능(메일 캠페인의 '발송중')은 이것으로
   * 그 표시를 풀어야 한다. 풀지 않으면 운영자는 멈춘 작업을 다시 시작할 수 없다.
   */
  onFailed?: (job: QueueJob<T>, error: string) => Promise<void>;
}

/** 이름별 최근 실패 요약 — 운영자에게 보여 줄 것 */
export interface QueueFailure {
  name: string;
  count: number;
  lastError: string | null;
  lastAt: Date | null;
}

export interface QueueProvider {
  enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string>;
  /** 워커 등록. 반환된 함수를 호출하면 구독 해제 */
  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>, opts?: ProcessOptions<T>): () => void;
  /**
   * 끝난 작업 기록을 보관 기간에 맞춰 지운다. 지운 행 수를 돌려준다.
   * 필수다 — 큐 구현은 무엇을 쌓는지와 함께 **어떻게 치우는지**도 말해야 한다.
   */
  prune(): Promise<number>;
  /** 최근 끝내 실패한 작업을 이름별로 — 대시보드가 운영자에게 보여 준다 */
  recentFailures(days?: number): Promise<QueueFailure[]>;
}
