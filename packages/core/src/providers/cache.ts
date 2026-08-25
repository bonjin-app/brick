/**
 * CacheProvider 추상화.
 * Redis가 없으면 PostgresCacheProvider(UNLOGGED TABLE 기반)가 기본으로 쓰인다.
 * → Brick Core는 PostgreSQL만으로 완전히 동작해야 한다.
 */
export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string | string[]): Promise<void>;
  /** 태그 기반 무효화: 게시글 수정 → ["board:1"] 태그 전체 퍼지 */
  setWithTags<T>(key: string, value: T, tags: string[], ttlSeconds?: number): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
}
