/**
 * 권한 등급 — 코어와 플러그인이 같은 표를 쓴다.
 *
 * 그누보드는 1~10 레벨을 쓰지만 Brick 의 역할 모델(admin/manager/member)에 맞춘다.
 * 숫자가 클수록 높은 권한이다.
 *
 * 왜 코어에 있는가: 권한 비교는 보안 원시(primitive)다. 베껴 두면 한쪽만 고쳐지고,
 * 그 어긋남이 곧 권한 구멍이 된다. 게시판이 들고 있던 정의를 여기로 옮겼다.
 */
export const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  manager: 2,
  admin: 3,
};

/** 권한 검사에 필요한 최소 형태 — 라우트와 블록 컨텍스트 양쪽을 받는다 */
export type RoleBearer = { role: string } | null | undefined;

/** 모르는 역할은 guest 로 본다 — 오타가 권한 상승이 되어서는 안 된다 */
export function rankOf(role: string | undefined | null): number {
  return ROLE_RANK[role ?? "guest"] ?? 0;
}

/** user 가 required 등급 이상인가 */
export function hasRole(user: RoleBearer, required: string): boolean {
  return rankOf(user?.role ?? "guest") >= rankOf(required);
}
