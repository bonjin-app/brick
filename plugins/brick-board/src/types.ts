import type { PluginDb } from "@brick/plugin-sdk";

/** 재고·포인트처럼 원자성이 필요한 로직은 transaction()을 쓴다 */
export type Db = PluginDb;

/** 플러그인 라우트에서 HTTP 상태코드를 지정해 던지는 에러 */
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  role: string;
  displayName: string;
  /** 라우트 컨텍스트에는 있지만 블록 렌더 컨텍스트에는 없다 */
  email?: string;
}

/** 권한 검사에 필요한 최소 형태 — 라우트와 블록 컨텍스트 양쪽을 받는다 */
export type RoleBearer = { role: string } | null | undefined;

/**
 * 권한 등급.
 *
 * 그누보드는 1~10 레벨을 쓰지만 Brick의 역할 모델(admin/manager/member)에 맞춘다.
 * 숫자가 클수록 높은 권한이다.
 */
export const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  manager: 2,
  admin: 3,
};

export function rankOf(role: string | undefined | null): number {
  return ROLE_RANK[role ?? "guest"] ?? 0;
}

/** user가 required 등급 이상인가 */
export function hasRole(user: RoleBearer, required: string): boolean {
  return rankOf(user?.role ?? "guest") >= rankOf(required);
}

export interface BoardRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  read_role: string;
  write_role: string;
  comment_role: string;
  download_role: string;
  categories: string[];
  page_size: number;
  allow_reply: boolean;
  allow_secret: boolean;
  allow_vote: boolean;
  allow_upload: boolean;
  max_files: number;
  write_interval: number;
}

/** 업로드 허용 확장자 — 화이트리스트 (실행 가능한 형식은 절대 허용하지 않는다) */
export const ALLOWED_UPLOAD: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".pdf": ["application/pdf"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".txt": ["text/plain"],
  ".csv": ["text/csv", "application/vnd.ms-excel"],
  ".hwp": ["application/x-hwp", "application/haansofthwp", "application/octet-stream"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".mp4": ["video/mp4"],
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** 파일 크기를 사람이 읽는 형태로 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 상대 시간 (오늘은 시각, 그 외는 날짜) */
export function shortDate(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
