import { Injectable } from "@nestjs/common";

interface Bucket {
  hits: number[];
  /**
   * 이 버킷의 시간 창. 정리(sweep)는 **버킷마다 자기 창으로** 판단해야 한다 — 전에는
   * 지금 호출한 쪽의 창으로 모든 버킷을 판단해서, 15분 창을 쓰는 로그인이 60분 창인
   * "비밀번호 재설정 제출" 버킷을 15분 만에 지웠다(그 한도가 사실상 15분이 됐다).
   */
  windowMs: number;
}

/**
 * 로그인 브루트포스 방어.
 *
 * 인메모리 슬라이딩 윈도우 — 단일 프로세스(Brick의 배포 모델)에서는 충분하다.
 * 다중 인스턴스로 확장할 때는 CacheProvider 기반 구현으로 교체할 것.
 */
@Injectable()
export class RateLimitService {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  /**
   * @returns 남은 시도 횟수. 0이면 차단해야 한다.
   */
  consume(key: string, limit = 10, windowMs = 15 * 60_000): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep();
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { hits: [], windowMs };
    bucket.windowMs = Math.max(bucket.windowMs, windowMs);
    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

    if (bucket.hits.length >= limit) {
      const oldest = bucket.hits[0];
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (now - oldest)) / 1000) };
    }
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 로그인 성공 시 카운터 리셋 */
  /**
   * 세지 않고 막혔는지만 본다. **실패만 세는** 곳이 쓴다 — 비회원 비밀번호처럼 맞게 넣은
   * 사람의 반복 조회까지 세면 정당한 손님이 잠긴다.
   */
  check(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const hits = (this.buckets.get(key)?.hits ?? []).filter((t) => now - t < windowMs);
    if (hits.length < limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }

  /** 한 번 센다 (허용 여부와 무관하게) */
  hit(key: string, windowMs: number): void {
    this.sweep();
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { hits: [], windowMs };
    bucket.windowMs = Math.max(bucket.windowMs, windowMs);
    bucket.hits = bucket.hits.filter((t) => now - t < bucket.windowMs);
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
  }

  /** 가장 최근의 한 번을 되돌린다 — 먼저 세고 나중에 성공으로 판명된 시도에 쓴다 */
  undo(key: string): void {
    this.buckets.get(key)?.hits.pop();
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 만료된 버킷 정리 (메모리 누수 방지) */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((t) => now - t >= bucket.windowMs)) this.buckets.delete(key);
    }
  }
}
