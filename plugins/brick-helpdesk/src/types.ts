import type { PluginDb } from "@brick/plugin-sdk";

export type Db = PluginDb;

/** 상태 코드를 HTTP 로 전달하기 위한 오류 */
export class HelpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const TICKET_STATUS = ["open", "answered", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUS)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "접수",
  answered: "답변완료",
  closed: "종료",
};

/** 기본 문의 분류 — 관리자가 설정으로 바꾼다 */
export const DEFAULT_CATEGORIES = ["일반", "주문·배송", "환불·교환", "계정", "기타"];

export interface HelpSettings {
  /** 비회원도 문의할 수 있는가 */
  allowGuest: boolean;
  /** 문의 분류 목록 */
  categories: string[];
  /** 답변이 등록되면 메일로 알린다 */
  notifyOnAnswer: boolean;
  pageSize: number;
}

export const DEFAULT_SETTINGS: HelpSettings = {
  allowGuest: false,
  categories: DEFAULT_CATEGORIES,
  notifyOnAnswer: true,
  pageSize: 20,
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function shortDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
