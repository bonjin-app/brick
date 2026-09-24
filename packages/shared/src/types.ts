/** Brick 전역 공통 타입 */

export type Id = string; // UUID v7

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type UserRole = "admin" | "manager" | "member" | "guest";

export interface SessionUser {
  /** 프로필 이미지 URL (없으면 null) — 헤더·마이페이지가 그린다 */
  avatarUrl?: string | null;
  id: Id;
  email: string;
  displayName: string;
  role: UserRole;
  /**
   * 운영자(manager)의 관리 화면 범위 — null 이면 전부. 관리자에게는 뜻이 없다(늘 전부).
   * 플러그인 관리 경로의 디스패처가 이것으로 막는다.
   */
  scopes?: string[] | null;
}

/** 설치 상태 — 설치 마법사가 완료되기 전에는 모든 라우트가 /install로 리다이렉트된다 */
export type InstallState = "not_installed" | "installing" | "installed";
