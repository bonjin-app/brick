/**
 * 점검 모드 — 손님을 잠시 들이지 않는다.
 *
 * **왜 필요했나.** 운영 문서가 복원 절차에서 "가능하면 점검 모드로 돌리거나
 * 한산한 시간에 하세요" 라고 안내하는데, **그런 기능이 없었다.** 운영자는
 * 관리 화면을 뒤지다 못 찾고, 결국 손님이 글을 쓰는 중에 복원을 한다 — 그 글은
 * 사라지고, 사라졌다는 사실은 아무도 모른다.
 *
 * 정한 것:
 *
 *  - **503 으로 답한다.** 200 에 "점검 중" 을 담으면 검색엔진이 그 문구를
 *    사이트의 내용으로 색인한다. 503 + `Retry-After` 는 "지금은 아니고 곧" 이라는
 *    뜻이고, 크롤러는 색인을 건드리지 않는다.
 *  - **운영자는 통과한다.** 점검 중에 고치러 들어가는 사람이 막히면 점검 모드가
 *    사이트를 잠그는 도구가 된다.
 *  - **쓰기를 막는다.** 화면만 가리면 열어 둔 탭에서 댓글이 계속 들어온다 —
 *    복원 중에 들어온 그 글이 정확히 사라지는 글이다.
 *  - **읽기는 막지 않는다**(플러그인 API 의 GET). 관리 화면이 그 API 로
 *    돌아가고, 점검 중에 운영자가 보는 것이 그 화면이다.
 */
export const MAINTENANCE_KEY = "site.maintenance";
export const MAINTENANCE_MESSAGE_KEY = "site.maintenance_message";

/** 크롤러에게 "얼마 뒤에 다시 오라" 고 말한다 (초) */
export const RETRY_AFTER_SECONDS = 1800;

/** 점검 중에도 통과하는 역할 — 고치러 들어가는 사람이다 */
export function bypassesMaintenance(role: unknown): boolean {
  const r = String(role ?? "");
  return r === "admin" || r === "manager";
}

/** 상태를 바꾸는 요청인가 (점검 중에 막을 것) */
export function isWrite(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method ?? "").toUpperCase());
}
