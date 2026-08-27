export interface Db {
  execute(query: unknown): Promise<{ rows: Array<Record<string, unknown>> }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export class SiteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SiteSettings {
  /** 방문자 집계 사용 */
  countVisits: boolean;
  /** 일별 합계를 보관하는 기간(일). 0이면 무기한 */
  keepDailyDays: number;
  /** 관리자 방문도 집계할지 — 기본은 세지 않는다(자기 사이트를 자기가 새로고침한다) */
  countAdmins: boolean;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  countVisits: true,
  keepDailyDays: 0,
  countAdmins: false,
};

export const POPUP_KIND_LABEL: Record<string, string> = {
  popup: "레이어 팝업",
  banner: "배너",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
