import { Injectable } from "@nestjs/common";

interface Bucket {
  hits: number[];
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
    this.sweep(windowMs);
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { hits: [] };
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
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 만료된 버킷 정리 (메모리 누수 방지) */
  private sweep(windowMs: number): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((t) => now - t >= windowMs)) this.buckets.delete(key);
    }
  }
}
